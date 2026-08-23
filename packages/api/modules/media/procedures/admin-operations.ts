import { productModelKeySchema } from "@repo/config";
import {
	isSafeFalReconciliationEndpoint,
	replayPersistedMediaEvent,
	resolveAdminUncertainSubmission,
	retryAdminMediaJobStage,
	rollbackAdminMediaRuntimeOverride,
	setAdminMediaRuntimeOverride,
} from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { adminProcedure } from "../../../orpc/procedures";

const operationSchema = z.object({
	idempotencyKey: z.string().trim().min(8).max(128),
	reason: z.string().trim().min(10).max(500),
});

export const replayMediaEvent = adminProcedure
	.route({ method: "POST", path: "/admin/media/events/replay", tags: ["Admin", "Media"] })
	.input(
		operationSchema.extend({
			eventKind: z.enum(["PAYMENT", "PROVIDER"]),
			eventId: z.string().min(1).max(128),
		}),
	)
	.handler(async ({ context: { user }, input }) =>
		replayPersistedMediaEvent({ ...input, actorUserId: user.id }, db),
	);

export const retryMediaJobStage = adminProcedure
	.route({ method: "POST", path: "/admin/media/jobs/retry-stage", tags: ["Admin", "Media"] })
	.input(
		operationSchema.extend({
			jobId: z.string().min(1).max(128),
			stage: z.enum(["DISPATCH", "FINALIZE", "SETTLE"]),
		}),
	)
	.handler(async ({ context: { user }, input }) =>
		retryAdminMediaJobStage({ ...input, actorUserId: user.id }, db),
	);

export const resolveUncertainSubmission = adminProcedure
	.route({
		method: "POST",
		path: "/admin/media/attempts/resolve-uncertain",
		tags: ["Admin", "Media"],
	})
	.input(
		operationSchema
			.extend({
				attemptId: z.string().min(1).max(128),
				resolution: z.enum(["ACCEPTED", "REJECTED"]),
				providerTaskId: z.string().trim().min(1).max(512).optional(),
				statusUrl: z.url().max(2_048).optional(),
				resultUrl: z.url().max(2_048).optional(),
				providerEvidenceReference: z.string().trim().min(10).max(1_000),
			})
			.superRefine((input, context) => {
				if (input.resolution === "ACCEPTED" && !input.providerTaskId) {
					context.addIssue({
						code: "custom",
						message: "Accepted submissions require a provider task ID",
						path: ["providerTaskId"],
					});
				}
				if (
					input.resolution === "REJECTED" &&
					(input.providerTaskId || input.statusUrl || input.resultUrl)
				) {
					context.addIssue({
						code: "custom",
						message: "Rejected submissions cannot add provider task information",
						path: ["providerTaskId"],
					});
				}
				for (const [field, value] of [
					["statusUrl", input.statusUrl],
					["resultUrl", input.resultUrl],
				] as const) {
					if (value && !isSafeFalReconciliationEndpoint(value)) {
						context.addIssue({
							code: "custom",
							message: "Fal reconciliation endpoints must use the official HTTPS queue host",
							path: [field],
						});
					}
				}
			}),
	)
	.handler(async ({ context: { user }, input }) =>
		resolveAdminUncertainSubmission({ ...input, actorUserId: user.id }, db),
	);

export const setMediaRuntimeOverride = adminProcedure
	.route({ method: "POST", path: "/admin/media/runtime-overrides", tags: ["Admin", "Media"] })
	.input(
		operationSchema
			.extend({
				scope: z.enum(["GLOBAL", "MODEL"]),
				productKey: productModelKeySchema.optional(),
				enabled: z.boolean(),
			})
			.superRefine((input, context) => {
				if (input.scope === "MODEL" && !input.productKey) {
					context.addIssue({
						code: "custom",
						message: "A product key is required for model overrides",
						path: ["productKey"],
					});
				}
				if (input.scope === "GLOBAL" && input.productKey) {
					context.addIssue({
						code: "custom",
						message: "Global overrides cannot name a product",
						path: ["productKey"],
					});
				}
			}),
	)
	.handler(async ({ context: { user }, input }) =>
		setAdminMediaRuntimeOverride(
			{
				configKey:
					input.scope === "GLOBAL"
						? "media.generation.enabled"
						: `media.model.${input.productKey}.enabled`,
				value: input.enabled,
				actorUserId: user.id,
				idempotencyKey: input.idempotencyKey,
				reason: input.reason,
			},
			db,
		),
	);

export const rollbackMediaRuntimeOverride = adminProcedure
	.route({
		method: "POST",
		path: "/admin/media/runtime-overrides/rollback",
		tags: ["Admin", "Media"],
	})
	.input(operationSchema.extend({ overrideId: z.string().min(1).max(128) }))
	.handler(async ({ context: { user }, input }) =>
		rollbackAdminMediaRuntimeOverride({ ...input, actorUserId: user.id }, db),
	);

/** @deprecated use setMediaRuntimeOverride */
export const setMediaGenerationOverride = setMediaRuntimeOverride;
