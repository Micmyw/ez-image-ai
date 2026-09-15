import type { PurchaseSchema } from "@repo/database";
import type { z } from "zod";

import { config } from "../config";
import type { PlanPrice } from "../types";
import type { PlanId } from "./plans";
import { getPlanIdByProviderPriceId, getPlanPriceByProviderPriceId } from "./provider-price-ids";

type PurchaseWithoutTimestamps = Omit<z.infer<typeof PurchaseSchema>, "createdAt" | "updatedAt">;

export interface ResolvedPurchase extends PurchaseWithoutTimestamps {
	planId?: PlanId | null;
	planPrice?: PlanPrice | null;
	isEffectiveSubscription?: boolean;
	subscription?: {
		cancelAtPeriodEnd: boolean;
		currentPeriodEnd: Date | null;
		refundTermination?: "PENDING" | "RETRYING" | "COMPLETED" | null;
		cancellation?: "PENDING" | "RETRYING" | "CONFIRMED" | null;
	} | null;
	providerCapabilities?: {
		portal: boolean;
		cancellation: boolean;
		seatUpdates: boolean;
	};
}

const noManagementCapabilities = {
	portal: false,
	cancellation: false,
	seatUpdates: false,
};

function resolvePurchasePlan(purchase: ResolvedPurchase) {
	if (purchase.productKind !== "PLAN") {
		return null;
	}

	if (purchase.planId && purchase.planPrice) {
		return {
			planId: purchase.planId,
			price: purchase.planPrice,
		};
	}

	const resolvedPrice = getPlanPriceByProviderPriceId(purchase.provider, purchase.priceId);

	if (!resolvedPrice) {
		return null;
	}

	return resolvedPrice;
}

function resolvePurchasePlanId(purchase: ResolvedPurchase) {
	if (purchase.productKind !== "PLAN") {
		return null;
	}

	if (purchase.planId) {
		return purchase.planId;
	}

	return getPlanIdByProviderPriceId(purchase.provider, purchase.priceId);
}

function isBlockingSubscription(purchase: ResolvedPurchase) {
	if (purchase.productKind === "PLAN" && purchase.type === "SUBSCRIPTION") {
		if (purchase.subscription?.refundTermination === "COMPLETED") return false;
		if (purchase.subscription?.refundTermination) return true;
		if (
			["paypal", "waffo"].includes(purchase.provider) &&
			purchase.subscription?.cancellation !== "CONFIRMED"
		)
			return true;
		if (purchase.isEffectiveSubscription === true) return true;
		if (
			["canceled", "cancelled", "expired"].includes(purchase.status?.toLowerCase() ?? "") &&
			purchase.subscription?.currentPeriodEnd &&
			new Date(purchase.subscription.currentPeriodEnd) > new Date()
		)
			return true;
		// A locally expired entitlement does not prove that the provider has
		// stopped recurring charges. Preserve the cancellation entry point.
		if (
			purchase.status?.toLowerCase() === "expired" &&
			purchase.subscription?.cancelAtPeriodEnd === false
		)
			return true;
	}
	return (
		purchase.productKind === "PLAN" &&
		purchase.type === "SUBSCRIPTION" &&
		!["canceled", "cancelled", "expired", "incomplete_expired"].includes(
			purchase.status?.toLowerCase() ?? "active",
		)
	);
}

function getSubscriptionPlans(purchases: ResolvedPurchase[]) {
	return purchases
		.filter(isBlockingSubscription)
		.flatMap((purchase) => {
			const resolvedPrice = resolvePurchasePlan(purchase);
			if (!resolvedPrice || !(resolvedPrice.planId in config.plans)) return [];
			return [
				{
					id: resolvedPrice.planId,
					price: resolvedPrice.price,
					status: purchase.status || "active",
					purchaseId: purchase.id,
					provider: purchase.provider,
					isEffectiveSubscription: purchase.subscription?.refundTermination
						? false
						: purchase.isEffectiveSubscription,
					subscription: purchase.subscription ?? null,
					providerCapabilities: purchase.providerCapabilities ?? noManagementCapabilities,
				},
			];
		})
		.sort(
			(left, right) =>
				Number(right.isEffectiveSubscription === true) -
				Number(left.isEffectiveSubscription === true),
		);
}

function getActivePlanFromPurchases(
	purchases: ResolvedPurchase[],
	subscriptions: ReturnType<typeof getSubscriptionPlans>,
) {
	const activeSubscription =
		subscriptions.find((plan) => plan.isEffectiveSubscription === true) ??
		subscriptions.find(
			(plan) =>
				plan.isEffectiveSubscription === undefined &&
				["active", "trialing", "past_due"].includes(plan.status.toLowerCase()),
		);
	if (activeSubscription) return activeSubscription;

	const oneTimePurchase = purchases?.find(
		(purchase) => purchase.productKind === "PLAN" && purchase.type === "ONE_TIME",
	);

	if (oneTimePurchase) {
		const resolvedPrice = resolvePurchasePlan(oneTimePurchase);

		if (!resolvedPrice || !(resolvedPrice.planId in config.plans)) {
			return null;
		}

		return {
			id: resolvedPrice.planId,
			price: resolvedPrice.price,
			status: "active",
			purchaseId: oneTimePurchase.id,
			subscription: null,
			providerCapabilities: oneTimePurchase.providerCapabilities ?? noManagementCapabilities,
		};
	}

	if (!config.requireActiveSubscription) {
		return {
			id: "free" as PlanId,
			price: undefined,
			subscription: null,
			status: "active",
		};
	}

	return null;
}

export function createPurchasesHelper(purchases: ResolvedPurchase[]) {
	const activeSubscriptions = getSubscriptionPlans(purchases);
	const activePlan = getActivePlanFromPurchases(purchases, activeSubscriptions);
	const hasBlockingSubscription = purchases.some(isBlockingSubscription);

	const hasSubscription = (planIds?: PlanId[] | PlanId) => {
		return (
			!!activePlan &&
			(Array.isArray(planIds) ? planIds.includes(activePlan.id) : planIds === activePlan.id)
		);
	};

	const hasPurchase = (planId: PlanId) => {
		return !!purchases?.some((purchase) => resolvePurchasePlanId(purchase) === planId);
	};

	return { activePlan, activeSubscriptions, hasBlockingSubscription, hasSubscription, hasPurchase };
}
