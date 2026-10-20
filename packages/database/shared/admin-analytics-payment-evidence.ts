export interface InitialSubscriptionPaymentEvidence {
	version: 1;
	checkoutIntentId: string;
	periodStart: string;
	periodEnd: string;
	providerPaymentId: string | null;
}
interface Period {
	periodStart: Date;
	periodEnd: Date;
}

export function readInitialSubscriptionPaymentEvidence(
	value: unknown,
): InitialSubscriptionPaymentEvidence | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Record<string, unknown>;
	if (
		candidate.version !== 1 ||
		typeof candidate.checkoutIntentId !== "string" ||
		!candidate.checkoutIntentId ||
		typeof candidate.periodStart !== "string" ||
		typeof candidate.periodEnd !== "string" ||
		!(candidate.providerPaymentId === null || typeof candidate.providerPaymentId === "string")
	)
		return null;
	const start = new Date(candidate.periodStart);
	const end = new Date(candidate.periodEnd);
	if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end)
		return null;
	return {
		version: 1,
		checkoutIntentId: candidate.checkoutIntentId,
		periodStart: start.toISOString(),
		periodEnd: end.toISOString(),
		providerPaymentId: candidate.providerPaymentId,
	};
}

/** Called only under the existing subscription lock and payment transaction.
 * Historical subscriptions with no marker are never backfilled from a later payment.
 */
export function freezeInitialSubscriptionPaymentEvidence(input: {
	existing: unknown;
	subscriptionCreated: boolean;
	checkoutIntentId: string | null;
	initialPeriod: Period | null;
	payment: (Period & { providerPaymentId: string }) | null;
}): InitialSubscriptionPaymentEvidence | null {
	let evidence = readInitialSubscriptionPaymentEvidence(input.existing);
	if (!evidence) {
		if (!input.subscriptionCreated || !input.checkoutIntentId || !input.initialPeriod) return null;
		evidence = {
			version: 1,
			checkoutIntentId: input.checkoutIntentId,
			periodStart: input.initialPeriod.periodStart.toISOString(),
			periodEnd: input.initialPeriod.periodEnd.toISOString(),
			providerPaymentId: null,
		};
	}
	const payment = input.payment;
	if (
		evidence.providerPaymentId ||
		!payment ||
		payment.periodStart.toISOString() !== evidence.periodStart ||
		payment.periodEnd.toISOString() !== evidence.periodEnd
	)
		return evidence;
	return { ...evidence, providerPaymentId: payment.providerPaymentId };
}

/** null means the stored evidence does not establish initial/renewal identity. */
export function classifyInitialSubscriptionPayment(
	value: unknown,
	providerPaymentId: string,
	periodStart?: Date,
): boolean | null {
	const evidence = readInitialSubscriptionPaymentEvidence(value);
	if (!evidence?.providerPaymentId) return null;
	if (providerPaymentId === evidence.providerPaymentId) return true;
	return periodStart && periodStart >= new Date(evidence.periodEnd) ? false : null;
}
