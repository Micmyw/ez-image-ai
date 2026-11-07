import { ORPCError } from "@orpc/server";
import { sourceTemplateDisplayPricingSchema } from "@repo/config/video-template-display-pricing";
import {
	sourceTemplateKeySchema,
	sourceTemplatePublicRequestSchema,
} from "@repo/config/video-template-execution.server";
import {
	createSourceTemplateQuote,
	createSourceTemplateJob,
	getSourceTemplatePublicState,
	listSourceTemplatePublicStates,
	sourceTemplateAccess,
	SourceTemplateNotAdmittedError,
} from "@repo/jobs/video-v1/source-template-admission";
import { getVideoWorkflowReadinessBindings } from "@repo/jobs/video-v1/workflow-binding";
import { z } from "zod";

import { protectedProcedure } from "../../orpc/procedures";
import { loadUserPlanEntitlement } from "../media/lib/plan-entitlement";
import { enforceMediaRateLimit } from "../media/lib/rate-limit";
import { maximumMediaStorageBytes } from "../media/lib/storage-limits";
import {
	videoEffectUploadSchema,
	videoEffectSealedInputSchema,
	videoEffectPlaybackSchema,
} from "../video-effects/types";
import { videoAction } from "../video-v1/errors";
import { createVideoPlayback } from "../video-v1/playback";
import { videoPublicStateSchema, videoQuoteResultSchema } from "../video-v1/types";
import {
	createSourceTemplateUpload,
	completeSourceTemplateUpload,
	getSourceTemplateInput,
} from "./uploads";

const route = (method: "GET" | "POST", path: `/${string}`) => ({
	method,
	path,
	tags: ["Video templates"],
	summary: `${method} ${path}`,
	description:
		"Authenticated, owner-scoped source video template operation. Provider contracts and private source materials remain server-only.",
});
const jobInput = z.object({ jobId: z.string().min(1).max(160) }).strict();
export async function sourceTemplateCreateAction<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (error) {
		if (error instanceof SourceTemplateNotAdmittedError)
			throw new ORPCError(error.message === "VIDEO_ACCESS_DENIED" ? "FORBIDDEN" : "BAD_REQUEST", {
				message: error.message,
				data: { code: error.message, submissionDisposition: error.submissionDisposition },
			});
		return videoAction(async () => {
			throw error;
		});
	}
}
const access = protectedProcedure
	.route(route("GET", "/video-templates/access"))
	.input(z.object({ templateKey: sourceTemplateKeySchema }).strict())
	.output(
		z
			.object({
				available: z.boolean(),
				reasons: z.array(z.string()),
				maximumInputBytes: z.number().int().positive(),
				pricing: sourceTemplateDisplayPricingSchema.nullable().optional(),
			})
			.strict(),
	)
	.handler(async ({ context: { user }, input }) => {
		const access = await sourceTemplateAccess(
			{ userId: user.id, role: user.role },
			input.templateKey,
			getVideoWorkflowReadinessBindings(),
		);
		const entitlement = await loadUserPlanEntitlement(user.id);
		return {
			...access,
			maximumInputBytes: Math.min(access.maximumInputBytes, entitlement.maximumInputBytes),
		};
	});
const quote = protectedProcedure
	.route(route("POST", "/video-templates/quotes"))
	.input(sourceTemplatePublicRequestSchema)
	.output(videoQuoteResultSchema)
	.handler(({ context: { user }, input }) =>
		videoAction(async () => {
			await enforceMediaRateLimit(user.id, "video-templates:quote");
			const entitlement = await loadUserPlanEntitlement(user.id);
			return createSourceTemplateQuote({ userId: user.id, role: user.role }, input, {
				bindings: getVideoWorkflowReadinessBindings(),
				maximumInputBytes: entitlement.maximumInputBytes,
			});
		}),
	);
const create = protectedProcedure
	.route(route("POST", "/video-templates/jobs"))
	.input(
		z
			.object({
				quoteId: z.string().min(1).max(160),
				idempotencyKey: z.string().min(1).max(128),
				request: sourceTemplatePublicRequestSchema,
			})
			.strict(),
	)
	.output(videoPublicStateSchema)
	.handler(({ context: { user }, input }) =>
		sourceTemplateCreateAction(async () => {
			const entitlement = await loadUserPlanEntitlement(user.id);
			return createSourceTemplateJob({ userId: user.id, role: user.role }, input, {
				bindings: getVideoWorkflowReadinessBindings(),
				limits: {
					maximumStorageBytes: maximumMediaStorageBytes(),
					maximumInputBytes: entitlement.maximumInputBytes,
				},
			});
		}),
	);
const get = protectedProcedure
	.route(route("GET", "/video-templates/jobs/{jobId}"))
	.input(jobInput)
	.output(videoPublicStateSchema)
	.handler(({ context: { user }, input }) =>
		videoAction(() => getSourceTemplatePublicState({ userId: user.id }, input.jobId)),
	);
const list = protectedProcedure
	.route(route("GET", "/video-templates/jobs"))
	.input(
		z
			.object({
				templateKey: sourceTemplateKeySchema.optional(),
				cursor: z.string().min(1).max(160).optional(),
				limit: z.number().int().min(1).max(20).default(20),
			})
			.strict(),
	)
	.output(
		z
			.object({ items: z.array(videoPublicStateSchema), nextCursor: z.string().nullable() })
			.strict(),
	)
	.handler(({ context: { user }, input }) =>
		videoAction(() => listSourceTemplatePublicStates({ userId: user.id }, input)),
	);
const playback = protectedProcedure
	.route(route("POST", "/video-templates/jobs/{jobId}/playback"))
	.input(jobInput.extend({ download: z.boolean().default(false) }))
	.output(videoEffectPlaybackSchema)
	.handler(({ context: { user }, input }) =>
		videoAction(async () => {
			const state = await getSourceTemplatePublicState({ userId: user.id }, input.jobId);
			if (!state.canPlay) throw new Error("NOT_FOUND");
			return createVideoPlayback(user.id, input.jobId, input.download);
		}),
	);
const uploadCreate = protectedProcedure
	.route(route("POST", "/video-templates/uploads"))
	.input(
		z
			.object({
				templateKey: sourceTemplateKeySchema,
				contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
				byteSize: z.number().int().positive().max(10000000),
			})
			.strict(),
	)
	.output(videoEffectUploadSchema)
	.handler(({ context: { user }, input }) =>
		videoAction(() => createSourceTemplateUpload(user, input)),
	);
const uploadComplete = protectedProcedure
	.route(route("POST", "/video-templates/uploads/{sessionId}/complete"))
	.input(z.object({ sessionId: z.string().min(1).max(160) }).strict())
	.output(videoEffectSealedInputSchema)
	.handler(({ context: { user }, input }) =>
		videoAction(() => completeSourceTemplateUpload(user, input)),
	);
const inputGet = protectedProcedure
	.route(route("GET", "/video-templates/inputs/{assetId}"))
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
		videoAction(() => getSourceTemplateInput(user.id, input.assetId)),
	);
export const videoTemplatesRouter = {
	access,
	quote,
	jobs: { create, get, list, playback },
	uploads: { create: uploadCreate, complete: uploadComplete },
	inputs: { get: inputGet },
};
