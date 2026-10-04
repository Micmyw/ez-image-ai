import type {
	ProviderResult,
	ReviewStepResult,
	StoredOutputRef,
	SubmissionStepResult,
	VideoPublicState,
	VideoStage,
	VideoWorkflowParams,
} from "@repo/jobs/video-v1/contracts";

type WaitPhase = "input" | "provider" | "output";
export interface VideoDurableSteps {
	do<T>(
		name: string,
		config: { retries: { limit: number; delay: string; backoff: "exponential" }; timeout: string },
		action: () => Promise<T>,
	): Promise<T>;
	waitForEvent(
		this: void,
		name: string,
		options: { type: "provider-result" | "moderation-result"; timeout: string },
	): Promise<unknown>;
	sleep(this: void, name: string, duration: string): Promise<void>;
}
export interface VideoWorkflowServices {
	checkpoint(this: void, jobId: string): Promise<{ stage: VideoStage; terminal: boolean }>;
	window(
		this: void,
		jobId: string,
		phase: WaitPhase,
		round?: number,
	): Promise<{ round: number; remainingSeconds: number; deadlineAt?: string }>;
	reviewInput(this: void, jobId: string): Promise<ReviewStepResult>;
	submit(this: void, jobId: string): Promise<SubmissionStepResult>;
	confirm(this: void, jobId: string): Promise<ProviderResult>;
	store(this: void, jobId: string): Promise<StoredOutputRef>;
	reviewOutput(this: void, jobId: string): Promise<ReviewStepResult>;
	finalize(this: void, jobId: string): Promise<VideoPublicState>;
	fail(this: void, jobId: string, code: string, rejected: boolean): Promise<unknown>;
	needsReview(this: void, jobId: string, code: string): Promise<unknown>;
	providerPollSeconds: number;
	moderationPollSeconds: number;
}

// Paid submission has its own persisted attempt fence; all step retries resume
// that fence. Transfer and moderation retries never invoke submission again.
const STANDARD = {
	retries: { limit: 3, delay: "5 seconds", backoff: "exponential" as const },
	timeout: "5 minutes",
};
const SINGLE_ATTEMPT = { ...STANDARD, retries: { ...STANDARD.retries, limit: 0 } };

export function isVideoEventTimeout(error: unknown, timeoutMs?: number): boolean {
	if (!error || typeof error !== "object" || !("name" in error)) return false;
	if (error.name === "WorkflowTimeoutError") return true;
	// The pinned workerd RPC bridge currently serializes WorkflowTimeoutError
	// as Error. Match the exact platform message AND this wait's own duration;
	// never treat arbitrary errors containing "timeout" as recoverable events.
	return (
		error.name === "Error" &&
		"message" in error &&
		timeoutMs !== undefined &&
		error.message === `Execution timed out after ${timeoutMs}ms`
	);
}

/** Direct versioned stages. Never dispatches a JobsWorkflow, Outbox or DO task. */
export async function runVideoGenerationV1(
	params: VideoWorkflowParams,
	steps: VideoDurableSteps,
	services: VideoWorkflowServices,
) {
	if (params.schemaVersion !== 1 || !params.jobId) throw new Error("INVALID_VIDEO_WORKFLOW_PARAMS");
	const jobId = params.jobId;
	const checkpoint = await steps.do("video-v1-start", STANDARD, () => services.checkpoint(jobId));
	if (checkpoint.terminal) return { completed: true, stage: checkpoint.stage };
	const step = <T>(name: string, action: () => Promise<T>) =>
		steps.do(`video-v1-${name}`, STANDARD, action);
	const reviewRequired = async (code: string) => {
		await step(`needs-review-${code.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`, () =>
			services.needsReview(jobId, code),
		);
		return { completed: false, stage: "NEEDS_REVIEW" as const };
	};
	const fail = async (phase: string, code: string, rejected = false) => {
		await step(`${phase}-failed`, () => services.fail(jobId, code, rejected));
		return { completed: true, stage: rejected ? ("REJECTED" as const) : ("FAILED" as const) };
	};
	async function wait(
		phase: WaitPhase,
		round: number,
		remaining: number,
		seconds?: number,
		callbackOnly = false,
		deadlineMillis?: number,
	): Promise<"event" | "timeout"> {
		const configured =
			phase === "provider" ? services.providerPollSeconds : services.moderationPollSeconds;
		const timeout = callbackOnly
			? Math.max(
					1,
					Math.min(
						remaining,
						deadlineMillis === undefined
							? remaining
							: Math.ceil((deadlineMillis - Date.now()) / 1000),
					),
				)
			: Math.max(1, Math.min(remaining, Math.max(configured, seconds ?? configured)));
		try {
			await steps.waitForEvent(`video-v1-${phase}-event-${round}`, {
				type: phase === "provider" ? "provider-result" : "moderation-result",
				timeout: `${timeout} seconds`,
			});
			return "event";
		} catch (error) {
			// A cached wait error may retain its original timeout duration after
			// replay. An independently expired callback deadline always parks;
			// it never authorizes another confirmation request.
			if (callbackOnly && deadlineMillis !== undefined && Date.now() >= deadlineMillis)
				return "timeout";
			// A malformed event type or broken runtime must fail. Only the actual
			// durable timeout lets the caller choose deadline handling or reconciliation.
			if (!isVideoEventTimeout(error, timeout * 1000)) throw error;
			return "timeout";
		}
	}
	async function review(phase: "input" | "output"): Promise<ReviewStepResult> {
		const initial = await step(`${phase}-window`, () => services.window(jobId, phase));
		let callbackOnly = false;
		let deadlineMillis: number | undefined;
		const bindDeadline = (value?: string) => {
			if (value === undefined) return;
			const parsed = Date.parse(value);
			const next = Number.isFinite(parsed) ? parsed : 0;
			deadlineMillis = deadlineMillis === undefined ? next : Math.min(deadlineMillis, next);
		};
		bindDeadline(initial.deadlineAt);
		const callbackDeadline = (): ReviewStepResult => ({
			status: "ERROR",
			reasonCode: `${phase.toUpperCase()}_REVIEW_CALLBACK_DEADLINE`,
			retryable: false,
		});
		for (let round = initial.round; ; round++) {
			// First invocation immediately consumes synchronous terminal results.
			let result: ReviewStepResult;
			try {
				result = await steps.do(
					`video-v1-review-${phase}-${round}`,
					callbackOnly ? SINGLE_ATTEMPT : STANDARD,
					() => (phase === "input" ? services.reviewInput(jobId) : services.reviewOutput(jobId)),
				);
			} catch (error) {
				if (!callbackOnly) throw error;
				return {
					status: "ERROR",
					reasonCode: `${phase.toUpperCase()}_REVIEW_CALLBACK_CONFIRMATION_FAILED`,
					retryable: false,
				};
			}
			if (
				result.status === "PENDING" &&
				(result.waitFor === "callback" || result.waitFor === "confirmation-retry")
			) {
				callbackOnly = true;
				bindDeadline(result.deadlineAt);
			}
			if (
				result.status !== "PENDING" &&
				!(result.status === "ERROR" && result.retryable && !callbackOnly)
			)
				return result;
			const window = await step(`${phase}-window-${round}`, () =>
				services.window(jobId, phase, round + 1),
			);
			if (callbackOnly) {
				bindDeadline(window.deadlineAt);
				// Record deadline branches as durable steps so replay after an
				// already successful review does not change its completed path.
				const canWait = await step(
					`${phase}-callback-wait-window-${round}`,
					async () => deadlineMillis === undefined || Date.now() < deadlineMillis,
				);
				if (!canWait) return callbackDeadline();
			}
			if (window.remainingSeconds <= 0)
				return {
					status: "ERROR",
					reasonCode: `${phase.toUpperCase()}_REVIEW_${callbackOnly ? "CALLBACK_" : ""}DEADLINE`,
					retryable: false,
				};
			if (result.status === "PENDING" && result.waitFor === "confirmation-retry") {
				// Only the database's claimed transient GET failure enters this path.
				// A durable sleep cannot be bypassed by duplicate callback events; the
				// next review rechecks the persisted read budget and nextRetryAt.
				const retryAt =
					result.nextRetryAt === undefined ? undefined : Date.parse(result.nextRetryAt);
				if (retryAt !== undefined && !Number.isFinite(retryAt))
					return {
						status: "ERROR",
						reasonCode: `${phase.toUpperCase()}_REVIEW_CALLBACK_CONFIRMATION_FAILED`,
						retryable: false,
					};
				const retrySeconds =
					retryAt !== undefined
						? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))
						: Number.isFinite(result.retryAfterSeconds)
							? Math.max(1, Math.min(3, result.retryAfterSeconds!))
							: 1;
				const remaining =
					deadlineMillis === undefined
						? window.remainingSeconds
						: Math.min(window.remainingSeconds, Math.ceil((deadlineMillis - Date.now()) / 1000));
				if (retrySeconds > 0)
					await steps.sleep(
						`video-v1-${phase}-confirmation-retry-${round}`,
						`${Math.max(1, Math.min(remaining, retrySeconds))} seconds`,
					);
			} else {
				const waited = await wait(
					phase,
					round,
					window.remainingSeconds,
					result.status === "PENDING" ? result.retryAfterSeconds : undefined,
					callbackOnly,
					deadlineMillis,
				);
				if (callbackOnly && waited === "timeout") return callbackDeadline();
			}
			if (callbackOnly) {
				const canConfirm = await step(
					`${phase}-callback-wake-window-${round}`,
					async () => deadlineMillis === undefined || Date.now() < deadlineMillis,
				);
				if (!canConfirm) return callbackDeadline();
			}
		}
	}

	if (["QUEUED", "INPUT_REVIEW"].includes(checkpoint.stage)) {
		const result = await review("input");
		if (result.status === "REJECT") return fail("input", result.reasonCode, true);
		if (result.status === "ERROR") return reviewRequired(result.reasonCode);
	}
	if (["QUEUED", "INPUT_REVIEW", "SUBMITTING"].includes(checkpoint.stage)) {
		const result = await steps.do("video-v1-submit-provider", SINGLE_ATTEMPT, () =>
			services.submit(jobId),
		);
		if (result.status === "DEFINITELY_REJECTED") return fail("submission", result.reasonCode);
		// An uncertain response proceeds only to reconciliation of the original
		// attempt. An early authenticated callback may already have bound its ID.
	}
	if (!["STORING", "OUTPUT_REVIEW", "FINALIZING"].includes(checkpoint.stage)) {
		const initial = await step("provider-window", () => services.window(jobId, "provider"));
		for (let round = initial.round; ; round++) {
			const result = await step(`confirm-provider-${round}`, () => services.confirm(jobId));
			if (result.status === "SUCCEEDED") break;
			if (result.status === "FAILED") return fail("provider", result.reasonCode);
			const window = await step(`provider-window-${round}`, () =>
				services.window(jobId, "provider", round + 1),
			);
			if (window.remainingSeconds <= 0) return reviewRequired("PROVIDER_DEADLINE");
			await wait("provider", round, window.remainingSeconds, result.retryAfterSeconds);
		}
	}
	if (checkpoint.stage !== "FINALIZING") {
		await step("store-output", () => services.store(jobId));
		const result = await review("output");
		if (result.status === "REJECT") return fail("output", result.reasonCode, true);
		if (result.status === "ERROR") return reviewRequired(result.reasonCode);
	}
	const result = await step("finalize", () => services.finalize(jobId));
	return { completed: true, stage: result.stage };
}
