import { describe, expect, it } from "vitest";

import type { ProviderBillingFact } from "./lifecycle-normalization";
import { applyProviderBillingFact } from "./lifecycle-reducer";

type ProductKind = "PLAN" | "CREDIT_PACK";
type ReducerClient = Parameters<typeof applyProviderBillingFact>[1];

const FACT_DATE = new Date("2026-09-06T00:00:00.000Z");

function billingPlan(productKind: ProductKind = "PLAN") {
	return {
		id: "billing-plan-1",
		provider: "paypal",
		providerPriceId: "paypal-plan-1",
		productKind,
		name: "creator",
		creditsPerPeriod: 700n,
		priceMicros: 19_000_000n,
		currency: "USD",
		active: true,
		version: 1,
		metadata: { planId: "creator", interval: "month", version: 1 },
		createdAt: FACT_DATE,
		updatedAt: FACT_DATE,
	};
}

function checkoutIntent(
	input: {
		productKind?: ProductKind;
		billingPlanProductKind?: ProductKind;
		attribution?: Record<string, unknown> | null;
	} = {},
) {
	return {
		id: "checkout-intent-1",
		provider: "paypal",
		ownerType: "USER" as const,
		ownerId: "user-1",
		submittedByUserId: "user-1",
		productKind: input.productKind ?? "PLAN",
		billingPlanId: "billing-plan-1",
		billingPlan: billingPlan(input.billingPlanProductKind),
		planKey: "creator",
		interval: "month",
		idempotencyKey: "checkout-key-1",
		providerSessionId: "subscription-1",
		providerOrderId: null as string | null,
		providerCheckoutUrl: "https://paypal.example.test/checkout",
		attribution: input.attribution ?? null,
		activeScopeKey: "USER:user-1:PLAN:creator:month",
		creditPackCatalogVersion: null,
		creditPackPricingVersion: null,
		creditPackSubscriberEligibilityVersion: null,
		creditPackBaseCredits: null,
		creditPackBonusCredits: null,
		creditPackTotalCredits: null,
		creditPackExpiryMonths: null,
		creditPackSubscriberBonusEligible: null,
		creditPackSubscriberSubscriptionId: null,
		creditPackSubscriberPlanKey: null,
		creditPackEligibilityEvaluatedAt: null,
		status: "PROVIDER_PENDING" as const,
		expiresAt: new Date("2026-09-06T01:00:00.000Z"),
		createdAt: FACT_DATE,
		updatedAt: FACT_DATE,
	};
}

function purchase(productKind: ProductKind = "PLAN") {
	return {
		id: "purchase-1",
		organizationId: null,
		userId: "user-1",
		type: "SUBSCRIPTION" as const,
		productKind,
		provider: "paypal",
		customerId: "payer-1",
		subscriptionId: "subscription-1",
		priceId: "paypal-plan-1",
		status: "active",
		createdAt: FACT_DATE,
		updatedAt: FACT_DATE,
	};
}

function subscription(
	input: {
		planProductKind?: ProductKind;
		purchaseProductKind?: ProductKind;
	} = {},
) {
	return {
		id: "subscription-row-1",
		ownerType: "USER" as const,
		ownerId: "user-1",
		provider: "paypal",
		providerSubscriptionId: "subscription-1",
		planId: "billing-plan-1",
		purchaseId: "purchase-1",
		status: "ACTIVE" as const,
		currentPeriodStart: null,
		currentPeriodEnd: null,
		cancelAtPeriodEnd: false,
		scheduledPlanId: null,
		lastProviderEventAt: null,
		lastProviderEventId: null,
		lastReconciliationSweepId: null,
		lastReconciliationAppliedSweepId: null,
		lastReconciledAt: null,
		graceEndsAt: null,
		createdAt: FACT_DATE,
		updatedAt: FACT_DATE,
		plan: billingPlan(input.planProductKind),
		purchase: purchase(input.purchaseProductKind),
	};
}

function providerFact(checkoutIntentId: string | null): ProviderBillingFact {
	return {
		provider: "paypal",
		providerEventId: "event-1",
		providerSubscriptionId: "subscription-1",
		checkoutIntentId,
		providerCustomerId: "payer-1",
		status: "ACTIVE",
		cancelAtPeriodEnd: false,
		occurredAt: FACT_DATE,
		currentPeriod: null,
		payment: null,
	};
}

function reducerClient(input: {
	checkout?: ReturnType<typeof checkoutIntent> | null;
	existingSubscription?: ReturnType<typeof subscription> | null;
}) {
	let createdPurchaseData: Record<string, unknown> | null = null;
	const updatedPurchaseData: Record<string, unknown>[] = [];
	let currentSubscription = input.existingSubscription ?? null;
	let currentPurchase = currentSubscription?.purchase ?? purchase();
	const checkout = input.checkout ?? null;

	const client = {
		$queryRaw: async () => [],
		paymentCheckoutIntent: {
			findUnique: async () => checkout,
			updateMany: async () => ({ count: 1 }),
		},
		subscription: {
			findUnique: async () => currentSubscription,
			create: async ({ data }: { data: Record<string, unknown> }) => {
				currentSubscription = {
					...subscription(),
					...data,
					plan: checkout?.billingPlan ?? billingPlan(),
					purchase: currentPurchase,
				};
				return currentSubscription;
			},
			update: async ({ data }: { data: Record<string, unknown> }) => ({
				...currentSubscription!,
				...data,
			}),
		},
		purchase: {
			findUnique: async () => null,
			create: async ({ data }: { data: Record<string, unknown> }) => {
				createdPurchaseData = data;
				currentPurchase = { ...purchase(), ...data };
				return currentPurchase;
			},
			update: async ({ data }: { data: Record<string, unknown> }) => {
				updatedPurchaseData.push(data);
				return { ...currentPurchase, ...data };
			},
		},
		paymentCustomer: {
			findUnique: async () => null,
			create: async ({ data }: { data: Record<string, unknown> }) => data,
		},
	};

	return {
		client: client as unknown as ReducerClient,
		createdPurchase: () => createdPurchaseData,
		updatedPurchases: () => updatedPurchaseData,
	};
}

describe("non-Stripe subscription product-kind isolation", () => {
	it("rejects a Credit Pack checkout intent before it can bind a subscription", async () => {
		const fixture = reducerClient({
			checkout: checkoutIntent({ productKind: "CREDIT_PACK" }),
		});

		await expect(
			applyProviderBillingFact(providerFact("checkout-intent-1"), fixture.client),
		).rejects.toThrow("PAYMENT_PROVIDER_CHECKOUT_PRODUCT_KIND_INVALID");
	});

	it("rejects a Credit Pack BillingPlan referenced by a subscription checkout", async () => {
		const fixture = reducerClient({
			checkout: checkoutIntent({ billingPlanProductKind: "CREDIT_PACK" }),
		});

		await expect(
			applyProviderBillingFact(providerFact("checkout-intent-1"), fixture.client),
		).rejects.toThrow("PAYMENT_PROVIDER_BILLING_PLAN_PRODUCT_KIND_INVALID");
	});

	it("rejects an existing subscription backed by a Credit Pack plan", async () => {
		const fixture = reducerClient({
			existingSubscription: subscription({ planProductKind: "CREDIT_PACK" }),
		});

		await expect(applyProviderBillingFact(providerFact(null), fixture.client)).rejects.toThrow(
			"PAYMENT_PROVIDER_SUBSCRIPTION_PLAN_PRODUCT_KIND_INVALID",
		);
	});

	it("rejects an existing subscription backed by a Credit Pack Purchase", async () => {
		const fixture = reducerClient({
			existingSubscription: subscription({ purchaseProductKind: "CREDIT_PACK" }),
		});

		await expect(applyProviderBillingFact(providerFact(null), fixture.client)).rejects.toThrow(
			"PAYMENT_PROVIDER_SUBSCRIPTION_BINDING_INVALID",
		);
	});

	it("persists a newly bound subscription Purchase explicitly as PLAN", async () => {
		const fixture = reducerClient({ checkout: checkoutIntent() });

		await expect(
			applyProviderBillingFact(providerFact("checkout-intent-1"), fixture.client),
		).resolves.toEqual({ grantsCreated: 0 });
		expect(fixture.createdPurchase()).toMatchObject({
			type: "SUBSCRIPTION",
			productKind: "PLAN",
		});
	});

	it.each(["paypal", "waffo"] as const)(
		"copies %s initial checkout attribution and preserves it through repeat and cancellation facts",
		async (provider) => {
			const attribution = {
				version: 1,
				registration: {
					version: 1,
					landingPath: "/blog/first-visit",
					referrerOrigin: "https://www.google.com",
					source: "referral",
					utmSource: null,
					utmMedium: null,
					utmCampaign: null,
					capturedAt: FACT_DATE.toISOString(),
					registeredAt: FACT_DATE.toISOString(),
				},
				triggerPath: "/blog/portrait-ideas",
				triggeredAt: FACT_DATE.toISOString(),
			};
			const checkout = checkoutIntent({ attribution });
			checkout.provider = provider;
			checkout.billingPlan.provider = provider;
			if (provider === "waffo") checkout.providerOrderId = "subscription-1";
			const fixture = reducerClient({ checkout });
			const fact = {
				...providerFact(checkout.id),
				provider,
				providerCustomerId: provider === "waffo" ? "USER:user-1" : "payer-1",
			};
			await applyProviderBillingFact(fact, fixture.client);
			expect(fixture.createdPurchase()).toMatchObject({ attribution });
			checkout.attribution = { ...attribution, triggerPath: "/pricing" };
			await applyProviderBillingFact(fact, fixture.client);
			await applyProviderBillingFact(
				{
					...fact,
					providerEventId: "event-canceled",
					status: "CANCELED",
					occurredAt: new Date(FACT_DATE.getTime() + 1_000),
				},
				fixture.client,
			);
			expect(fixture.createdPurchase()).toMatchObject({ attribution });
			expect(fixture.updatedPurchases()).not.toHaveLength(0);
			for (const update of fixture.updatedPurchases())
				expect(update).not.toHaveProperty("attribution");
		},
	);

	it("keeps a historical checkout without attribution unknown when creating its Purchase", async () => {
		const fixture = reducerClient({ checkout: checkoutIntent() });
		await applyProviderBillingFact(providerFact("checkout-intent-1"), fixture.client);
		expect(fixture.createdPurchase()?.attribution).toBeUndefined();
	});
});
