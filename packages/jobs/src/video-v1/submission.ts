import type { MediaSafetyAdapter, ModerationDecision } from "@repo/ai/media/moderation/types";
import { createConfiguredVideoSafetyAdapter } from "@repo/ai/media/moderation/video-configured";
import {
	buildKieSeedanceReferenceRequest,
	KieSeedanceReferenceAdapter,
	type KieSeedanceReferenceInput,
} from "@repo/ai/media/providers/kie-seedance-reference";
import {
	buildKieVideoModelRequest,
	KieVideoModelsAdapter,
	resolveKieVideoModelId,
	type KieVideoModelInput,
} from "@repo/ai/media/providers/kie-video-models";
import {
	buildKieVideoV1Request,
	KieVideoV1Adapter,
	type KieVideoV1Input,
	type KieVideoV1Result,
	type KieVideoV1Submission,
} from "@repo/ai/media/providers/kie-video-v1";
import {
	isApprovedVideoTextDecision,
	readVideoTextSafetyProfile,
	videoTextSafetyProfilesMatch,
} from "@repo/config/video-text-safety";
import {
	readVideoV1Config,
	resolveVideoV1CallbackBaseUrl,
	VIDEO_V1_RULE_VERSION,
} from "@repo/config/video-v1";
import { getVideoEffectiveInputSnapshot } from "@repo/database/video-template-execution";
import * as database from "@repo/database/video-v1-execution";
import { createSignedReadUrl } from "@repo/storage";

import type {
	ProviderResult,
	ReviewStepResult,
	SubmissionStepResult,
	VideoInputSnapshot,
} from "./contracts";
import { requireVideoTemplateRuntimeEnabled } from "./template-runtime-gates";
import { moderateVideoText } from "./text-moderation";

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
type Store = Pick<
	typeof database,
	| "getVideoExecutionContext"
	| "assertVideoInputIdentity"
	| "recordVideoInputReview"
	| "claimVideoImageReview"
	| "claimVideoProviderSubmission"
	| "recordVideoSubmissionAccepted"
	| "markVideoSubmissionUncertain"
	| "failVideoExecution"
	| "recordVideoProviderSuccess"
	| "recordVideoProviderAccounting"
	| "consumeVideoProviderEvents"
>;
export interface VideoSubmissionDependencies {
	store: Store;
	safety: MediaSafetyAdapter;
	moderateText: MediaSafetyAdapter["moderateText"];
	provider: {
		submit(
			input: KieVideoV1Input | KieVideoModelInput | KieSeedanceReferenceInput,
		): Promise<KieVideoV1Submission>;
		retrieve(taskId: string, productKey?: string): Promise<KieVideoV1Result>;
	};
	signRead: (objectKey: string) => Promise<string>;
	env: Record<string, string | undefined>;
	now: () => Date;
}

function dependencies(
	overrides?: Partial<VideoSubmissionDependencies>,
): VideoSubmissionDependencies {
	const env = overrides?.env ?? process.env;
	const legacyProvider = new KieVideoV1Adapter({ apiKey: env.KIE_API_KEY ?? "" });
	const modelProvider = new KieVideoModelsAdapter({ apiKey: env.KIE_API_KEY ?? "" });
	const referenceProvider = new KieSeedanceReferenceAdapter({ apiKey: env.KIE_API_KEY ?? "" });
	return {
		store: database,
		safety: createConfiguredVideoSafetyAdapter(env),
		moderateText: (input) => moderateVideoText(input, env),
		provider: {
			submit: (input) =>
				"referenceVideoUrls" in input
					? referenceProvider.submit(input)
					: "productKey" in input
						? modelProvider.submit(input)
						: legacyProvider.submit(input),
			retrieve: (taskId, productKey) =>
				productKey ? modelProvider.retrieve(taskId, productKey) : legacyProvider.retrieve(taskId),
		},
		signRead: (objectKey) =>
			createSignedReadUrl({ bucket: "media", key: objectKey, expiresIn: 3600 }),
		env,
		now: () => new Date(),
		...overrides,
	};
}

/** Rebuild only server-owned, persisted input; transient signed URLs never enter its fingerprint. */
function prepareVideoProviderRequest(
	snapshot: VideoInputSnapshot,
	callbackUrl: string,
	imageUrl?: string,
	motionUrl?: string,
) {
	if (snapshot.mode === "image-to-video" && !snapshot.inputIdentity)
		throw new Error("VIDEO_INPUT_IDENTITY_MISSING");
	const common = {
		prompt: snapshot.prompt,
		duration: snapshot.duration,
		sound: snapshot.sound,
		callbackUrl,
	};
	const template = snapshot.videoEffectTemplate;
	if (template?.schemaVersion === 2 && template.executionKind === "seedance-reference") {
		if (!imageUrl || !motionUrl || template.video.productKey !== "video-seedance-2")
			throw new Error("VIDEO_REFERENCE_INPUT_IDENTITY_MISSING");
		const input: KieSeedanceReferenceInput = {
			...common,
			productKey: "video-seedance-2",
			duration: 5,
			resolution: "720p",
			aspectRatio: "9:16",
			sound: false,
			referenceImageUrls: [imageUrl],
			referenceVideoUrls: [motionUrl],
		};
		const request = buildKieSeedanceReferenceRequest(input);
		return { input, providerModelId: request.model, productKey: input.productKey };
	}
	if ("productKey" in snapshot) {
		const input: KieVideoModelInput = {
			...common,
			productKey: snapshot.productKey,
			mode: snapshot.mode,
			resolution: snapshot.resolution,
			aspectRatio: snapshot.aspectRatio,
			...(snapshot.inputAssetId !== undefined ? { inputAssetId: snapshot.inputAssetId } : {}),
			...(snapshot.mode === "image-to-video" ? { imageUrl } : {}),
			...(snapshot.videoEffectTemplate?.video.fixedLens
				? { templateFixedLens: true as const }
				: {}),
		};
		if (
			snapshot.mode === "image-to-video" &&
			snapshot.inputIdentity?.assetId !== snapshot.inputAssetId
		)
			throw new Error("VIDEO_INPUT_IDENTITY_CHANGED");
		const request = buildKieVideoModelRequest(input);
		return { input, providerModelId: request.model, productKey: snapshot.productKey };
	}
	const input: KieVideoV1Input =
		snapshot.mode === "text-to-video"
			? {
					...common,
					duration: snapshot.duration,
					sound: snapshot.sound,
					mode: "text-to-video",
					aspectRatio: snapshot.aspectRatio,
				}
			: {
					...common,
					duration: snapshot.duration,
					sound: snapshot.sound,
					mode: "image-to-video",
					imageUrl: imageUrl!,
				};
	const request = buildKieVideoV1Request(input);
	return { input, providerModelId: request.model, productKey: undefined };
}

export async function hashVideoCallbackToken(token: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readDecision(value: unknown): ModerationDecision | null {
	const entry = object(value);
	return ["ALLOW", "REJECT", "REVIEW", "ERROR"].includes(String(entry.decision))
		? (entry as unknown as ModerationDecision)
		: null;
}

export async function reviewVideoInput(
	jobId: string,
	overrides?: Partial<VideoSubmissionDependencies>,
): Promise<ReviewStepResult> {
	const deps = dependencies(overrides);
	const job = await deps.store.getVideoExecutionContext(jobId);
	if (!job?.videoExecution) throw new Error("VIDEO_JOB_NOT_FOUND");
	if (job.videoExecution.stage === "NEEDS_REVIEW")
		return { status: "ERROR", reasonCode: "VIDEO_OPERATOR_REVIEW_REQUIRED", retryable: false };
	if (job.attempts.length) return { status: "ALLOW" }; // Already submitted only after durable approval.
	if (["FAILED", "REJECTED"].includes(job.videoExecution.stage))
		return { status: "REJECT", reasonCode: job.failureCode ?? "VIDEO_INPUT_REJECTED" };
	try {
		deps.store.assertVideoInputIdentity(job);
	} catch {
		await deps.store.failVideoExecution(jobId, "VIDEO_INPUT_IDENTITY_CHANGED", true);
		return { status: "REJECT", reasonCode: "VIDEO_INPUT_IDENTITY_CHANGED" };
	}
	const snapshot = (object(job.inputSnapshot).videoEffectTemplate
		? getVideoEffectiveInputSnapshot(job)
		: job.inputSnapshot) as unknown as VideoInputSnapshot;
	let textSafetyProfile;
	try {
		textSafetyProfile = readVideoTextSafetyProfile(snapshot);
	} catch {
		return { status: "ERROR", reasonCode: "VIDEO_TEXT_SAFETY_PROFILE_INVALID", retryable: false };
	}
	const review = object(object(job.videoExecution.stageData).inputReview);
	const matchesTextProfile =
		videoTextSafetyProfilesMatch(review.textSafetyProfile, textSafetyProfile) &&
		review.requestFingerprint === snapshot.requestFingerprint;
	const reviewUnexpired =
		typeof review.validUntil === "string" && new Date(review.validUntil) > deps.now();
	if (
		review.status === "ALLOW" &&
		review.ruleVersion === VIDEO_V1_RULE_VERSION &&
		matchesTextProfile &&
		isApprovedVideoTextDecision(review.textDecision, textSafetyProfile) &&
		review.requestFingerprint === snapshot.requestFingerprint &&
		reviewUnexpired
	)
		return { status: "ALLOW" };
	const startedAt = job.videoExecution.inputReviewStartedAt ?? deps.now();
	const config = readVideoV1Config(deps.env);
	const deadlineAt = new Date(
		startedAt.getTime() + config.moderationDeadlineSeconds * 1000,
	).toISOString();
	await deps.store.recordVideoInputReview(jobId, {
		ruleVersion: VIDEO_V1_RULE_VERSION,
		requestFingerprint: snapshot.requestFingerprint,
		textSafetyProfile,
	});
	let text =
		matchesTextProfile && (review.status !== "ALLOW" || reviewUnexpired)
			? readDecision(review.textDecision)
			: null;
	if (text?.ruleVersion !== textSafetyProfile.ruleVersion) text = null;
	if (!text || text.decision === "ERROR") {
		text = await deps.moderateText({
			text: snapshot.prompt,
			ruleVersion: textSafetyProfile.ruleVersion,
		});
		await deps.store.recordVideoInputReview(jobId, { textDecision: text });
	}
	if (text.decision === "REJECT" || text.decision === "REVIEW") {
		await deps.store.failVideoExecution(jobId, text.reasonCode, true);
		return { status: "REJECT", reasonCode: text.reasonCode };
	}
	if (text.decision !== "ALLOW")
		return { status: "ERROR", reasonCode: text.reasonCode, retryable: false };
	if (!isApprovedVideoTextDecision(text, textSafetyProfile))
		return { status: "ERROR", reasonCode: "VIDEO_TEXT_REVIEW_INVALID", retryable: false };
	if (snapshot.mode === "image-to-video") {
		const identity = snapshot.inputIdentity;
		if (!identity) throw new Error("VIDEO_INPUT_IDENTITY_MISSING");
		let image = readDecision(review.imageDecision);
		if (
			!image ||
			image.decision === "ERROR" ||
			(image.decision === "REVIEW" && image.reasonCode === "IMAGE_PROCESSING")
		) {
			image = null;
			const assetUrl = await deps.signRead(identity.objectKey);
			if (deps.safety.submitImage && deps.safety.retrieveImage) {
				let taskId = typeof review.imageTaskId === "string" ? review.imageTaskId : null;
				if (!taskId) {
					if (review.imageSubmissionUncertain || !(await deps.store.claimVideoImageReview(jobId))) {
						return {
							status: "ERROR",
							reasonCode: "VIDEO_IMAGE_REVIEW_SUBMISSION_UNCERTAIN",
							retryable: false,
						};
					}
					let submission;
					try {
						submission = await deps.safety.submitImage({
							assetUrl,
							ruleVersion: VIDEO_V1_RULE_VERSION,
							idempotencyKey: `video-input:${jobId}:${identity.checksum}`,
						});
					} catch {
						return {
							status: "ERROR",
							reasonCode: "VIDEO_IMAGE_REVIEW_SUBMISSION_UNCERTAIN",
							retryable: false,
						};
					}
					taskId = submission.moderationTaskId;
					await deps.store.recordVideoInputReview(jobId, {
						imageTaskId: taskId,
						imageSubmissionUncertain: false,
					});
					image = submission.completedDecision ?? null;
				}
				// A synchronous terminal is consumed now; otherwise query once immediately.
				image ??= await deps.safety.retrieveImage({
					assetUrl,
					moderationTaskId: taskId,
					ruleVersion: VIDEO_V1_RULE_VERSION,
				});
			} else
				image = await deps.safety.moderateImage({ assetUrl, ruleVersion: VIDEO_V1_RULE_VERSION });
			await deps.store.recordVideoInputReview(jobId, { imageDecision: image });
		}
		if (image.decision === "REVIEW" && image.reasonCode === "IMAGE_PROCESSING") {
			return { status: "PENDING", retryAfterSeconds: config.moderationPollSeconds, deadlineAt };
		}
		if (image.decision === "REJECT" || image.decision === "REVIEW") {
			await deps.store.failVideoExecution(jobId, image.reasonCode, true);
			return { status: "REJECT", reasonCode: image.reasonCode };
		}
		if (image.decision !== "ALLOW")
			return { status: "ERROR", reasonCode: image.reasonCode, retryable: false };
	}
	await deps.store.recordVideoInputReview(jobId, {
		status: "ALLOW",
		ruleVersion: VIDEO_V1_RULE_VERSION,
		requestFingerprint: snapshot.requestFingerprint,
		textSafetyProfile,
		validUntil: new Date(deps.now().getTime() + 3600_000).toISOString(),
	});
	return { status: "ALLOW" };
}

export async function submitVideoAttempt(
	jobId: string,
	overrides?: Partial<VideoSubmissionDependencies>,
): Promise<SubmissionStepResult> {
	const deps = dependencies(overrides);
	const job = await deps.store.getVideoExecutionContext(jobId);
	if (!job?.videoExecution) throw new Error("VIDEO_JOB_NOT_FOUND");
	const existing = job.attempts[0];
	if (existing) return replaySubmission(existing);
	const snapshot = (object(job.inputSnapshot).videoEffectTemplate
		? getVideoEffectiveInputSnapshot(job)
		: job.inputSnapshot) as unknown as VideoInputSnapshot;
	readVideoTextSafetyProfile(snapshot);
	// Finish all deterministic preparation before creating the irrevocable send fence.
	const callbackBase = resolveVideoV1CallbackBaseUrl(deps.env);
	if (!callbackBase || !deps.env.KIE_WEBHOOK_SECRET)
		throw new Error("VIDEO_CALLBACK_CONFIGURATION_INVALID");
	const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const callbackUrl = new URL(`/api/webhooks/video/kie/${token}`, callbackBase).href;
	const imageUrl =
		snapshot.mode === "image-to-video" && snapshot.inputIdentity
			? await deps.signRead(snapshot.inputIdentity.objectKey)
			: undefined;
	const reference =
		snapshot.videoEffectTemplate?.schemaVersion === 2 &&
		snapshot.videoEffectTemplate.executionKind === "seedance-reference"
			? snapshot.videoEffectTemplate.approvedMotionReference
			: undefined;
	// Only the immutable backend-approved private key is signed. No user or callback URL is accepted.
	const motionUrl = reference ? await deps.signRead(reference.objectKey) : undefined;
	const prepared = prepareVideoProviderRequest(snapshot, callbackUrl, imageUrl, motionUrl);
	if (snapshot.videoEffectTemplate)
		await requireVideoTemplateRuntimeEnabled(snapshot.videoEffectTemplate, deps.env);
	let claim: Awaited<ReturnType<Store["claimVideoProviderSubmission"]>>;
	try {
		claim = await deps.store.claimVideoProviderSubmission({
			jobId,
			callbackTokenHash: await hashVideoCallbackToken(token),
			providerModelId: prepared.providerModelId,
			ruleVersion: VIDEO_V1_RULE_VERSION,
		});
	} catch (error) {
		const reasonCode = error instanceof Error ? error.message : "";
		if (
			!["VIDEO_PRICE_INVALID", "VIDEO_PRICE_EXPIRED", "VIDEO_FUNDING_POLICY_CHANGED"].includes(
				reasonCode,
			)
		)
			throw error;
		// This rejected claim did not obtain permission to send. A competing caller
		// might have crossed the fence already, so release only under a no-attempt
		// guard in the same locked transaction that terminalizes the job.
		const failed = await deps.store.failVideoExecution(jobId, reasonCode, false, false, {
			onlyBeforeSubmission: true,
		});
		if (failed) return { status: "DEFINITELY_REJECTED", reasonCode };
		const latest = await deps.store.getVideoExecutionContext(jobId);
		if (latest?.attempts[0]) return replaySubmission(latest.attempts[0]);
		if (latest?.status === "FAILED")
			return { status: "DEFINITELY_REJECTED", reasonCode: latest.failureCode ?? reasonCode };
		throw error;
	}
	if (!claim.claimed) return replaySubmission(claim.attempt);
	const attemptId = claim.attempt.id;
	try {
		const result = await deps.provider.submit(prepared.input);
		if (result.status === "ACCEPTED") {
			await deps.store.recordVideoSubmissionAccepted(jobId, attemptId, result.providerTaskId);
			return { status: "ACCEPTED", attemptId, providerTaskId: result.providerTaskId };
		}
		if (result.status === "DEFINITELY_REJECTED") {
			const failed = await deps.store.failVideoExecution(jobId, result.reasonCode, false, true);
			if (failed) return { ...result, attemptId };
			// An early signed callback can already have proven acceptance; never refund it here.
			const latest = await deps.store.getVideoExecutionContext(jobId);
			if (latest?.attempts[0]) return replaySubmission(latest.attempts[0]);
		}
		await deps.store.markVideoSubmissionUncertain(jobId, result.reasonCode);
		return { status: "UNCERTAIN", attemptId, reasonCode: result.reasonCode };
	} catch {
		// Even failure to persist taskId after acceptance is uncertain, never permission to resend.
		try {
			await deps.store.markVideoSubmissionUncertain(jobId, "VIDEO_SUBMISSION_UNCONFIRMED");
		} catch {
			/* The pre-send fence remains durable. */
		}
		return { status: "UNCERTAIN", attemptId, reasonCode: "VIDEO_SUBMISSION_UNCONFIRMED" };
	}
}

function replaySubmission(attempt: {
	id: string;
	providerTaskId: string | null;
	status: string;
}): SubmissionStepResult {
	if (attempt.providerTaskId)
		return { status: "ACCEPTED", attemptId: attempt.id, providerTaskId: attempt.providerTaskId };
	if (attempt.status === "FAILED")
		return {
			status: "DEFINITELY_REJECTED",
			attemptId: attempt.id,
			reasonCode: "VIDEO_SUBMISSION_REJECTED",
		};
	return { status: "UNCERTAIN", attemptId: attempt.id, reasonCode: "VIDEO_SUBMISSION_UNCONFIRMED" };
}

export async function confirmVideoProviderResult(
	jobId: string,
	overrides?: Partial<VideoSubmissionDependencies>,
): Promise<ProviderResult> {
	const deps = dependencies(overrides);
	const job = await deps.store.getVideoExecutionContext(jobId);
	if (!job?.videoExecution) throw new Error("VIDEO_JOB_NOT_FOUND");
	const attempt = job.attempts[0];
	if (attempt?.status === "SUCCEEDED") return { status: "SUCCEEDED", attemptId: attempt.id };
	if (["FAILED", "REJECTED"].includes(job.videoExecution.stage))
		return { status: "FAILED", reasonCode: job.failureCode ?? "VIDEO_GENERATION_FAILED" };
	const config = readVideoV1Config(deps.env);
	const deadlineAt = new Date(
		(job.videoExecution.providerSubmitStartedAt ?? job.createdAt).getTime() +
			config.providerDeadlineSeconds * 1000,
	).toISOString();
	if (!attempt?.providerTaskId)
		return { status: "PENDING", retryAfterSeconds: config.providerPollSeconds, deadlineAt };
	const snapshot = job.inputSnapshot as unknown as VideoInputSnapshot;
	// Query routing comes from the immutable request and persisted attempt,
	// never from callback/client fields or an unsigned result URL.
	const productKey = "productKey" in snapshot ? snapshot.productKey : undefined;
	const providerModelId = resolveKieVideoModelId(productKey ?? "video-kling-2-6-v1", snapshot.mode);
	if (attempt.providerModelId !== providerModelId)
		throw new Error("VIDEO_PROVIDER_MODEL_IDENTITY_MISMATCH");
	const queriedAt = deps.now();
	const result = productKey
		? await deps.provider.retrieve(attempt.providerTaskId, productKey)
		: await deps.provider.retrieve(attempt.providerTaskId);
	if (result.status === "PENDING") {
		await deps.store.consumeVideoProviderEvents(jobId, attempt.id, queriedAt);
		return { status: "PENDING", retryAfterSeconds: config.providerPollSeconds, deadlineAt };
	}
	if (result.status === "FAILED") {
		await deps.store.recordVideoProviderAccounting(
			jobId,
			attempt.id,
			result.providerCreditsConsumed,
		);
		const changed = await deps.store.failVideoExecution(jobId, result.reasonCode);
		await deps.store.consumeVideoProviderEvents(jobId, attempt.id, queriedAt);
		if (!changed) {
			const latest = await deps.store.getVideoExecutionContext(jobId);
			if (latest?.attempts[0]?.status === "SUCCEEDED")
				return { status: "SUCCEEDED", attemptId: latest.attempts[0].id };
		}
		return { status: "FAILED", reasonCode: result.reasonCode };
	}
	await deps.store.recordVideoProviderSuccess({
		jobId,
		attemptId: attempt.id,
		providerTaskId: attempt.providerTaskId,
		outputUrl: result.outputUrl,
		providerCostMicros: result.providerCostMicros,
		providerCreditsConsumed: result.providerCreditsConsumed,
		providerCompletedAt: result.providerCompletedAt,
	});
	await deps.store.consumeVideoProviderEvents(jobId, attempt.id, queriedAt);
	const latest = await deps.store.getVideoExecutionContext(jobId);
	if (latest?.videoExecution && ["FAILED", "REJECTED"].includes(latest.videoExecution.stage))
		return { status: "FAILED", reasonCode: latest.failureCode ?? "VIDEO_GENERATION_FAILED" };
	return { status: "SUCCEEDED", attemptId: attempt.id };
}
