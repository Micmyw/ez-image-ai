import { randomUUID } from "node:crypto";

import type { PrismaClient } from "../../../generated/client";

/** Isolated database tests only; no provider request or payment event is created. */
export async function withStorageSubscription(
	client: PrismaClient,
	ownerId: string,
	operation: (subscriptionId: string) => Promise<void>,
) {
	const now = new Date();
	const startsAt = new Date(now.getTime() - 60_000);
	const endsAt = new Date(now.getTime() + 3_600_000);
	const plan = await client.billingPlan.create({
		data: {
			provider: "storage-isolated-test",
			providerPriceId: randomUUID(),
			name: "creator",
			creditsPerPeriod: 100n,
			priceMicros: 100n,
			currency: "USD",
			metadata: { planId: "creator" },
		},
	});
	let subscriptionId: string | undefined;
	try {
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "storage-isolated-test",
				providerSubscriptionId: randomUUID(),
				planId: plan.id,
				status: "ACTIVE",
				currentPeriodStart: startsAt,
				currentPeriodEnd: endsAt,
				periods: {
					create: { startsAt, endsAt, status: "ACTIVE", creditAmount: 100n, paidAmount: 100n },
				},
			},
		});
		subscriptionId = subscription.id;
		await operation(subscription.id);
	} finally {
		if (subscriptionId) await client.subscription.delete({ where: { id: subscriptionId } });
		await client.billingPlan.delete({ where: { id: plan.id } });
	}
}
