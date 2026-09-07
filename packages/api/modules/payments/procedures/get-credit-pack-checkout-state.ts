import { ORPCError } from "@orpc/server";
import { getPaymentCheckoutIntentForOwner } from "@repo/database";
import { db } from "@repo/database/client";
import { config as paymentsConfig } from "@repo/payments/config";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { verifyOrganizationBillingManagement } from "../../organizations/lib/membership";

const creditPackCheckoutStateSchema = z.enum([
	"PENDING",
	"COMPLETED",
	"REVIEW",
	"EXPIRED",
	"CANCELED",
]);

export const getCreditPackCheckoutState = protectedProcedure
	.route({
		method: "GET",
		path: "/payments/credit-pack-checkout-state",
		tags: ["Payments"],
		summary: "Read credit-pack checkout state",
		description: "Reads owner-scoped processing state without exposing provider product IDs",
	})
	.input(z.object({ intentId: z.string().trim().min(1).max(128) }).strict())
	.output(z.object({ status: creditPackCheckoutStateSchema }))
	.handler(async ({ input, context: { session, user } }) => {
		const owner = await resolveStateOwner(user.id, session.activeOrganizationId);
		const intent = await getPaymentCheckoutIntentForOwner(
			{ intentId: input.intentId, ...owner },
			db,
		);
		if (
			!intent ||
			(intent.provider !== "paypal" && intent.provider !== "waffo") ||
			intent.productKind !== "CREDIT_PACK" ||
			intent.billingPlan.productKind !== "CREDIT_PACK"
		) {
			throw new ORPCError("NOT_FOUND");
		}
		return resolveCreditPackCheckoutState(intent);
	});

export function resolveCreditPackCheckoutState(
	intent: {
		status: string;
		creditPackFulfillment: { id: string } | null;
		expiresAt?: Date | null;
	},
	now = new Date(),
): { status: "PENDING" | "COMPLETED" | "REVIEW" | "EXPIRED" | "CANCELED" } {
	if (intent.status === "COMPLETED" && intent.creditPackFulfillment) {
		return { status: "COMPLETED" };
	}
	if (intent.status === "REVIEW" || intent.status === "EXPIRED" || intent.status === "CANCELED") {
		return { status: intent.status };
	}
	if (intent.expiresAt && intent.expiresAt <= now) return { status: "EXPIRED" };
	return { status: "PENDING" };
}

async function resolveStateOwner(userId: string, activeOrganizationId: string | null | undefined) {
	if (paymentsConfig.billingAttachedTo === "user") {
		return { ownerType: "USER" as const, ownerId: userId };
	}
	if (!activeOrganizationId) throw new ORPCError("FORBIDDEN");
	const membership = await verifyOrganizationBillingManagement(activeOrganizationId, userId);
	if (!membership || membership.organization.id !== activeOrganizationId) {
		throw new ORPCError("FORBIDDEN");
	}
	return { ownerType: "ORGANIZATION" as const, ownerId: activeOrganizationId };
}
