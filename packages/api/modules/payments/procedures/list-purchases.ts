import { ORPCError } from "@orpc/server";
import { getPurchasesByOrganizationId, getPurchasesByUserId, PurchaseSchema } from "@repo/database";
import {
	getPlanIdByProviderPriceId,
	getPlanPriceByProviderPriceId,
	resolvePaymentProvider,
} from "@repo/payments";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const listPurchases = protectedProcedure
	.route({
		method: "GET",
		path: "/payments/purchases",
		tags: ["Payments"],
		summary: "Get purchases",
		description: "Get all purchases of the current user or the provided organization",
	})
	.input(
		z.object({
			organizationId: z.string().optional(),
		}),
	)
	.output(
		z.array(
			PurchaseSchema.extend({
				planId: z.string().nullable(),
				providerCapabilities: z.object({
					portal: z.boolean(),
					cancellation: z.boolean(),
					seatUpdates: z.boolean(),
				}),
				planPrice: z
					.discriminatedUnion("type", [
						z.object({
							type: z.literal("one-time"),
							amount: z.number(),
							currency: z.string(),
							priceId: z.string().optional(),
						}),
						z.object({
							type: z.literal("subscription"),
							amount: z.number(),
							currency: z.string(),
							priceId: z.string().optional(),
							interval: z.enum(["month", "year"]),
							seatBased: z.boolean().optional(),
							trialPeriodDays: z.number().int().nonnegative().optional(),
						}),
					])
					.nullable(),
			}),
		),
	)
	.handler(async ({ input: { organizationId }, context: { user } }) => {
		if (organizationId) {
			const membership = await verifyOrganizationMembership(organizationId, user.id);

			if (!membership) {
				throw new ORPCError("FORBIDDEN");
			}
		}

		const purchases = organizationId
			? await getPurchasesByOrganizationId(organizationId)
			: await getPurchasesByUserId(user.id);

		return purchases.map((purchase) => ({
			...purchase,
			planId: getPlanIdByProviderPriceId(purchase.provider, purchase.priceId),
			planPrice: getPlanPriceByProviderPriceId(purchase.provider, purchase.priceId)?.price ?? null,
			providerCapabilities: managementCapabilities(purchase.provider),
		}));
	});

function managementCapabilities(provider: string) {
	const capabilities = resolvePaymentProvider(provider)?.capabilities;
	return {
		portal: capabilities?.portal ?? false,
		cancellation: capabilities?.cancellation ?? false,
		seatUpdates: capabilities?.seatUpdates ?? false,
	};
}
