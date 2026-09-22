import { ORPCError } from "@orpc/server";
import {
	getPaymentCheckoutIntentById,
	resolveCheckoutReview,
	canReviewLegacyCheckout,
	readCheckoutRecovery,
	checkoutRecoveryStatusSchema,
	type RecoverableCheckout,
} from "@repo/database";
import { db } from "@repo/database/client";
import { inspectPayPalCheckoutReview } from "@repo/payments";
import { z } from "zod";

import { adminProcedure } from "../../../orpc/procedures";

const lookupSchema = z.object({ checkoutIntentId: z.string().trim().min(1).max(128) }).strict();
const viewSchema = z.object({
	id: z.string(),
	ownerType: z.enum(["USER", "ORGANIZATION"]),
	ownerId: z.string(),
	planId: z.string(),
	interval: z.string(),
	status: z.string(),
	recoveryStatus: checkoutRecoveryStatusSchema,
	updatedAt: z.string().nullable(),
	canReview: z.boolean(),
	resolvedAt: z.string().nullable(),
});
function view(intent: RecoverableCheckout) {
	const state = readCheckoutRecovery(intent.checkoutRecovery);
	return {
		id: intent.id,
		ownerType: intent.ownerType,
		ownerId: intent.ownerId,
		planId: intent.planKey,
		interval: intent.interval,
		status: intent.status,
		recoveryStatus: state.status,
		updatedAt: intent.updatedAt?.toISOString() ?? null,
		canReview: canReviewLegacyCheckout(intent),
		resolvedAt: state.resolution?.resolvedAt ?? null,
	};
}
async function find(id: string) {
	const intent = await getPaymentCheckoutIntentById(id, db);
	if (!intent || intent.provider !== "paypal" || intent.productKind !== "PLAN")
		throw new ORPCError("NOT_FOUND");
	return intent;
}
export const getAdminCheckoutReview = adminProcedure
	.route({
		method: "GET",
		path: "/admin/payments/checkout-review",
		tags: ["Admin", "Payments"],
		summary: "Read a PayPal checkout review snapshot",
	})
	.input(lookupSchema)
	.output(viewSchema)
	.handler(async ({ input }) => view(await find(input.checkoutIntentId)));

export const resolveAdminCheckoutReview = adminProcedure
	.route({
		method: "POST",
		path: "/admin/payments/checkout-review/resolve",
		tags: ["Admin", "Payments"],
		summary: "Record an audited decision to close an unapproved legacy checkout",
	})
	.input(
		lookupSchema
			.extend({
				expectedUpdatedAt: z.iso.datetime(),
				operationKey: z.string().trim().min(8).max(128),
				reason: z.string().trim().min(10).max(500),
				evidenceReference: z.string().trim().min(10).max(500),
				customerConfirmedNoApproval: z.literal(true),
				merchantRecordsReviewed: z.literal(true),
			})
			.strict(),
	)
	.output(viewSchema)
	.handler(async ({ input, context: { user } }) => {
		try {
			const intent = await find(input.checkoutIntentId);
			const replay =
				intent.status === "CANCELED" && readCheckoutRecovery(intent.checkoutRecovery).resolution;
			if (!replay) {
				if (intent.updatedAt.toISOString() !== input.expectedUpdatedAt)
					throw new Error("CHECKOUT_REVIEW_STALE");
				if (!canReviewLegacyCheckout(intent)) throw new Error("CHECKOUT_REVIEW_NOT_ELIGIBLE");
			}
			const providerObservation = replay ? undefined : await inspectPayPalCheckoutReview(intent);
			const { checkoutIntentId, ...decision } = input;
			return view(
				await resolveCheckoutReview(
					{
						...decision,
						id: checkoutIntentId,
						actorUserId: user.id,
						providerObservation,
					},
					db,
				),
			);
		} catch (error) {
			if (error instanceof ORPCError) throw error;
			const message = error instanceof Error ? error.message : "";
			if (message === "CHECKOUT_NOT_FOUND") throw new ORPCError("NOT_FOUND");
			if (
				[
					"CHECKOUT_REVIEW_STALE",
					"CHECKOUT_REVIEW_NOT_ELIGIBLE",
					"CHECKOUT_REVIEW_FINANCIAL_ACTIVITY",
					"CHECKOUT_REVIEW_PROVENANCE_UNCONFIRMED",
				].includes(message)
			)
				throw new ORPCError("CONFLICT", { message, data: { code: message } });
			if (message === "CHECKOUT_REVIEW_EVIDENCE_REQUIRED")
				throw new ORPCError("BAD_REQUEST", { message, data: { code: message } });
			if (message === "CHECKOUT_REVIEW_PROVIDER_UNCONFIRMED")
				throw new ORPCError("SERVICE_UNAVAILABLE", { message, data: { code: message } });
			throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "CHECKOUT_REVIEW_FAILED" });
		}
	});
