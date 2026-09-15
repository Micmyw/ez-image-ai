import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import { db } from "../client";
import { purchase } from "../schema/postgres";
import type { PurchaseInsertSchema, PurchaseUpdateSchema } from "../zod";

const billingPlanForPurchase = {
	mediaSubscription: {
		columns: {
			id: true,
			status: true,
			ownerType: true,
			ownerId: true,
			provider: true,
			cancelAtPeriodEnd: true,
			cancellationRequestedAt: true,
			renewalDisabledAt: true,
			cancellationError: true,
			currentPeriodEnd: true,
			refundTerminationRequestedAt: true,
			refundTerminatedAt: true,
			refundTerminationError: true,
		},
		with: {
			plan: { columns: { provider: true, priceMicros: true, currency: true, metadata: true } },
		},
	},
} as const;

export async function getPurchasesByOrganizationId(organizationId: string) {
	return db.query.purchase.findMany({
		where: (purchase, { eq }) => eq(purchase.organizationId, organizationId),
		with: billingPlanForPurchase,
	});
}

export async function getPurchasesByUserId(userId: string) {
	return db.query.purchase.findMany({
		where: (purchase, { eq }) => eq(purchase.userId, userId),
		with: billingPlanForPurchase,
	});
}

export async function getPurchaseById(id: string) {
	return db.query.purchase.findFirst({
		where: (purchase, { eq }) => eq(purchase.id, id),
	});
}

export async function getPurchaseBySubscriptionId(subscriptionId: string, provider = "stripe") {
	return db.query.purchase.findFirst({
		where: (purchase, { eq, and }) =>
			and(eq(purchase.provider, provider), eq(purchase.subscriptionId, subscriptionId)),
	});
}

export async function createPurchase(insertedPurchase: z.infer<typeof PurchaseInsertSchema>) {
	const [{ id }] = await db
		.insert(purchase)
		.values(insertedPurchase)
		.returning({ id: purchase.id });

	return getPurchaseById(id);
}

export async function updatePurchase(updatedPurchase: z.infer<typeof PurchaseUpdateSchema>) {
	const [{ id }] = await db.update(purchase).set(updatedPurchase).returning({ id: purchase.id });

	return getPurchaseById(id);
}

export async function deletePurchaseBySubscriptionId(subscriptionId: string, provider = "stripe") {
	await db
		.delete(purchase)
		.where(and(eq(purchase.provider, provider), eq(purchase.subscriptionId, subscriptionId)));
}
