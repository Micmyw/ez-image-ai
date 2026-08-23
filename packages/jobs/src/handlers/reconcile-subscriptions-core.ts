import type { PrismaClient } from "@repo/database/generated-client";

interface ReconcileSubscriptionsClient {
	subscription: Pick<PrismaClient["subscription"], "updateMany">;
	billingPeriod: Pick<PrismaClient["billingPeriod"], "updateMany">;
}

export async function reconcileSubscriptionsWithClient(
	input: { now?: Date; limit?: number },
	client: ReconcileSubscriptionsClient,
) {
	const now = input.now ?? new Date();
	const expired = await client.subscription.updateMany({
		where: {
			OR: [
				{ status: "CANCELED", currentPeriodEnd: { lte: now } },
				{ status: "PAST_DUE", graceEndsAt: { lte: now } },
			],
		},
		data: { status: "EXPIRED" },
		limit: input.limit ?? 100,
	});
	await client.billingPeriod.updateMany({
		where: { status: "ACTIVE", endsAt: { lte: now } },
		data: { status: "CLOSED" },
		limit: input.limit ?? 100,
	});
	return { expired: expired.count };
}
