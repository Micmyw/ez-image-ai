import { getStripeLegacyLifecycleStatus } from "@repo/config/server";
import { db } from "@repo/database/client";
import { createStripeBillingSource, getStripeClient, reconcileStripeBilling } from "@repo/payments";

import { reconcileSubscriptionsWithClient } from "./reconcile-subscriptions-core";

export interface StripeReconciliationContinuation {
	sweepId: string;
	continuationKey: string;
	sequence: number;
}

export async function reconcileSubscriptions(
	input: {
		now?: Date;
		limit?: number;
		expectedSweepId?: string;
		continuationSequence?: number;
		scheduleContinuation?: (continuation: StripeReconciliationContinuation) => Promise<void>;
	} = {},
) {
	const stripeLegacyLifecycleStatus = getStripeLegacyLifecycleStatus({
		STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
		STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
	});
	if (stripeLegacyLifecycleStatus === "INCOMPLETE") {
		throw new Error("STRIPE_LEGACY_LIFECYCLE_INCOMPLETE");
	}
	if (stripeLegacyLifecycleStatus === "DISABLED") {
		const deadlines = await reconcileSubscriptionsWithClient(
			{
				...(input.now ? { now: input.now } : {}),
				...(input.limit === undefined ? {} : { limit: input.limit }),
				providerNames: ["paypal", "waffo"],
			},
			db,
		);
		return {
			reconciliation: {
				skipped: true,
				reason: `STRIPE_LEGACY_LIFECYCLE_${stripeLegacyLifecycleStatus}`,
			},
			deadlines,
			continuation: null,
		};
	}

	const source = createStripeBillingSource(getStripeClient());
	const reconciliation = await reconcileStripeBilling(
		{
			now: input.now,
			pageSize: 50,
			maxPages: 10,
			maxInvoicePaymentLookups: 25,
			leaseSeconds: 120,
			runDeadlineMs: 75_000,
			expectedSweepId: input.expectedSweepId,
			continuationSequence: input.continuationSequence,
		},
		db,
		source,
	);
	const deadlines = reconciliation.completed
		? await reconcileSubscriptionsWithClient(
				{ ...input, reconciliationSweepId: reconciliation.sweepId },
				db,
			)
		: null;
	let continuation: StripeReconciliationContinuation | null = null;
	if (!reconciliation.skipped && !reconciliation.completed) {
		continuation = {
			sweepId: reconciliation.sweepId,
			continuationKey: reconciliation.continuationKey,
			sequence: reconciliation.continuationSequence,
		};
		if (!input.scheduleContinuation) {
			throw new Error("STRIPE_RECONCILIATION_CONTINUATION_UNAVAILABLE");
		}
		await input.scheduleContinuation(continuation);
	}
	return { reconciliation, deadlines, continuation };
}
