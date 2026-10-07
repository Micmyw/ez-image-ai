import { videoEffectIdSchema, videoEffectName } from "@repo/config/video-effects";
import type { resolveVideoEffectPrice } from "@repo/config/video-effects.server";
import { applyVideoInternalFunding } from "@repo/config/video-internal-funding";
import { isVideoModelOptionAllowed, readVideoModelAccess } from "@repo/config/video-model-access";
import {
	getVideoModel,
	validateVideoModelSelection,
	type VideoModelSelection,
} from "@repo/config/video-models";
import { createVideoAudioSafetyPolicy } from "@repo/config/video-output";
import { resolveVideoModelPrice } from "@repo/config/video-pricing.server";
import { configuredVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { configuredVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import {
	canAccessVideoV1,
	readVideoV1Config,
	videoV1Readiness,
	type VideoV1Bindings,
	VIDEO_V1_PRODUCT_KEY,
} from "@repo/config/video-v1";
import { db } from "@repo/database/client";
import {
	createVideoJobRecord,
	findExistingVideoAdmission,
	getVideoJobRecord,
	listVideoJobRecords,
	type VideoAdmissionLimits,
	type VideoPrice,
} from "@repo/database/video-v1";
import { authorizeVideoPlayback } from "@repo/database/video-v1-fulfillment";

import type {
	CreateVideoJobInput,
	VideoOwnerContext,
	VideoPublicState,
	VideoStartState,
	VideoWorkflowBinding,
	VideoRequestInput,
} from "./contracts";
import { getVideoWorkflowBinding } from "./workflow-binding";

export function requireVideoAdmission(
	context: VideoOwnerContext,
	environment: Record<string, string | undefined>,
	bindings: VideoV1Bindings,
	request?: VideoRequestInput | VideoModelSelection,
) {
	const config = readVideoV1Config(environment);
	if (!canAccessVideoV1(config, { id: context.userId, role: context.role }))
		throw new Error("VIDEO_ACCESS_DENIED");
	const admitted = requireVideoModelReadiness(environment, bindings, request);
	return {
		...admitted,
		price: applyVideoInternalFunding(admitted.price, context, environment) satisfies VideoPrice,
	};
}

/** Server-only shared guards; callers must first authorize their own product's audience. */
export function requireVideoModelReadiness(
	environment: Record<string, string | undefined>,
	bindings: VideoV1Bindings,
	request?: VideoRequestInput | VideoModelSelection,
	options?: { priceOverride: ReturnType<typeof resolveVideoEffectPrice> },
) {
	const config = readVideoV1Config(environment);
	const selection = videoRequestSelection(request);
	const model = getVideoModel(selection.productKey);
	if (!model || !validateVideoModelSelection(selection))
		throw new Error("VIDEO_MODEL_OPTION_UNAVAILABLE");
	const access = readVideoModelAccess(environment);
	if (!isVideoModelOptionAllowed(access, selection))
		throw new Error(access.reason ?? "VIDEO_MODEL_OPTION_NOT_ENABLED");
	const readiness = videoV1Readiness(environment, bindings, {
		multiModel: true,
		sound: selection.sound,
	});
	if (!readiness.ready) throw new Error(readiness.reasons[0] ?? "VIDEO_NOT_READY");
	const visualSafetyProfile = configuredVideoVisualSafetyProfile(environment, selection.duration);
	if (environment.VIDEO_COST_VISUAL_POLICY_VERSION !== visualSafetyProfile.policyVersion)
		throw new Error("VIDEO_VISUAL_COST_POLICY_NOT_CONFIRMED");
	const textSafetyProfile = configuredVideoTextSafetyProfile(environment);
	if (environment.VIDEO_COST_TEXT_RULE_VERSION !== textSafetyProfile.ruleVersion)
		throw new Error("VIDEO_TEXT_COST_POLICY_NOT_CONFIRMED");
	return {
		config,
		visualSafetyProfile,
		textSafetyProfile,
		audioSafetyPolicy: createVideoAudioSafetyPolicy(),
		price: (options?.priceOverride ??
			resolveVideoModelPrice(selection, environment)) satisfies VideoPrice,
	};
}

/** Normalize only for current server pricing; persisted legacy fingerprints stay unchanged. */
export function videoRequestSelection(
	request?: VideoRequestInput | VideoModelSelection,
): VideoModelSelection {
	if (request && "productKey" in request) return request;
	return {
		productKey: VIDEO_V1_PRODUCT_KEY,
		mode: request?.mode ?? "text-to-video",
		duration: 5,
		resolution: "default",
		aspectRatio: request?.mode === "image-to-video" ? "source" : (request?.aspectRatio ?? "16:9"),
		sound: false,
	};
}

export async function createVideoJob(
	context: VideoOwnerContext,
	input: CreateVideoJobInput,
	options: {
		bindings: VideoV1Bindings;
		limits: Pick<VideoAdmissionLimits, "maximumStorageBytes" | "maximumInputBytes">;
		environment?: Record<string, string | undefined>;
		binding?: VideoWorkflowBinding;
		requestReceivedAt?: Date;
	},
): Promise<VideoPublicState> {
	// Replay precedes mutable flags/price/expiry checks: an accepted request remains queryable.
	const replay = await findExistingVideoAdmission({ ownerId: context.userId, ...input }, db);
	const binding = options.binding ?? getVideoWorkflowBinding();
	if (replay) {
		await ensureVideoWorkflowStarted(replay.id, binding);
		return getVideoPublicState(context, replay.id);
	}
	const { config, price, visualSafetyProfile, textSafetyProfile, audioSafetyPolicy } =
		requireVideoAdmission(
			context,
			options.environment ?? process.env,
			options.bindings,
			input.request,
		);
	const created = await createVideoJobRecord(
		{
			ownerId: context.userId,
			...input,
			price,
			visualSafetyProfile,
			textSafetyProfile,
			audioSafetyPolicy,
			paidFundingPolicy: price.paidFundingPolicy,
			requestReceivedAt: options.requestReceivedAt,
			limits: {
				...options.limits,
				maximumInputBytes: Math.min(options.limits.maximumInputBytes, config.maxInputBytes),
				ownerConcurrency: config.ownerConcurrency,
				globalConcurrency: config.globalConcurrency,
				providerConcurrency: config.providerConcurrency,
			},
		},
		db,
	);
	await ensureVideoWorkflowStarted(created.jobId, binding);
	return getVideoPublicState(context, created.jobId);
}

type StartDependencies = {
	load(jobId: string): Promise<{
		workflowInstanceId: string;
		startState: VideoStartState;
		executionEngine: string;
	} | null>;
	recordAttempt(jobId: string): Promise<void>;
	recordStarted(jobId: string): Promise<void>;
	recordPending(jobId: string): Promise<void>;
};
const startDependencies: StartDependencies = {
	async load(jobId) {
		const execution = await db.videoExecution.findUnique({
			where: { jobId },
			include: { job: { select: { executionEngine: true } } },
		});
		return execution ? { ...execution, executionEngine: execution.job.executionEngine } : null;
	},
	async recordAttempt(jobId) {
		// Use the same Worker clock as the other pipeline timestamps. Mixing a
		// database server clock with Worker timestamps can invert adjacent stages.
		const requestedAt = new Date().toISOString();
		await db.$executeRaw`
		UPDATE "video_execution" SET "startAttemptCount" = "startAttemptCount" + 1,
		"nextStartAt" = clock_timestamp() + interval '30 seconds', "updatedAt" = clock_timestamp(),
		"stageData" = jsonb_set("stageData", '{timings}', COALESCE("stageData"->'timings', '{}'::jsonb) || jsonb_build_object('workflowCreateRequestedAt', COALESCE("stageData"->'timings'->>'workflowCreateRequestedAt', ${requestedAt})))
		WHERE "jobId" = ${jobId} AND "startState" <> 'STARTED'`;
	},
	async recordStarted(jobId) {
		await db.videoExecution.update({
			where: { jobId },
			data: { startState: "STARTED", nextStartAt: null, lastProgressAt: new Date() },
		});
	},
	async recordPending(jobId) {
		await db.videoExecution.updateMany({
			where: { jobId, startState: { not: "STARTED" } },
			data: { startState: "PENDING", nextStartAt: new Date(Date.now() + 30_000) },
		});
	},
};

/** A durable start intent is committed before this function. All retries use one instance ID. */
export async function ensureVideoWorkflowStarted(
	jobId: string,
	binding?: VideoWorkflowBinding,
	dependencies: StartDependencies = startDependencies,
): Promise<VideoStartState> {
	const execution = await dependencies.load(jobId);
	if (
		!execution ||
		execution.executionEngine !== "video-workflow-v1" ||
		execution.workflowInstanceId !== `video-v1-${jobId}`
	)
		throw new Error("VIDEO_EXECUTION_NOT_FOUND");
	if (execution.startState === "STARTED") return "STARTED";
	if (!binding) return "PENDING";
	try {
		await dependencies.recordAttempt(jobId);
		await binding.create({ id: execution.workflowInstanceId, params: { jobId, schemaVersion: 1 } });
		await dependencies.recordStarted(jobId);
		return "STARTED";
	} catch {
		// A lost create response is not proof of absence. Query the same durable ID.
		try {
			const instance = await binding.get(execution.workflowInstanceId);
			const status = await instance.status();
			if (status.status && status.status !== "unknown") {
				await dependencies.recordStarted(jobId);
				return "STARTED";
			}
		} catch {
			/* Recovery owns the persisted PENDING intent; never replace the ID. */
		}
		await dependencies.recordPending(jobId).catch(() => undefined);
		return "PENDING";
	}
}

type PublicRecord = Awaited<ReturnType<typeof getVideoJobRecord>>;
export function toVideoPublicState(job: PublicRecord): VideoPublicState {
	if (!job.videoExecution || !job.reservation) throw new Error("VIDEO_EXECUTION_INVALID");
	const snapshot =
		job.inputSnapshot && typeof job.inputSnapshot === "object" && !Array.isArray(job.inputSnapshot)
			? job.inputSnapshot
			: {};
	const template =
		snapshot.videoEffectTemplate &&
		typeof snapshot.videoEffectTemplate === "object" &&
		!Array.isArray(snapshot.videoEffectTemplate)
			? snapshot.videoEffectTemplate
			: null;
	return {
		jobId: job.id,
		stage: job.videoExecution.stage,
		creditState: job.reservation.status === "ACTIVE" ? "RESERVED" : job.reservation.status,
		credits: job.creditsReserved.toString(),
		canPlay:
			job.videoExecution.stage === "READY" &&
			job.status === "SUCCEEDED" &&
			job.reservation.status === "SETTLED",
		failureCode: job.failureCode,
		updatedAt: job.updatedAt.toISOString(),
		...(videoEffectIdSchema.safeParse(template?.effectId).success &&
		typeof template?.templateVersion === "string"
			? {
					effect: {
						effectId: videoEffectIdSchema.parse(template.effectId),
						name:
							template.effectId === "hotel-lobby-duo"
								? "Hotel Lobby AI"
								: videoEffectName(videoEffectIdSchema.parse(template.effectId)),
						templateVersion: template.templateVersion,
					},
				}
			: {}),
	};
}
export async function getVideoPublicState(
	context: VideoOwnerContext,
	jobId: string,
): Promise<VideoPublicState> {
	const state = toVideoPublicState(await getVideoJobRecord(context.userId, jobId, db));
	if (state.canPlay) state.canPlay = Boolean(await authorizeVideoPlayback(context.userId, jobId));
	return state;
}
export async function listVideoPublicStates(
	context: VideoOwnerContext,
	input: { cursor?: string; limit?: number },
) {
	const result = await listVideoJobRecords(context.userId, input, db);
	const items = await Promise.all(
		result.rows.map(async (job) => {
			const state = toVideoPublicState(job);
			if (state.canPlay)
				state.canPlay = Boolean(await authorizeVideoPlayback(context.userId, job.id));
			return state;
		}),
	);
	return { items, nextCursor: result.nextCursor };
}
