import { getPublicCreditPack, type CreditPackKey } from "./credit-packs";

export const CREDIT_PACK_CATALOG_VERSION = "2026-09-06.1";
export const CREDIT_PACK_PRICING_VERSION = "2026-09-06.1";
export const CREDIT_PACK_SUBSCRIBER_ELIGIBILITY_VERSION = "2026-09-06.1";

export const CREDIT_PACK_COST_QUOTE = Object.freeze({
	// All-Standard usage is the current highest conservative cost per credit:
	// ($0.021 * 1.055 * 1.15 + $0.005) / 5 credits, rounded up.
	usdMicrosPerCredit: 6_096,
	basis: "conservative-standard-full-use",
} as const);

export interface CreditPackCheckoutSnapshot {
	catalogVersion: typeof CREDIT_PACK_CATALOG_VERSION;
	pricingVersion: typeof CREDIT_PACK_PRICING_VERSION;
	subscriberEligibilityVersion: typeof CREDIT_PACK_SUBSCRIBER_ELIGIBILITY_VERSION;
	packKey: CreditPackKey;
	baseCredits: number;
	bonusCredits: number;
	totalCredits: number;
	subscriberBonusEligible: boolean;
	subscriberBonusPercent: number;
	priceMicros: number;
	currency: "USD";
	expiryMonths: number;
}

export function createCreditPackCheckoutSnapshot(
	packKey: CreditPackKey,
	subscriberBonusEligible: boolean,
): Readonly<CreditPackCheckoutSnapshot> {
	const pack = getPublicCreditPack(packKey);
	const bonusCredits = subscriberBonusEligible ? pack.subscriberCredits - pack.baseCredits : 0;

	return Object.freeze({
		catalogVersion: CREDIT_PACK_CATALOG_VERSION,
		pricingVersion: CREDIT_PACK_PRICING_VERSION,
		subscriberEligibilityVersion: CREDIT_PACK_SUBSCRIBER_ELIGIBILITY_VERSION,
		packKey: pack.packKey,
		baseCredits: pack.baseCredits,
		bonusCredits,
		totalCredits: pack.baseCredits + bonusCredits,
		subscriberBonusEligible,
		subscriberBonusPercent: pack.subscriberBonusPercent,
		priceMicros: pack.price.amount * 1_000_000,
		currency: pack.price.currency,
		expiryMonths: pack.expiryMonths,
	});
}

export function calculateCreditPackExpiresAt(
	purchasedAt: Date,
	snapshot: Pick<CreditPackCheckoutSnapshot, "expiryMonths">,
): Date {
	if (!(purchasedAt instanceof Date) || !Number.isFinite(purchasedAt.getTime())) {
		throw new TypeError("Credit pack purchase date must be valid");
	}
	if (!Number.isInteger(snapshot.expiryMonths) || snapshot.expiryMonths <= 0) {
		throw new TypeError("Credit pack expiry months must be a positive integer");
	}

	const expiresAt = new Date(purchasedAt);
	const sourceDay = expiresAt.getUTCDate();
	expiresAt.setUTCDate(1);
	expiresAt.setUTCMonth(expiresAt.getUTCMonth() + snapshot.expiryMonths);
	const lastTargetDay = new Date(
		Date.UTC(expiresAt.getUTCFullYear(), expiresAt.getUTCMonth() + 1, 0),
	).getUTCDate();
	expiresAt.setUTCDate(Math.min(sourceDay, lastTargetDay));
	return expiresAt;
}

export interface CreditPackProviderMarginEstimate {
	packKey: CreditPackKey;
	totalCredits: number;
	priceMicros: number;
	estimatedCostMicros: number;
	estimatedMarginBasisPoints: number;
}

export function estimateCreditPackProviderMargin(
	packKey: CreditPackKey,
	subscriberBonusEligible: boolean,
): CreditPackProviderMarginEstimate {
	const snapshot = createCreditPackCheckoutSnapshot(packKey, subscriberBonusEligible);
	const estimatedCostMicros = snapshot.totalCredits * CREDIT_PACK_COST_QUOTE.usdMicrosPerCredit;

	return {
		packKey,
		totalCredits: snapshot.totalCredits,
		priceMicros: snapshot.priceMicros,
		estimatedCostMicros,
		estimatedMarginBasisPoints: Math.round(
			((snapshot.priceMicros - estimatedCostMicros) / snapshot.priceMicros) * 10_000,
		),
	};
}
