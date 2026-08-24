import { describe, expect, it, vi } from "vitest";

import { reconcileSubscriptionsWithClient } from "./reconcile-subscriptions-core";

describe("subscription deadline reconciliation", () => {
	it("expires cancellation at paid-through and past due at explicit grace deadline", async () => {
		const subscriptionUpdate = vi.fn().mockResolvedValue({ count: 2 });
		const purchaseUpdate = vi.fn().mockResolvedValue({ count: 2 });
		const periodUpdate = vi.fn().mockResolvedValue({ count: 1 });
		const now = new Date("2026-09-01T00:00:00.000Z");
		await reconcileSubscriptionsWithClient({ now }, {
			subscription: { updateMany: subscriptionUpdate as never },
			purchase: { updateMany: purchaseUpdate as never },
			billingPeriod: { updateMany: periodUpdate as never },
		} as never);
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
		expect(purchaseUpdate).toHaveBeenCalledWith({
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
			limit: 100,
		});
	});

	it("expires only subscriptions successfully applied in the completed provider sweep", async () => {
		const subscriptionUpdate = vi.fn().mockResolvedValue({ count: 1 });
		const purchaseUpdate = vi.fn().mockResolvedValue({ count: 1 });
		const periodUpdate = vi.fn().mockResolvedValue({ count: 0 });
		const now = new Date("2026-09-01T00:00:00.000Z");
		await reconcileSubscriptionsWithClient({ now, reconciliationSweepId: "sweep-success-only" }, {
			subscription: { updateMany: subscriptionUpdate as never },
			purchase: { updateMany: purchaseUpdate as never },
			billingPeriod: { updateMany: periodUpdate as never },
		} as never);

		expect(subscriptionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					provider: "stripe",
					lastReconciliationAppliedSweepId: "sweep-success-only",
				}),
			}),
		);
		expect(purchaseUpdate).toHaveBeenCalledWith({
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
			limit: 100,
		});
	});
});
