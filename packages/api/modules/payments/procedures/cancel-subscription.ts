import { ORPCError } from "@orpc/server";
import { getOrganizationMembership, getPurchaseById } from "@repo/database";
import { logger } from "@repo/logs";
import { getPaymentProvider } from "@repo/payments";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";

export const cancelPurchaseSubscription = protectedProcedure
	.route({
		method: "POST",
		path: "/payments/cancel-subscription",
		tags: ["Payments"],
		summary: "Cancel an owned subscription through its provider",
	})
	.input(z.object({ purchaseId: z.string().min(1) }).strict())
	.output(z.object({ status: z.literal("CANCEL_REQUESTED") }))
	.handler(async ({ input, context: { user } }) => {
		const purchase = await getPurchaseById(input.purchaseId);
		if (!purchase?.subscriptionId) throw new ORPCError("NOT_FOUND");
		await assertPurchaseOwner(purchase, user.id);

		const provider = getPaymentProvider(purchase.provider);
		if (!provider?.capabilities.cancellation || !provider.cancelSubscription) {
			throw new ORPCError("BAD_REQUEST");
		}
		try {
			await provider.cancelSubscription(purchase.subscriptionId);
			return { status: "CANCEL_REQUESTED" as const };
		} catch {
			logger.error(
				{ provider: purchase.provider, purchaseId: purchase.id },
				"Could not cancel subscription",
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR");
		}
	});

async function assertPurchaseOwner(
	purchase: { organizationId: string | null; userId: string | null },
	userId: string,
): Promise<void> {
	const hasOrganizationOwner = purchase.organizationId !== null;
	const hasUserOwner = purchase.userId !== null;
	if (hasOrganizationOwner === hasUserOwner) throw new ORPCError("NOT_FOUND");
	if (hasUserOwner && purchase.userId !== userId) throw new ORPCError("NOT_FOUND");
	if (hasOrganizationOwner) {
		const membership = await getOrganizationMembership(purchase.organizationId!, userId);
		if (membership?.role !== "owner") throw new ORPCError("NOT_FOUND");
	}
}
