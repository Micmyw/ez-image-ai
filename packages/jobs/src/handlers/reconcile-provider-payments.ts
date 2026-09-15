import { db } from "@repo/database/client";
import {
	getPaymentProvider,
	isPaymentProviderConfigured,
	paymentReconciliationScope,
	reconcileProviderPaymentEvents,
} from "@repo/payments";

export type ScheduleProviderReconciliation = (
	provider: "paypal" | "waffo",
	continuationKey: string,
) => Promise<void>;

export async function reconcileProviderPayments(input: {
	provider: "paypal" | "waffo";
	now?: Date;
	scheduleNext: ScheduleProviderReconciliation;
}) {
	if (!isPaymentProviderConfigured(input.provider))
		return { skipped: true, completed: false, recovered: 0 };
	const source = getPaymentProvider(input.provider)?.listPaymentEvents;
	if (!source) throw new Error("PAYMENT_RECONCILIATION_UNAVAILABLE");
	const result = await reconcileProviderPaymentEvents(
		{ provider: input.provider, scope: paymentReconciliationScope(input.provider), now: input.now },
		db,
		source,
	);
	if (!result.skipped && !result.completed) {
		if (!result.continuationKey) throw new Error("PAYMENT_RECONCILIATION_CONTINUATION_MISSING");
		await input.scheduleNext(input.provider, result.continuationKey);
	}
	return result;
}
