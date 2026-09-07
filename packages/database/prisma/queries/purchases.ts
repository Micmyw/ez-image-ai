import type { z } from "zod";

import { db } from "../client";
import type { PurchaseSchema } from "../zod";

const billingPlanForPurchase = {
	mediaSubscription: {
		select: {
			ownerType: true,
			ownerId: true,
			provider: true,
			plan: {
				select: {
					provider: true,
					priceMicros: true,
					currency: true,
					metadata: true,
				},
			},
		},
	},
} as const;

export async function getPurchaseById(id: string) {
	return db.purchase.findUnique({
		where: { id },
	});
}

export async function getPurchasesByOrganizationId(organizationId: string) {
	return db.purchase.findMany({
		where: {
			organizationId,
		},
		include: billingPlanForPurchase,
	});
}

export async function getPurchasesByUserId(userId: string) {
	return db.purchase.findMany({
		where: {
			userId,
		},
		include: billingPlanForPurchase,
	});
}

export async function getPurchaseBySubscriptionId(subscriptionId: string, provider = "stripe") {
	return db.purchase.findFirst({
		where: {
			provider,
			subscriptionId,
		},
	});
}

export async function createPurchase(
	purchase: Omit<
		z.infer<typeof PurchaseSchema>,
		"id" | "createdAt" | "updatedAt" | "provider" | "productKind"
	> & {
		provider?: string;
		productKind?: "PLAN" | "CREDIT_PACK";
	},
) {
	const created = await db.purchase.create({
		data: {
			...purchase,
			provider: purchase.provider ?? "stripe",
			productKind: purchase.productKind ?? "PLAN",
		},
	});

	return getPurchaseById(created.id);
}

export async function updatePurchase(
	purchase: Partial<Omit<z.infer<typeof PurchaseSchema>, "createdAt" | "updatedAt">> & {
		id: string;
	},
) {
	const updated = await db.purchase.update({
		where: {
			id: purchase.id,
		},
		data: purchase,
	});

	return getPurchaseById(updated.id);
}

export async function deletePurchaseBySubscriptionId(subscriptionId: string, provider = "stripe") {
	await db.purchase.delete({
		where: { provider_subscriptionId: { provider, subscriptionId } },
	});
}
