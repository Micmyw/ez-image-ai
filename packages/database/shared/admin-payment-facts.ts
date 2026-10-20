/**
 * Payment facts used by administration. BillingPeriod is a projection (an annual
 * charge appears on twelve rows), not a second source of payment timestamps.
 * Only a verified, processed provider receipt can establish historical money.
 */
export interface AdminPaymentPeriodEvidence {
	provider: string;
	providerSubscriptionId: string;
	providerInvoicePaymentId: string | null;
	providerInvoiceId: string | null;
	providerChargeId?: string | null;
	paidAmount: bigint;
}

export interface AdminPaymentEventEvidence {
	provider: string;
	providerEnvironment: string | null;
	verifiedAt: Date | null;
	status: string;
	envelope: unknown;
}

export type AdminConfirmedPaymentEvidence =
	| {
			evidence: "verified";
			amountMicros: bigint;
			currency: string;
			paidAt: Date;
			providerPaymentId: string;
			providerInvoiceId: string | null;
			providerEnvironment: string;
			firstPayment: boolean | null;
	  }
	| { evidence: "unknown"; reason: string };

export function normalizeSubscriptionPaymentEvidence(
	periods: readonly AdminPaymentPeriodEvidence[],
	events: readonly AdminPaymentEventEvidence[],
): AdminConfirmedPaymentEvidence {
	const first = periods[0];
	if (
		!first?.providerInvoicePaymentId ||
		first.paidAmount <= 0n ||
		periods.some(
			(period) =>
				period.provider !== first.provider ||
				period.providerSubscriptionId !== first.providerSubscriptionId ||
				period.providerInvoicePaymentId !== first.providerInvoicePaymentId ||
				period.providerInvoiceId !== first.providerInvoiceId ||
				period.paidAmount !== first.paidAmount,
		)
	)
		return { evidence: "unknown", reason: "PAYMENT_PROJECTION_CONFLICT" };
	const candidates: Array<Extract<AdminConfirmedPaymentEvidence, { evidence: "verified" }>> = [];
	for (const event of events) {
		if (event.provider !== first.provider || !event.verifiedAt || event.status !== "PROCESSED")
			continue;
		const envelope = objectRecord(event.envelope);
		const resource = objectRecord(envelope.resource);
		const data = objectRecord(envelope.data);
		let candidate: Extract<AdminConfirmedPaymentEvidence, { evidence: "verified" }> | null = null;
		try {
			if (
				first.provider === "paypal" &&
				envelope.event_type === "PAYMENT.SALE.COMPLETED" &&
				resource.id === first.providerInvoicePaymentId.replace(/^paypal:/, "") &&
				resource.billing_agreement_id === first.providerSubscriptionId &&
				(event.providerEnvironment === "sandbox" || event.providerEnvironment === "live")
			) {
				const amount = objectRecord(resource.amount);
				candidate = {
					evidence: "verified",
					amountMicros: paymentDecimalMicros(amount.total),
					currency: paymentCurrency(amount.currency),
					paidAt: paymentDate(resource.create_time ?? envelope.create_time),
					providerPaymentId: String(resource.id),
					providerInvoiceId: null,
					providerEnvironment: event.providerEnvironment,
					firstPayment: null,
				};
			} else if (
				first.provider === "waffo" &&
				envelope.eventType === "subscription.payment_succeeded" &&
				data.paymentId === first.providerInvoicePaymentId.replace(/^waffo:/, "") &&
				data.orderId === first.providerSubscriptionId &&
				(event.providerEnvironment === "test" || event.providerEnvironment === "prod") &&
				envelope.mode === event.providerEnvironment
			) {
				candidate = {
					evidence: "verified",
					amountMicros: paymentDecimalMicros(data.amount),
					currency: paymentCurrency(data.currency),
					paidAt: paymentDate(envelope.timestamp),
					providerPaymentId: String(data.paymentId),
					providerInvoiceId: null,
					providerEnvironment: event.providerEnvironment,
					firstPayment: null,
				};
			} else if (first.provider === "stripe" && envelope.type === "invoice.paid") {
				const invoice = objectRecord(data.object);
				const subscription =
					paymentObjectId(
						objectRecord(objectRecord(invoice.parent).subscription_details).subscription,
					) ?? paymentObjectId(invoice.subscription);
				if (invoice.id !== first.providerInvoiceId || subscription !== first.providerSubscriptionId)
					continue;
				if (typeof envelope.livemode !== "boolean") continue;
				const currency = paymentCurrency(invoice.currency);
				const minor = paymentInteger(invoice.amount_paid);
				const paidAt = objectRecord(invoice.status_transitions).paid_at;
				// An event creation timestamp only proves notification time.
				if (typeof paidAt !== "number" || !Number.isSafeInteger(paidAt) || paidAt <= 0) continue;
				if (minor !== first.paidAmount) continue;
				candidate = {
					evidence: "verified",
					amountMicros: stripeMinorToMicros(minor, currency),
					currency,
					paidAt: paymentDate(paidAt * 1_000),
					providerPaymentId: first.providerInvoicePaymentId,
					providerInvoiceId: first.providerInvoiceId,
					providerEnvironment: envelope.livemode ? "live" : "test",
					firstPayment:
						invoice.billing_reason === "subscription_create"
							? true
							: invoice.billing_reason === "subscription_cycle"
								? false
								: null,
				};
			}
		} catch {
			continue;
		}
		if (!candidate) continue;
		if (first.provider !== "stripe" && candidate.amountMicros !== first.paidAmount) continue;
		candidates.push(candidate);
	}
	if (candidates.length === 0)
		return { evidence: "unknown", reason: "VERIFIED_PAYMENT_RECEIPT_MISSING" };
	const candidate = candidates[0]!;
	if (
		candidates.some(
			(item) =>
				item.amountMicros !== candidate.amountMicros ||
				item.currency !== candidate.currency ||
				item.providerEnvironment !== candidate.providerEnvironment ||
				item.paidAt.getTime() !== candidate.paidAt.getTime(),
		)
	)
		return { evidence: "unknown", reason: "VERIFIED_PAYMENT_RECEIPT_CONFLICT" };
	return candidate;
}

export function objectRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function paymentObjectId(value: unknown): string | null {
	if (typeof value === "string" && value.length > 0) return value;
	const id = objectRecord(value).id;
	return typeof id === "string" && id.length > 0 ? id : null;
}

export function paymentCurrency(value: unknown): string {
	if (typeof value !== "string" || !/^[a-zA-Z]{3}$/.test(value))
		throw new Error("PAYMENT_CURRENCY_INVALID");
	return value.toUpperCase();
}

export function paymentDate(value: unknown): Date {
	if (typeof value !== "string" && typeof value !== "number")
		throw new Error("PAYMENT_DATE_INVALID");
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) throw new Error("PAYMENT_DATE_INVALID");
	return date;
}

export function paymentDecimalMicros(value: unknown): bigint {
	if (typeof value !== "string" || !/^\d+(?:\.\d{1,6})?$/.test(value))
		throw new Error("PAYMENT_AMOUNT_INVALID");
	const [whole, fraction = ""] = value.split(".");
	return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function paymentInteger(value: unknown): bigint {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error("PAYMENT_AMOUNT_INVALID");
	return BigInt(value);
}

const STRIPE_ZERO_DECIMAL = new Set([
	"BIF",
	"CLP",
	"DJF",
	"GNF",
	"JPY",
	"KMF",
	"KRW",
	"MGA",
	"PYG",
	"RWF",
	"UGX",
	"VND",
	"VUV",
	"XAF",
	"XOF",
	"XPF",
]);
const STRIPE_THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

export function stripeMinorToMicros(amount: bigint, currency: string): bigint {
	const normalized = paymentCurrency(currency);
	return (
		amount *
		(STRIPE_ZERO_DECIMAL.has(normalized)
			? 1_000_000n
			: STRIPE_THREE_DECIMAL.has(normalized)
				? 1_000n
				: 10_000n)
	);
}

export function microsToStripeMinor(amount: bigint, currency: string): bigint {
	const factor = stripeMinorToMicros(1n, currency);
	if (amount < 0n || amount % factor !== 0n) throw new Error("PAYMENT_AMOUNT_PRECISION_INVALID");
	return amount / factor;
}
