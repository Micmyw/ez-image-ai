import type { PrismaClient } from "@repo/database/generated-client";

interface ReconcileSubscriptionsClient {
	subscription: Pick<PrismaClient["subscription"], "updateMany">;
	purchase: Pick<PrismaClient["purchase"], "updateMany">;
	billingPeriod: Pick<PrismaClient["billingPeriod"], "updateMany">;
}

export async function reconcileSubscriptionsWithClient(
	input: { now?: Date; limit?: number; reconciliationSweepId?: string },
	client: ReconcileSubscriptionsClient,
) {
	const now = input.now ?? new Date();
	const expired = await client.subscription.updateMany({
		where: {
			...(input.reconciliationSweepId
				? {
						provider: "stripe",
						lastReconciliationAppliedSweepId: input.reconciliationSweepId,
					}
				: {}),
			OR: [
				{ status: "CANCELED", currentPeriodEnd: { lte: now } },
				{ status: "PAST_DUE", graceEndsAt: { lte: now } },
			],
		},
		data: { status: "EXPIRED" },
		limit: input.limit ?? 100,
	});
	await client.purchase.updateMany({
		where: {
			type: "SUBSCRIPTION",
			status: { not: "expired" },
			mediaSubscription: {
				is: {
					provider: "stripe",
					status: "EXPIRED",
				},
			},
		},
		data: { status: "expired" },
		limit: input.limit ?? 100,
	});
	await client.billingPeriod.updateMany({
		where: { status: "ACTIVE", endsAt: { lte: now } },
		data: { status: "CLOSED" },
		limit: input.limit ?? 100,
	});
	return { expired: expired.count };
}
