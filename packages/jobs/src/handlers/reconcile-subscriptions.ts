import { getStripeLegacyLifecycleStatus } from "@repo/config/server";
import { db } from "@repo/database/client";
import {
	createStripeBillingSource,
	getStripeClient,
	reconcileStripeBilling,
	getPaymentProvider,
	isPaymentProviderConfigured,
	paymentReconciliationScope,
	reconcileProviderPaymentEvents,
	recoverRefundTerminations,
	recoverSubscriptionCancellations,
} from "@repo/payments";
import { requeuePreviouslyUnsupportedRefunds } from "@repo/payments";

import type { ScheduleProviderReconciliation } from "./reconcile-provider-payments";
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
		scheduleProviderReconciliation?: ScheduleProviderReconciliation;
		scheduleContinuation?: (continuation: StripeReconciliationContinuation) => Promise<void>;
	} = {},
) {
	const providerReconciliation = [];
	const providerErrors: unknown[] = [];
	await requeuePreviouslyUnsupportedRefunds(db);
	await recoverRefundTerminations(db);
	await recoverSubscriptionCancellations(db, input.limit);
	for (const provider of ["paypal", "waffo"] as const) {
		if (!isPaymentProviderConfigured(provider)) continue;
		try {
			if (input.scheduleProviderReconciliation) {
				const hour = Math.floor((input.now ?? new Date()).getTime() / 3600000);
				await input.scheduleProviderReconciliation(
					provider,
					`payment-backfill-start:${paymentReconciliationScope(provider)}:${hour}`,
				);
				continue;
			}
			const adapter = getPaymentProvider(provider);
			if (!adapter?.listPaymentEvents) throw new Error("PAYMENT_RECONCILIATION_UNAVAILABLE");
			providerReconciliation.push(
				await reconcileProviderPaymentEvents(
					{ provider, scope: paymentReconciliationScope(provider), now: input.now },
					db,
					adapter.listPaymentEvents,
				),
			);
		} catch (error) {
			providerErrors.push(error);
		}
	}
	// Enforce local paid-through deadlines even if a provider API is unavailable.
	const providerDeadlines = await reconcileSubscriptionsWithClient(
		{ now: input.now, limit: input.limit, providerNames: ["paypal", "waffo"] },
		db,
	);
	const stripeLegacyLifecycleStatus = getStripeLegacyLifecycleStatus({
		STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
		STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
	});
	if (stripeLegacyLifecycleStatus === "INCOMPLETE") {
		throw new Error("STRIPE_LEGACY_LIFECYCLE_INCOMPLETE");
	}
	if (stripeLegacyLifecycleStatus === "DISABLED") {
		if (providerErrors.length)
			throw new AggregateError(providerErrors, "PAYMENT_RECONCILIATION_FAILED");
		const deadlines = providerDeadlines;
		return {
			reconciliation: {
				skipped: true,
				reason: `STRIPE_LEGACY_LIFECYCLE_${stripeLegacyLifecycleStatus}`,
			},
			deadlines,
			providerReconciliation,
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
	if (providerErrors.length)
		throw new AggregateError(providerErrors, "PAYMENT_RECONCILIATION_FAILED");
	return { reconciliation, deadlines, continuation, providerReconciliation, providerDeadlines };
}
