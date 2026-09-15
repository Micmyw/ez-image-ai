import { ORPCError } from "@orpc/server";
import {
	getPaymentCheckoutIntentForOwner,
	closeConfirmedPaymentCheckoutIntent,
} from "@repo/database";
import { db } from "@repo/database/client";
import { getPaymentProvider } from "@repo/payments";
import { config as paymentsConfig } from "@repo/payments/config";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { verifyOrganizationBillingManagement } from "../../organizations/lib/membership";

async function ownerFor(userId: string, organizationId: string | null | undefined) {
	if (paymentsConfig.billingAttachedTo === "organization") {
		if (!organizationId || !(await verifyOrganizationBillingManagement(organizationId, userId)))
			throw new ORPCError("FORBIDDEN");
		return { ownerType: "ORGANIZATION" as const, ownerId: organizationId };
	}
	return { ownerType: "USER" as const, ownerId: userId };
}

export const getPendingSubscriptionCheckout = protectedProcedure
	.route({
		method: "GET",
		path: "/payments/pending-subscription-checkout",
		tags: ["Payments"],
		summary: "Resume an owned unfinished subscription checkout",
	})
	.input(z.object({}).strict())
	.handler(async ({ context: { user, session } }) => {
		const owner = await ownerFor(user.id, session.activeOrganizationId);
		const pending = await db.paymentCheckoutIntent.findFirst({
			where: {
				...owner,
				productKind: "PLAN",
				status: { in: ["CREATED", "PROVIDER_CREATING", "PROVIDER_PENDING", "REVIEW"] },
			},
			orderBy: { createdAt: "desc" },
		});
		if (!pending || (pending.provider !== "paypal" && pending.provider !== "waffo")) return null;
		return {
			id: pending.id,
			provider: pending.provider,
			planId: pending.planKey,
			interval: pending.interval,
			checkoutLink:
				pending.status === "PROVIDER_PENDING" &&
				(!pending.expiresAt || pending.expiresAt > new Date())
					? pending.providerCheckoutUrl
					: null,
		};
	});

export const refreshPendingSubscriptionCheckout = protectedProcedure
	.route({
		method: "POST",
		path: "/payments/pending-subscription-checkout/refresh",
		tags: ["Payments"],
		summary: "Release checkout admission only after confirmed provider closure",
	})
	.input(z.object({ checkoutIntentId: z.string().min(1) }).strict())
	.handler(async ({ input, context: { user, session } }) => {
		const owner = await ownerFor(user.id, session.activeOrganizationId);
		const intent = await getPaymentCheckoutIntentForOwner(
			{ ...owner, intentId: input.checkoutIntentId },
			db,
		);
		if (!intent || intent.productKind !== "PLAN") throw new ORPCError("NOT_FOUND");
		if (intent.status === "CANCELED" || intent.status === "EXPIRED")
			return { status: "CLOSED" as const };
		if (intent.status === "COMPLETED") return { status: "PAID" as const };
		let status: "PENDING" | "PAID" | "CLOSED" | "UNKNOWN" = "UNKNOWN";
		if (intent.status === "CREATED" && !intent.providerSessionId) status = "CLOSED";
		else if (intent.status === "PROVIDER_PENDING" && intent.providerSessionId) {
			const provider = getPaymentProvider(intent.provider);
			if (provider?.inspectCheckout) {
				try {
					status = await provider.inspectCheckout({
						checkoutIntentId: intent.id,
						providerSessionId: intent.providerSessionId,
						priceId: intent.billingPlan.providerPriceId,
						expiresAt: intent.expiresAt,
						now: new Date(),
					});
				} catch {
					status = "UNKNOWN";
				}
			}
		}
		if (status === "CLOSED") {
			const closed = await closeConfirmedPaymentCheckoutIntent(
				{
					...owner,
					id: intent.id,
					expectedStatus: intent.status,
					expectedProviderSessionId: intent.providerSessionId,
					actorUserId: user.id,
				},
				db,
			);
			if (!closed) throw new ORPCError("CONFLICT");
		}
		return { status };
	});
