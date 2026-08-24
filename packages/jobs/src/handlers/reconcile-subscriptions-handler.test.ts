import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	createStripeBillingSource,
	db,
	getStripeClient,
	reconcileStripeBilling,
	reconcileSubscriptionsWithClient,
	source,
	stripe,
} = vi.hoisted(() => ({
	createStripeBillingSource: vi.fn(),
	db: { id: "database" },
	getStripeClient: vi.fn(),
	reconcileStripeBilling: vi.fn(),
	reconcileSubscriptionsWithClient: vi.fn(),
	source: { id: "billing-source" },
	stripe: { id: "stripe-client" },
}));

vi.mock("@repo/database/client", () => ({ db }));
vi.mock("@repo/payments", () => ({
	createStripeBillingSource,
	getStripeClient,
	reconcileStripeBilling,
}));
vi.mock("./reconcile-subscriptions-core", () => ({ reconcileSubscriptionsWithClient }));

import { reconcileSubscriptions } from "./reconcile-subscriptions";

describe("Stripe subscription reconciliation handler", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getStripeClient.mockReturnValue(stripe);
		createStripeBillingSource.mockReturnValue(source);
		reconcileSubscriptionsWithClient.mockResolvedValue({ expired: 2 });
	});

	it("calls the real billing source and closes local deadlines only after a complete sweep", async () => {
		reconcileStripeBilling.mockResolvedValue({
			skipped: false,
			completed: true,
			pagesProcessed: 3,
			issues: 0,
			sweepId: "sweep-1",
		});

		await expect(reconcileSubscriptions({ limit: 25 })).resolves.toMatchObject({
			reconciliation: { completed: true },
			deadlines: { expired: 2 },
		});
		expect(getStripeClient).toHaveBeenCalledOnce();
		expect(createStripeBillingSource).toHaveBeenCalledWith(stripe);
		expect(reconcileStripeBilling).toHaveBeenCalledWith(
			{
				now: undefined,
				pageSize: 50,
				maxPages: 10,
				maxInvoicePaymentLookups: 25,
				leaseSeconds: 120,
				runDeadlineMs: 75_000,
			},
			db,
			source,
		);
		expect(reconcileSubscriptionsWithClient).toHaveBeenCalledWith(
			{ limit: 25, reconciliationSweepId: "sweep-1" },
			db,
		);
	});

	it("does not expire entitlements when the external source fails or the sweep is incomplete", async () => {
		reconcileStripeBilling.mockRejectedValueOnce(new Error("STRIPE_RECONCILIATION_SOURCE_FAILURE"));
		await expect(reconcileSubscriptions({ limit: 25 })).rejects.toThrow(
			"STRIPE_RECONCILIATION_SOURCE_FAILURE",
		);
		expect(reconcileSubscriptionsWithClient).not.toHaveBeenCalled();

		reconcileStripeBilling.mockResolvedValueOnce({
			skipped: false,
			completed: false,
			pagesProcessed: 1,
			issues: 0,
			sweepId: "sweep-2",
			continuationKey: "stripe-reconciliation:sweep-2:continuation:4",
			continuationSequence: 4,
		});
		const scheduleContinuation = vi.fn().mockResolvedValue(undefined);
		await expect(
			reconcileSubscriptions({
				limit: 25,
				expectedSweepId: "sweep-2",
				continuationSequence: 3,
				scheduleContinuation,
			}),
		).resolves.toMatchObject({
			reconciliation: { completed: false },
			deadlines: null,
			continuation: {
				sweepId: "sweep-2",
				continuationKey: "stripe-reconciliation:sweep-2:continuation:4",
				sequence: 4,
			},
		});
		expect(reconcileSubscriptionsWithClient).not.toHaveBeenCalled();
		expect(scheduleContinuation).toHaveBeenCalledWith({
			sweepId: "sweep-2",
			continuationKey: "stripe-reconciliation:sweep-2:continuation:4",
			sequence: 4,
		});
		expect(reconcileStripeBilling).toHaveBeenLastCalledWith(
			expect.objectContaining({
				expectedSweepId: "sweep-2",
				continuationSequence: 3,
			}),
			db,
			source,
		);
	});

	it("propagates continuation enqueue failure so Trigger retries the same checkpoint", async () => {
		reconcileStripeBilling.mockResolvedValue({
			skipped: false,
			completed: false,
			pagesProcessed: 10,
			issues: 0,
			sweepId: "sweep-enqueue-failure",
			continuationKey: "stripe-reconciliation:sweep-enqueue-failure:continuation:8",
			continuationSequence: 8,
		});
		const enqueueFailure = new Error("TRIGGER_CONTINUATION_UNAVAILABLE");
		await expect(
			reconcileSubscriptions({
				scheduleContinuation: vi.fn().mockRejectedValue(enqueueFailure),
			}),
		).rejects.toBe(enqueueFailure);
		expect(reconcileSubscriptionsWithClient).not.toHaveBeenCalled();
	});

	it("does not enqueue when another reconciliation lease is active", async () => {
		reconcileStripeBilling.mockResolvedValue({
			skipped: true,
			reason: "LEASE_ACTIVE",
			completed: false,
			pagesProcessed: 0,
			issues: 0,
		});
		const scheduleContinuation = vi.fn();
		await expect(reconcileSubscriptions({ scheduleContinuation })).resolves.toMatchObject({
			continuation: null,
			deadlines: null,
		});
		expect(scheduleContinuation).not.toHaveBeenCalled();
	});
});
