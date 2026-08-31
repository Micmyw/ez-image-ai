import type { PaymentProviderName, PlanPrice } from "../types";
import { findPriceByPlanId, type PlanId, type RecurringInterval } from "./plans";

interface ProviderPriceMappingEntry {
	provider: PaymentProviderName;
	planId: PlanId;
	type: PlanPrice["type"];
	interval: RecurringInterval;
	environmentKey: string;
}

const providerPriceMappings: ProviderPriceMappingEntry[] = (["creator", "studio"] as const).flatMap(
	(planId) =>
		(["month", "year"] as const).flatMap((interval) =>
			(["stripe", "paypal", "waffo"] as const).map((provider) => ({
				provider,
				planId,
				type: "subscription" as const,
				interval,
				environmentKey: providerEnvironmentKey(provider, planId, interval),
			})),
		),
);

const providerIdPatterns: Record<PaymentProviderName, RegExp> = {
	stripe: /^price_[A-Za-z0-9_]+$/,
	paypal: /^P-[A-Z0-9-]+$/,
	waffo: /^PROD_[A-Za-z0-9]+$/,
};

export function getProviderPriceIdByPlanId(
	provider: PaymentProviderName,
	planId: PlanId,
	selection: {
		type: PlanPrice["type"];
		interval?: RecurringInterval;
	},
) {
	const price = findPriceByPlanId(planId, selection);

	if (!price) {
		return null;
	}

	const environmentKey = providerPriceMappings.find(
		(entry) =>
			entry.provider === provider &&
			entry.planId === planId &&
			entry.type === selection.type &&
			entry.interval === selection.interval,
	)?.environmentKey;
	const candidate = environmentKey ? process.env[environmentKey]?.trim() : undefined;
	return candidate && providerIdPatterns[provider].test(candidate) ? candidate : null;
}

export function getPlanIdByProviderPriceId(priceId: string): PlanId | null;
export function getPlanIdByProviderPriceId(provider: string, priceId: string): PlanId | null;
export function getPlanIdByProviderPriceId(providerOrPriceId: string, priceId?: string) {
	const provider = priceId ? providerOrPriceId : "stripe";
	const resolvedPriceId = priceId ?? providerOrPriceId;
	if (!isProviderName(provider)) return null;
	return findMapping(provider, resolvedPriceId)?.planId ?? null;
}

export function getPlanPriceByProviderPriceId(priceId: string): {
	planId: PlanId;
	price: PlanPrice;
} | null;
export function getPlanPriceByProviderPriceId(
	provider: string,
	priceId: string,
): { planId: PlanId; price: PlanPrice } | null;
export function getPlanPriceByProviderPriceId(providerOrPriceId: string, priceId?: string) {
	const provider = priceId ? providerOrPriceId : "stripe";
	const resolvedPriceId = priceId ?? providerOrPriceId;
	if (!isProviderName(provider)) return null;
	const mapping = findMapping(provider, resolvedPriceId);

	if (!mapping) {
		return null;
	}

	const price = findPriceByPlanId(mapping.planId, {
		type: mapping.type,
		interval: mapping.interval,
	});

	if (!price) {
		return null;
	}

	return {
		planId: mapping.planId,
		price,
	};
}

function isProviderName(value: string): value is PaymentProviderName {
	return value === "stripe" || value === "paypal" || value === "waffo";
}

function findMapping(provider: PaymentProviderName, priceId: string) {
	if (!providerIdPatterns[provider].test(priceId)) return undefined;
	return providerPriceMappings.find(
		(entry) => entry.provider === provider && process.env[entry.environmentKey]?.trim() === priceId,
	);
}

function providerEnvironmentKey(
	provider: PaymentProviderName,
	planId: "creator" | "studio",
	interval: RecurringInterval,
): string {
	const prefix =
		provider === "stripe"
			? "PRICE_ID"
			: provider === "paypal"
				? "PAYPAL_PLAN_ID"
				: "WAFFO_PRODUCT_ID";
	return `${prefix}_${planId.toUpperCase()}_${interval === "month" ? "MONTHLY" : "YEARLY"}`;
}
