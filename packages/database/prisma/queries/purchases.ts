import type { z } from "zod";

import { db } from "../client";
import type { PurchaseSchema } from "../zod";

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
	});
}

export async function getPurchasesByUserId(userId: string) {
	return db.purchase.findMany({
		where: {
			userId,
		},
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
	purchase: Omit<z.infer<typeof PurchaseSchema>, "id" | "createdAt" | "updatedAt" | "provider"> & {
		provider?: string;
	},
) {
	const created = await db.purchase.create({
		data: { ...purchase, provider: purchase.provider ?? "stripe" },
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
