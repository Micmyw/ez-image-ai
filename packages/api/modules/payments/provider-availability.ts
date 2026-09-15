import {
	type CreditPackKey,
	BILLING_PRICING_VERSION,
	getPlanEntitlement,
	resolvePlanEntitlement,
} from "@repo/config";
import { createCreditPackCheckoutSnapshot } from "@repo/config/server";
import { findPriceByPlanId, resolvePaymentProvider } from "@repo/payments";
import type { PaymentProviderName } from "@repo/payments/types";

import { isNewBillingEnabled } from "./billing-gate";

type CheckoutPaymentProviderName = Extract<PaymentProviderName, "paypal" | "waffo">;
const checkoutPaymentProviderNames = [
	"paypal",
	"waffo",
] as const satisfies readonly CheckoutPaymentProviderName[];

export interface PaymentAvailabilitySelection {
	planId: "creator" | "ultimate" | "studio";
	interval: "month" | "year";
}

export interface CreditPackAvailabilitySelection {
	packKey: CreditPackKey;
}

// BillingPlan rows are immutable snapshots. A newly provisioned provider price gets a new row at
// version 1; any row mutation or older pricing cohort must remain unavailable to new checkout.
const BILLING_PLAN_SNAPSHOT_VERSION = 1;

interface BillingPlanSnapshot {
	id: string;
	provider: string;
	providerPriceId: string;
	productKind: "PLAN" | "CREDIT_PACK";
	active: boolean;
	version: number;
	name: string;
	creditsPerPeriod: bigint;
	priceMicros: bigint;
	currency: string;
	metadata: unknown;
}

interface CreditPackAvailabilityDependencies {
	isConfigured(provider: Extract<PaymentProviderName, "paypal" | "waffo">): boolean;
	getProviderProductId(provider: Extract<PaymentProviderName, "paypal" | "waffo">): string | null;
	findBillingPlan(
		provider: Extract<PaymentProviderName, "paypal" | "waffo">,
		providerProductId: string,
	): Promise<BillingPlanSnapshot | null>;
}

interface PaymentAvailabilityDependencies {
	isConfigured(provider: CheckoutPaymentProviderName): boolean;
	getProviderPriceId(provider: CheckoutPaymentProviderName): string | null;
	findBillingPlan(
		provider: CheckoutPaymentProviderName,
		providerPriceId: string,
	): Promise<BillingPlanSnapshot | null>;
}

export async function resolveProviderAvailability(
	selection: PaymentAvailabilitySelection,
	dependencies: PaymentAvailabilityDependencies,
) {
	if (!isNewBillingEnabled()) return [];
	const price = findPriceByPlanId(selection.planId, {
		type: "subscription",
		interval: selection.interval,
	});
	if (!price) return [];

	const available = [];
	for (const provider of checkoutPaymentProviderNames) {
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

export async function resolveCreditPackProviderAvailability(
	selection: CreditPackAvailabilitySelection,
	dependencies: CreditPackAvailabilityDependencies,
) {
	if (!isNewBillingEnabled()) return [];
	const available = [];
	for (const provider of checkoutPaymentProviderNames) {
		if (!dependencies.isConfigured(provider)) continue;
		const providerProductId = dependencies.getProviderProductId(provider);
		if (!providerProductId) continue;
		const billingPlan = await dependencies.findBillingPlan(provider, providerProductId);
		if (
			!isExactCreditPackBillingPlanSnapshot(billingPlan, provider, providerProductId, selection)
		) {
			continue;
		}
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
		isBillingPlanEnvironmentCompatible(billingPlan.metadata, provider) &&
		billingPlan.provider === provider &&
		billingPlan.providerPriceId === providerPriceId &&
		billingPlan.productKind === "PLAN" &&
		billingPlan.version === BILLING_PLAN_SNAPSHOT_VERSION &&
		metadataInteger(billingPlan.metadata, "version") === billingPlan.version &&
		isCompatibleBillingPricingVersion(billingPlan.metadata) &&
		resolvedPlanId === selection.planId &&
		metadataString(billingPlan.metadata, "interval") === selection.interval &&
		billingPlan.creditsPerPeriod === BigInt(entitlement.monthlyCredits) &&
		billingPlan.priceMicros === BigInt(Math.round(price.amount * 1_000_000)) &&
		billingPlan.currency === price.currency
	);
}

function isCompatibleBillingPricingVersion(metadata: unknown): boolean {
	const version = metadataString(metadata, "billingPricingVersion");
	if (version !== null) return version === BILLING_PRICING_VERSION;
	// Existing immutable rows used the image version. Keep them usable only when
	// every monetary/allowance/product field above still exactly matches.
	return /^\d{4}-\d{2}-\d{2}\.\d+$/.test(metadataString(metadata, "pricingVersion") ?? "");
}

export function isExactCreditPackBillingPlanSnapshot(
	billingPlan: BillingPlanSnapshot | null,
	provider: Extract<PaymentProviderName, "paypal" | "waffo">,
	providerProductId: string,
	selection: CreditPackAvailabilitySelection,
): billingPlan is BillingPlanSnapshot {
	if (!billingPlan?.active || billingPlan.productKind !== "CREDIT_PACK") return false;
	const snapshot = createCreditPackCheckoutSnapshot(selection.packKey, false);
	return (
		isBillingPlanEnvironmentCompatible(billingPlan.metadata, provider) &&
		billingPlan.provider === provider &&
		billingPlan.providerPriceId === providerProductId &&
		billingPlan.version === BILLING_PLAN_SNAPSHOT_VERSION &&
		billingPlan.name === selection.packKey &&
		billingPlan.creditsPerPeriod === BigInt(snapshot.baseCredits) &&
		billingPlan.priceMicros === BigInt(snapshot.priceMicros) &&
		billingPlan.currency === snapshot.currency &&
		metadataInteger(billingPlan.metadata, "version") === billingPlan.version &&
		metadataString(billingPlan.metadata, "productKind") === "CREDIT_PACK" &&
		metadataString(billingPlan.metadata, "packKey") === selection.packKey &&
		metadataString(billingPlan.metadata, "catalogVersion") === snapshot.catalogVersion &&
		metadataString(billingPlan.metadata, "pricingVersion") === snapshot.pricingVersion &&
		metadataInteger(billingPlan.metadata, "expiryMonths") === snapshot.expiryMonths
	);
}

export function isBillingPlanEnvironmentCompatible(
	metadata: unknown,
	provider: PaymentProviderName,
): boolean {
	if (provider === "stripe") return true;
	const configured =
		process.env[provider === "paypal" ? "PAYPAL_ENVIRONMENT" : "WAFFO_ENVIRONMENT"];
	const recorded = metadataString(metadata, "providerEnvironment");
	// Legacy sandbox snapshots can still service existing test integrations.
	// Every live snapshot must explicitly belong to that provider environment.
	if (configured === "live" || configured === "prod") return recorded === configured;
	return recorded === null || recorded === configured;
}

function metadataInteger(value: unknown, key: string): number | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = (value as Record<string, unknown>)[key];
	return typeof candidate === "number" && Number.isInteger(candidate) ? candidate : null;
}

function metadataString(value: unknown, key: string): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = (value as Record<string, unknown>)[key];
	return typeof candidate === "string" ? candidate : null;
}
