import { ORPCError } from "@orpc/server";
import {
	HOTEL_LOBBY_PUBLIC_EFFECT,
	VIDEO_EFFECT_MAX_INPUT_BYTES,
	videoEffectCreateSchema,
	videoEffectRequestSchema,
	videoEffectIdSchema,
} from "@repo/config/video-effects";
import { canAccessVideoEffect } from "@repo/config/video-effects-access.server";
import { readVideoV1Config } from "@repo/config/video-v1";
import { db } from "@repo/database/client";
import {
	getVideoTemplateAdminRecord,
	getVideoTemplateCreditBalance,
} from "@repo/database/video-template";
import {
	createVideoTemplateJob,
	createVideoTemplateQuote,
	getVideoTemplatePublicState,
	listVideoTemplatePublicStates,
	requireVideoTemplateAdmission,
	requireVideoTemplateRuntimeEnabled,
	VIDEO_EFFECT_CAPABILITY_REQUEST,
} from "@repo/jobs/video-v1/template-admission";
import { videoTemplateDiagnosticsTimings } from "@repo/jobs/video-v1/template-telemetry";
import { getVideoWorkflowReadinessBindings } from "@repo/jobs/video-v1/workflow-binding";
import { z } from "zod";

import { adminProcedure, protectedProcedure, publicProcedure } from "../../orpc/procedures";
import { loadUserPlanEntitlement } from "../media/lib/plan-entitlement";
import { enforceMediaRateLimit } from "../media/lib/rate-limit";
import { maximumMediaStorageBytes } from "../media/lib/storage-limits";
import { createVideoPlayback } from "../video-v1/playback";
import {
	publicVideoEffectError,
	videoEffectAccessSchema,
	videoEffectPlaybackSchema,
	videoEffectQuoteSchema,
	videoEffectSealedInputSchema,
	videoEffectStateSchema,
	videoEffectUploadSchema,
} from "./types";
import { completeVideoEffectUpload, createVideoEffectUpload, getVideoEffectInput } from "./uploads";

const jobInput = z.object({ jobId: z.string().min(1).max(160) }).strict();
const route = (method: "GET" | "POST", path: `/${string}`, summary: string) => ({
	method,
	path,
	tags: ["Video effects"],
	summary,
	description: summary,
});

export async function videoEffectAction<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (error) {
		const code = publicVideoEffectError(error instanceof Error ? error.message : "");
		throw new ORPCError(
			code === "ACCESS_DENIED"
				? "FORBIDDEN"
				: code === "INPUT_OR_JOB_NOT_FOUND"
					? "NOT_FOUND"
					: code === "IDEMPOTENCY_CONFLICT"
						? "CONFLICT"
						: "BAD_REQUEST",
			{ message: code, data: { code } },
		);
	}
}

const catalog = publicProcedure
	.route(route("GET", "/video-effects/catalog", "Read public video template descriptions"))
	.output(
		z
			.object({
				effect: z
					.object({
						effectId: z.literal("hotel-lobby-duo"),
						name: z.string(),
						publicVersion: z.string(),
						presetKey: z.literal("standard"),
						output: z
							.object({
								durationSeconds: z.literal(5),
								resolution: z.literal("720p"),
								aspectRatio: z.literal("9:16"),
								sound: z.literal(false),
							})
							.strict(),
						inputs: z
							.object({
								count: z.literal(2),
								roles: z.tuple([z.literal("left"), z.literal("right")]),
								maxBytes: z.literal(VIDEO_EFFECT_MAX_INPUT_BYTES),
							})
							.strict(),
					})
					.strict(),
				requiresLogin: z.literal(true),
			})
			.strict(),
	)
	.handler(() => ({
		effect: {
			...HOTEL_LOBBY_PUBLIC_EFFECT,
			inputs: {
				...HOTEL_LOBBY_PUBLIC_EFFECT.inputs,
				roles: ["left", "right"] as ["left", "right"],
			},
		},
		requiresLogin: true as const,
	}));

const access = protectedProcedure
	.route(
		route(
			"GET",
			"/video-effects/access",
			"Check template availability, price, eligible credit balance and upload limits",
		),
	)
	.input(
		z
			.object({ effectId: videoEffectIdSchema.default("hotel-lobby-duo") })
			.strict()
			.prefault({}),
	)
	.output(videoEffectAccessSchema)
	.handler(async ({ context: { user }, input }) => {
		const config = readVideoV1Config(process.env);
		const entitlement = await loadUserPlanEntitlement(user.id);
		const accessAllowed = canAccessVideoEffect(process.env, user, input.effectId);
		const base = {
			effectId: input.effectId,
			accessAllowed,
			maxInputBytes: Math.min(
				VIDEO_EFFECT_MAX_INPUT_BYTES,
				config.maxInputBytes,
				entitlement.maximumInputBytes,
			),
		};
		try {
			const admitted = requireVideoTemplateAdmission(
				{ userId: user.id, role: user.role },
				process.env,
				getVideoWorkflowReadinessBindings(),
				{
					...VIDEO_EFFECT_CAPABILITY_REQUEST,
					effectId: input.effectId,
					inputs: { leftAssetId: "capability", rightAssetId: "capability" },
				},
			);
			await requireVideoTemplateRuntimeEnabled(admitted.template);
			return {
				...base,
				maxInputBytes: Math.min(base.maxInputBytes, admitted.maximumInputBytes),
				available: true,
				reasons: [],
				credits: admitted.price.credits.toString(),
				creditBalance: await getVideoTemplateCreditBalance(
					user.id,
					admitted.price.paidFundingPolicy,
					db,
				),
			};
		} catch (error) {
			return {
				...base,
				available: false,
				reasons: [
					accessAllowed
						? publicVideoEffectError(error instanceof Error ? error.message : "")
						: "ACCESS_DENIED",
				],
				credits: null,
				creditBalance: null,
			};
		}
	});

const quote = protectedProcedure
	.route(route("POST", "/video-effects/quotes", "Quote the complete photo-to-video template once"))
	.input(videoEffectRequestSchema)
	.output(videoEffectQuoteSchema)
	.handler(({ context: { user }, input }) =>
		videoEffectAction(async () => {
			await enforceMediaRateLimit(user.id, "video-effects:quote");
			const entitlement = await loadUserPlanEntitlement(user.id);
			return createVideoTemplateQuote({ userId: user.id, role: user.role }, input, {
				bindings: getVideoWorkflowReadinessBindings(),
				maximumInputBytes: entitlement.maximumInputBytes,
			});
		}),
	);
const create = protectedProcedure
	.route(route("POST", "/video-effects/jobs", "Accept one immutable video template order"))
	.input(videoEffectCreateSchema)
	.output(videoEffectStateSchema)
	.handler(({ context: { user }, input }) =>
		videoEffectAction(async () => {
			const requestReceivedAt = new Date();
			const entitlement = await loadUserPlanEntitlement(user.id);
			return createVideoTemplateJob({ userId: user.id, role: user.role }, input, {
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
	.route(
		route("GET", "/video-effects/jobs/{jobId}", "Read a private template job without advancing it"),
	)
	.input(jobInput)
	.output(videoEffectStateSchema)
	.handler(({ context: { user }, input }) =>
		videoEffectAction(() => getVideoTemplatePublicState({ userId: user.id }, input.jobId)),
	);
const list = protectedProcedure
	.route(route("GET", "/video-effects/jobs", "List owned template jobs"))
	.input(
		z
			.object({
				cursor: z.string().min(1).max(160).optional(),
				limit: z.number().int().min(1).max(20).default(20),
			})
			.strict(),
	)
	.output(
		z
			.object({ items: z.array(videoEffectStateSchema), nextCursor: z.string().nullable() })
			.strict(),
	)
	.handler(({ context: { user }, input }) =>
		videoEffectAction(() => listVideoTemplatePublicStates({ userId: user.id }, input)),
	);
const playback = protectedProcedure
	.route(
		route(
			"POST",
			"/video-effects/jobs/{jobId}/playback",
			"Authorize settled and reviewed private video playback",
		),
	)
	.input(jobInput.extend({ download: z.boolean().default(false) }))
	.output(videoEffectPlaybackSchema)
	.handler(({ context: { user }, input }) =>
		videoEffectAction(async () => {
			const state = await getVideoTemplatePublicState({ userId: user.id }, input.jobId);
			if (!state.canPlay) throw new Error("NOT_FOUND");
			return createVideoPlayback(user.id, input.jobId, input.download);
		}),
	);
const uploadCreate = protectedProcedure
	.route(
		route("POST", "/video-effects/uploads", "Create an owned photo upload before paid generation"),
	)
	.input(
		z
			.object({
				effectId: videoEffectIdSchema.optional(),
				contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
				byteSize: z.number().int().positive().max(VIDEO_EFFECT_MAX_INPUT_BYTES),
			})
			.strict(),
	)
	.output(videoEffectUploadSchema)
	.handler(({ context: { user }, input }) =>
		videoEffectAction(() => createVideoEffectUpload(user, input)),
	);
const uploadComplete = protectedProcedure
	.route(
		route(
			"POST",
			"/video-effects/uploads/{sessionId}/complete",
			"Seal uploaded photo content for review",
		),
	)
	.input(z.object({ sessionId: z.string().min(1).max(160) }).strict())
	.output(videoEffectSealedInputSchema)
	.handler(({ context: { user }, input }) =>
		videoEffectAction(() => completeVideoEffectUpload(user, input)),
	);
const getInput = protectedProcedure
	.route(route("GET", "/video-effects/inputs/{assetId}", "Restore an owned sealed photo reference"))
	.input(z.object({ assetId: z.string().min(1).max(160) }).strict())
	.output(
		z
			.object({
				assetId: z.string(),
				mimeType: z.string(),
				byteSize: z.string(),
				width: z.number(),
				height: z.number(),
				sealed: z.literal(true),
				previewUrl: z.string().nullable(),
				previewExpiresAt: z.string().nullable(),
			})
			.strict(),
	)
	.handler(({ context: { user }, input }) =>
		videoEffectAction(() => getVideoEffectInput(user.id, input.assetId)),
	);

const diagnostics = adminProcedure
	.route(
		route(
			"GET",
			"/video-effects/admin/jobs/{jobId}",
			"Read privileged template recovery evidence and measured stage timings",
		),
	)
	.input(jobInput)
	.output(
		z
			.object({
				jobId: z.string(),
				ownerId: z.string(),
				status: z.string(),
				sceneState: z.string(),
				sceneSubmissionUncertain: z.boolean(),
				sceneProviderTaskId: z.string().nullable(),
				sceneAsset: z
					.object({
						assetId: z.string(),
						checksum: z.string().nullable(),
						bytes: z.string(),
						status: z.string(),
					})
					.nullable(),
				credits: z.string(),
				creditState: z.string(),
				timings: z.record(z.string(), z.string().nullable()),
				durations: z.record(z.string(), z.number().nullable()),
			})
			.strict(),
	)
	.handler(({ input }) =>
		videoEffectAction(async () => {
			const job = await getVideoTemplateAdminRecord(input.jobId, db);
			if (!job?.videoTemplateExecution || !job.videoExecution || !job.reservation)
				throw new Error("NOT_FOUND");
			const template = job.videoTemplateExecution;
			return {
				jobId: job.id,
				ownerId: job.ownerId,
				status: job.status,
				sceneState: template.sceneState,
				sceneSubmissionUncertain: template.sceneSubmissionUncertain,
				sceneProviderTaskId: template.sceneProviderTaskId,
				sceneAsset: template.sceneAsset
					? {
							assetId: template.sceneAsset.id,
							checksum: template.sceneAsset.checksum,
							bytes: template.sceneAsset.byteSize.toString(),
							status: template.sceneAsset.status,
						}
					: null,
				credits: job.creditsReserved.toString(),
				creditState: job.reservation.status,
				...videoTemplateDiagnosticsTimings(job.videoExecution, template),
			};
		}),
	);

export const videoEffectsRouter = {
	catalog,
	access,
	quote,
	uploads: { create: uploadCreate, complete: uploadComplete },
	inputs: { get: getInput },
	jobs: { create, get, list, playback },
	admin: { diagnostics },
};
