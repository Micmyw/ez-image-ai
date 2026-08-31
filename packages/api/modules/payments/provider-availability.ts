import { getPlanEntitlement, resolvePlanEntitlement } from "@repo/config";
import { findPriceByPlanId, paymentProviderNames, resolvePaymentProvider } from "@repo/payments";
import type { PaymentProviderName } from "@repo/payments/types";

export interface PaymentAvailabilitySelection {
	planId: "creator" | "studio";
	interval: "month" | "year";
}

interface BillingPlanSnapshot {
	id: string;
	provider: string;
	providerPriceId: string;
	active: boolean;
	name: string;
	creditsPerPeriod: bigint;
	priceMicros: bigint;
	currency: string;
	metadata: unknown;
}

interface PaymentAvailabilityDependencies {
	isConfigured(provider: PaymentProviderName): boolean;
	getProviderPriceId(provider: PaymentProviderName): string | null;
	findBillingPlan(
		provider: PaymentProviderName,
		providerPriceId: string,
	): Promise<BillingPlanSnapshot | null>;
}

export async function resolveProviderAvailability(
	selection: PaymentAvailabilitySelection,
	dependencies: PaymentAvailabilityDependencies,
) {
	const price = findPriceByPlanId(selection.planId, {
		type: "subscription",
		interval: selection.interval,
	});
	if (!price) return [];

	const available = [];
	for (const provider of paymentProviderNames) {
		if (!dependencies.isConfigured(provider)) continue;
		const providerPriceId = dependencies.getProviderPriceId(provider);
		if (!providerPriceId) continue;
		const billingPlan = await dependencies.findBillingPlan(provider, providerPriceId);
		if (!isExactBillingPlanSnapshot(billingPlan, provider, providerPriceId, selection)) continue;
		const definition = resolvePaymentProvider(provider);
		if (definition) available.push(definition);
	}
	return available;
}

export function isExactBillingPlanSnapshot(
	billingPlan: BillingPlanSnapshot | null,
	provider: PaymentProviderName,
	providerPriceId: string,
	selection: PaymentAvailabilitySelection,
): billingPlan is BillingPlanSnapshot {
	if (!billingPlan?.active) return false;
	const price = findPriceByPlanId(selection.planId, {
		type: "subscription",
		interval: selection.interval,
	});
	if (!price) return false;
	const entitlement = getPlanEntitlement(selection.planId);
	let resolvedPlanId: string;
	try {
		resolvedPlanId = resolvePlanEntitlement(billingPlan.metadata, billingPlan.name).id;
	} catch {
		return false;
	}
	return (
		billingPlan.provider === provider &&
		billingPlan.providerPriceId === providerPriceId &&
		resolvedPlanId === selection.planId &&
		metadataString(billingPlan.metadata, "interval") === selection.interval &&
		billingPlan.creditsPerPeriod === BigInt(entitlement.monthlyCredits) &&
		billingPlan.priceMicros === BigInt(Math.round(price.amount * 1_000_000)) &&
		billingPlan.currency === price.currency
	);
}

function metadataString(value: unknown, key: string): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = (value as Record<string, unknown>)[key];
	return typeof candidate === "string" ? candidate : null;
}
