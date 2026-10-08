import { ORPCError } from "@orpc/server";
import { VIDEO_MODEL_CATALOG } from "@repo/config/video-models";
import { isVideoRetailPricingApproved } from "@repo/config/video-pricing.server";
import {
	canAccessVideoV1,
	readVideoV1Config,
	videoV1InputSchema,
	videoV1ReceiptInputSchema,
	VIDEO_V1_PRODUCT_KEY,
} from "@repo/config/video-v1";
import { db } from "@repo/database/client";
import { resolveVideoRetailEligibility } from "@repo/database/video-retail-eligibility";
import { createVideoQuoteRecord } from "@repo/database/video-v1";
import {
	createVideoJob,
	getVideoPublicState,
	listVideoPublicStates,
	requireVideoAdmission,
} from "@repo/jobs/video-v1/admission";
import { videoStageDurations, type VideoStageTiming } from "@repo/jobs/video-v1/telemetry";
import { getVideoWorkflowReadinessBindings } from "@repo/jobs/video-v1/workflow-binding";
import { z } from "zod";

import { adminProcedure, protectedProcedure } from "../../orpc/procedures";
import { loadUserPlanEntitlement } from "../media/lib/plan-entitlement";
import { enforceMediaRateLimit } from "../media/lib/rate-limit";
import { maximumMediaStorageBytes } from "../media/lib/storage-limits";
import { buildVideoCatalogModels } from "./catalog";
import { createVideoPlayback } from "./playback";
import { createVideoUpload, completeVideoUpload } from "./uploads";

const jobInput = z.object({ jobId: z.string().min(1).max(160) }).strict();
async function videoAction<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (error) {
		if (error instanceof ORPCError) throw error;
		const message = error instanceof Error ? error.message : "VIDEO_REQUEST_FAILED";
		// Do not return provider messages, SQL errors, prompts, or private storage URLs.
		const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : "VIDEO_REQUEST_FAILED";
		throw new ORPCError(
			code === "IDEMPOTENCY_CONFLICT"
				? "CONFLICT"
				: code === "NOT_FOUND"
					? "NOT_FOUND"
					: code === "VIDEO_ACCESS_DENIED"
						? "FORBIDDEN"
						: "BAD_REQUEST",
			{ message: code, data: { code } },
		);
	}
}

const catalog = protectedProcedure
	.route({ method: "GET", path: "/video-v1/catalog", tags: ["Video V1"] })
	.handler(async ({ context: { user } }) => {
		const config = readVideoV1Config(process.env);
		const accessAllowed = canAccessVideoV1(config, user);
		const bindings = getVideoWorkflowReadinessBindings();
		const entitlement = await loadUserPlanEntitlement(user.id);
		const eligibility = isVideoRetailPricingApproved(process.env)
			? await resolveVideoRetailEligibility(user.id, db)
			: undefined;
		const blocked = accessAllowed
			? await db.runtimeConfigOverride.findMany({
					where: {
						active: true,
						configKey: {
							in: [
								"media.generation.enabled",
								...VIDEO_MODEL_CATALOG.map((model) => `media.model.${model.productKey}.enabled`),
							],
						},
						value: { equals: false },
					},
					select: { configKey: true },
				})
			: [];
		const disabledKeys = new Set(blocked.map((row) => row.configKey));
		const models = buildVideoCatalogModels(
			process.env,
			bindings,
			accessAllowed,
			disabledKeys,
			eligibility ? { audience: eligibility.audience, eligibility } : undefined,
		);
		const defaultModel = models.find((model) => model.productKey === VIDEO_V1_PRODUCT_KEY);
		const defaultOption = defaultModel?.options.find(
			(option) =>
				option.mode === "text-to-video" &&
				option.duration === 5 &&
				option.resolution === "default" &&
				!option.sound,
		);
		return {
			available: models.some((model) => model.available),
			accessAllowed,
			...(eligibility ? { pricingValidUntil: eligibility.validUntil } : {}),
			reasons: defaultOption
				? [...new Set([...(defaultModel?.commonReasons ?? []), ...defaultOption.reasons])]
				: (defaultModel?.reasons ?? ["VIDEO_NOT_READY"]),
			models,
			productKey: VIDEO_V1_PRODUCT_KEY,
			modelName: "Kling 2.6",
			duration: 5 as const,
			sound: false as const,
			credits: defaultOption?.credits ?? null,
			maxPromptCodePoints: config.maxPromptCodePoints,
			maxInputBytes: Math.min(entitlement.maximumInputBytes, config.maxInputBytes),
			aspectRatios: ["16:9", "9:16"] as const,
		};
	});
const quote = protectedProcedure
	.route({ method: "POST", path: "/video-v1/quotes", tags: ["Video V1"] })
	.input(videoV1InputSchema)
	.handler(({ context: { user }, input }) =>
		videoAction(async () => {
			const eligibility = isVideoRetailPricingApproved(process.env)
				? await resolveVideoRetailEligibility(user.id, db)
				: undefined;
			const { config, price, visualSafetyProfile, textSafetyProfile, audioSafetyPolicy } =
				requireVideoAdmission(
					{ userId: user.id, role: user.role },
					process.env,
					getVideoWorkflowReadinessBindings(),
					input,
					eligibility ? { audience: eligibility.audience, eligibility } : undefined,
				);
			await enforceMediaRateLimit(user.id, "video-v1:quote");
			const entitlement = await loadUserPlanEntitlement(user.id);
			return createVideoQuoteRecord(
				{
					ownerId: user.id,
					request: input,
					price,
					visualSafetyProfile,
					textSafetyProfile,
					audioSafetyPolicy,
					maximumInputBytes: Math.min(config.maxInputBytes, entitlement.maximumInputBytes),
				},
				db,
			);
		}),
	);
const create = protectedProcedure
	.route({ method: "POST", path: "/video-v1/jobs", tags: ["Video V1"] })
	.input(
		z
			.object({
				quoteId: z.string().min(1).max(160),
				idempotencyKey: z.string().min(1).max(128),
				request: videoV1ReceiptInputSchema,
			})
			.strict(),
	)
	.handler(({ context: { user }, input }) =>
		videoAction(async () => {
			const requestReceivedAt = new Date();
			const entitlement = await loadUserPlanEntitlement(user.id);
			return createVideoJob({ userId: user.id, role: user.role }, input, {
				requestReceivedAt,
				bindings: getVideoWorkflowReadinessBindings(),
				limits: {
					maximumStorageBytes: maximumMediaStorageBytes(),
					maximumInputBytes: entitlement.maximumInputBytes,
				},
			});
		}),
	);
const get = protectedProcedure
	.route({ method: "GET", path: "/video-v1/jobs/{jobId}", tags: ["Video V1"] })
	.input(jobInput)
	.handler(({ context: { user }, input }) =>
		videoAction(() => getVideoPublicState({ userId: user.id }, input.jobId)),
	);
const list = protectedProcedure
	.route({ method: "GET", path: "/video-v1/jobs", tags: ["Video V1"] })
	.input(
		z
			.object({
				cursor: z.string().min(1).max(160).optional(),
				limit: z.number().int().min(1).max(20).default(20),
			})
			.strict(),
	)
	.handler(({ context: { user }, input }) =>
		videoAction(() => listVideoPublicStates({ userId: user.id }, input)),
	);
const playback = protectedProcedure
	.route({ method: "POST", path: "/video-v1/jobs/{jobId}/playback", tags: ["Video V1"] })
	.input(jobInput.extend({ download: z.boolean().default(false) }))
	.handler(({ context: { user }, input }) =>
		videoAction(() => createVideoPlayback(user.id, input.jobId, input.download)),
	);
const uploadCreate = protectedProcedure
	.route({ method: "POST", path: "/video-v1/uploads", tags: ["Video V1"] })
	.input(
		z
			.object({
				contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
				byteSize: z
					.number()
					.int()
					.positive()
					.max(10 * 1024 * 1024),
			})
			.strict(),
	)
	.handler(({ context: { user }, input }) => videoAction(() => createVideoUpload(user, input)));
const uploadComplete = protectedProcedure
	.route({ method: "POST", path: "/video-v1/uploads/{sessionId}/complete", tags: ["Video V1"] })
	.input(z.object({ sessionId: z.string().min(1).max(160) }).strict())
	.handler(({ context: { user }, input }) => videoAction(() => completeVideoUpload(user, input)));
const diagnostics = adminProcedure
	.route({ method: "GET", path: "/video-v1/admin/jobs/{jobId}", tags: ["Video V1 Admin"] })
	.input(jobInput)
	.handler(({ input }) =>
		videoAction(async () => {
			const job = await db.generationJob.findFirst({
				where: { id: input.jobId, executionEngine: "video-workflow-v1" },
				include: {
					videoExecution: true,
					reservation: true,
					attempts: {
						orderBy: { attemptNumber: "asc" },
						select: {
							id: true,
							providerTaskId: true,
							status: true,
							uncertainSubmission: true,
							providerCostMicros: true,
							submittedAt: true,
							completedAt: true,
						},
					},
					assets: {
						select: {
							role: true,
							asset: {
								select: {
									id: true,
									status: true,
									checksum: true,
									byteSize: true,
									finalizedAt: true,
									verificationValidUntil: true,
								},
							},
						},
					},
				},
			});
			if (!job?.videoExecution) throw new Error("NOT_FOUND");
			const execution = job.videoExecution;
			const data =
				execution.stageData &&
				typeof execution.stageData === "object" &&
				!Array.isArray(execution.stageData)
					? execution.stageData
					: {};
			const rawTimings =
				data.timings && typeof data.timings === "object" && !Array.isArray(data.timings)
					? data.timings
					: {};
			const safeTiming = (name: string): string | null => {
				const value = rawTimings[name];
				return typeof value === "string" &&
					/^\d{4}-\d{2}-\d{2}T/.test(value) &&
					Number.isFinite(Date.parse(value))
					? new Date(value).toISOString()
					: null;
			};
			const timings: VideoStageTiming = {
				requestReceivedAt: safeTiming("requestReceivedAt"),
				admissionTransactionStartedAt: safeTiming("admissionTransactionStartedAt"),
				providerCapacityLockRequestedAt: safeTiming("providerCapacityLockRequestedAt"),
				providerCapacityLockAcquiredAt: safeTiming("providerCapacityLockAcquiredAt"),
				creditReservationStartedAt: safeTiming("creditReservationStartedAt"),
				creditReservationCompletedAt: safeTiming("creditReservationCompletedAt"),
				jobReservationWrittenAt: safeTiming("jobReservationWrittenAt"),
				jobReservedAt: safeTiming("jobReservedAt"),
				workflowCreateRequestedAt: safeTiming("workflowCreateRequestedAt"),
				workflowStartedAt: safeTiming("workflowStartedAt"),
				inputReviewStartedAt: execution.inputReviewStartedAt?.toISOString() ?? null,
				inputReviewCompletedAt: execution.inputReviewCompletedAt?.toISOString() ?? null,
				providerSubmitStartedAt: execution.providerSubmitStartedAt?.toISOString() ?? null,
				providerAcceptedAt: execution.providerAcceptedAt?.toISOString() ?? null,
				providerCompletedAt: execution.providerCompletedAt?.toISOString() ?? null,
				providerCallbackReceivedAt: safeTiming("providerCallbackReceivedAt"),
				providerCallbackPersistedAt: safeTiming("providerCallbackPersistedAt"),
				providerResultConfirmedAt: safeTiming("providerResultConfirmedAt"),
				storageStartedAt: execution.storageStartedAt?.toISOString() ?? null,
				storageCompletedAt: execution.storageCompletedAt?.toISOString() ?? null,
				outputReviewStartedAt: execution.outputReviewStartedAt?.toISOString() ?? null,
				outputReviewCompletedAt: execution.outputReviewCompletedAt?.toISOString() ?? null,
				readyAt: execution.readyAt?.toISOString() ?? null,
			};
			return {
				jobId: job.id,
				ownerId: job.ownerId,
				status: job.status,
				execution: {
					workflowInstanceId: execution.workflowInstanceId,
					workflowSchemaVersion: execution.workflowSchemaVersion,
					stage: execution.stage,
					startState: execution.startState,
					stateVersion: execution.stateVersion,
					modelContractVersion: execution.modelContractVersion,
					startAttemptCount: execution.startAttemptCount,
					nextStartAt: execution.nextStartAt,
					lastProgressAt: execution.lastProgressAt,
					needsReviewReason:
						execution.needsReviewReason && /^[A-Z0-9_]{1,100}$/.test(execution.needsReviewReason)
							? execution.needsReviewReason
							: null,
					timings,
					durations: videoStageDurations(timings),
				},
				credits: job.creditsReserved.toString(),
				creditState: job.reservation?.status ?? null,
				attempts: job.attempts.map((attempt) => ({
					...attempt,
					providerCostMicros: attempt.providerCostMicros?.toString() ?? null,
				})),
				assets: job.assets.map(({ role, asset }) => ({
					role,
					...asset,
					byteSize: asset.byteSize.toString(),
				})),
			};
		}),
	);

export const videoV1Router = {
	catalog,
	quote,
	uploads: { create: uploadCreate, complete: uploadComplete },
	jobs: { create, get, list, playback },
	admin: { diagnostics },
};
