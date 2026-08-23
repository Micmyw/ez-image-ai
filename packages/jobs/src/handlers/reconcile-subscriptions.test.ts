import { describe, expect, it, vi } from "vitest";

import { reconcileSubscriptionsWithClient } from "./reconcile-subscriptions-core";

describe("subscription deadline reconciliation", () => {
	it("expires cancellation at paid-through and past due at explicit grace deadline", async () => {
		const subscriptionUpdate = vi.fn().mockResolvedValue({ count: 2 });
		const periodUpdate = vi.fn().mockResolvedValue({ count: 1 });
		const now = new Date("2026-09-01T00:00:00.000Z");
		await reconcileSubscriptionsWithClient(
			{ now },
			{
				subscription: { updateMany: subscriptionUpdate as never },
				billingPeriod: { updateMany: periodUpdate as never },
			},
		);
		expect(subscriptionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					OR: [
						{ status: "CANCELED", currentPeriodEnd: { lte: now } },
						{ status: "PAST_DUE", graceEndsAt: { lte: now } },
					],
				},
			}),
		);
	});
});
