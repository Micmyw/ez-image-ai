import {
	claimSubscriptionCompensationOffer,
	dismissSubscriptionCompensationOffer,
	getSubscriptionCompensationOffer,
} from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { toMediaOrpcError } from "../../media/lib/errors";
import { enforceMediaRateLimit } from "../../media/lib/rate-limit";

const result = z.object({
	offer: z
		.object({
			id: z.string(),
			bonusPercent: z.literal(10),
			expiresAt: z.string(),
			dismissed: z.boolean(),
		})
		.nullable(),
});

export const getSubscriptionCompensation = protectedProcedure
	.route({ method: "GET", path: "/payments/subscription-compensation", tags: ["Payments"] })
	.input(z.object({}).strict())
	.output(result)
	.handler(async ({ context }) => {
		context.responseHeaders?.set("Cache-Control", "private, no-store");
		return { offer: await getSubscriptionCompensationOffer(context.user.id, db) };
	});

export const claimSubscriptionCompensation = protectedProcedure
	.route({ method: "POST", path: "/payments/subscription-compensation", tags: ["Payments"] })
	.input(z.object({ assetId: z.uuid() }).strict())
	.output(result)
	.handler(async ({ context, input }) => {
		context.responseHeaders?.set("Cache-Control", "private, no-store");
		try {
			await enforceMediaRateLimit(context.user.id, "payments:compensation");
			return {
				offer: await claimSubscriptionCompensationOffer({ ...input, ownerId: context.user.id }, db),
			};
		} catch (error) {
			throw toMediaOrpcError(error);
		}
	});

export const dismissSubscriptionCompensation = protectedProcedure
	.route({
		method: "POST",
		path: "/payments/subscription-compensation/dismiss",
		tags: ["Payments"],
	})
	.input(z.object({}).strict())
	.output(z.object({ dismissed: z.literal(true) }))
	.handler(async ({ context }) => {
		context.responseHeaders?.set("Cache-Control", "private, no-store");
		await dismissSubscriptionCompensationOffer(context.user.id, db);
		return { dismissed: true as const };
	});
