import { describe, expect, it } from "vitest";

import type { StripePaidInvoiceFact, StripeSubscriptionFact } from "./normalization";
import { applyStripeBillingFact } from "./reducer";

type ProductKind = "PLAN" | "CREDIT_PACK";
type ReducerClient = Parameters<typeof applyStripeBillingFact>[1];

const PERIOD_START = new Date("2027-01-01T00:00:00.000Z");
const PERIOD_END = new Date("2027-02-01T00:00:00.000Z");

function billingPlan(
	input: {
		id?: string;
		priceId?: string;
		productKind?: ProductKind;
	} = {},
) {
	return {
		id: input.id ?? "stripe-plan-1",
		provider: "stripe",
		providerPriceId: input.priceId ?? "stripe-price-1",
		productKind: input.productKind ?? "PLAN",
		name: "creator",
		creditsPerPeriod: 700n,
		priceMicros: 19_000_000n,
		currency: "USD",
		active: true,
		version: 1,
		metadata: { planId: "creator", interval: "month", version: 1 },
		createdAt: PERIOD_START,
		updatedAt: PERIOD_START,
	};
}

function purchase(productKind: ProductKind = "PLAN") {
	return {
		id: "stripe-purchase-1",
		organizationId: null,
		userId: "user-1",
		type: "SUBSCRIPTION" as const,
		productKind,
		provider: "stripe",
		customerId: "stripe-customer-1",
		subscriptionId: "stripe-subscription-1",
		priceId: "stripe-price-1",
		status: "active",
		createdAt: PERIOD_START,
		updatedAt: PERIOD_START,
	};
}

function subscription(
	input: {
		planProductKind?: ProductKind;
		purchaseProductKind?: ProductKind;
		scheduledPlanId?: string | null;
	} = {},
) {
	return {
		id: "stripe-subscription-row-1",
		ownerType: "USER" as const,
		ownerId: "user-1",
		provider: "stripe",
		providerSubscriptionId: "stripe-subscription-1",
		planId: "stripe-plan-1",
		purchaseId: "stripe-purchase-1",
		status: "ACTIVE" as const,
		currentPeriodStart: PERIOD_START,
		currentPeriodEnd: PERIOD_END,
		cancelAtPeriodEnd: false,
		scheduledPlanId: input.scheduledPlanId ?? null,
		lastProviderEventAt: null,
		lastProviderEventId: null,
		lastReconciliationSweepId: null,
		lastReconciliationAppliedSweepId: null,
		lastReconciledAt: null,
		graceEndsAt: null,
		createdAt: PERIOD_START,
		updatedAt: PERIOD_START,
		plan: billingPlan({ productKind: input.planProductKind }),
		purchase: purchase(input.purchaseProductKind),
	};
}

function subscriptionFact(
	input: {
		priceId?: string;
		binding?: StripeSubscriptionFact["binding"];
	} = {},
): StripeSubscriptionFact {
	return {
		kind: "SUBSCRIPTION",
		providerSubscriptionId: "stripe-subscription-1",
		customerId: "stripe-customer-1",
		status: "ACTIVE",
		cancelAtPeriodEnd: false,
		currentPeriodStart: PERIOD_START,
		currentPeriodEnd: PERIOD_END,
		priceId: input.priceId ?? "stripe-price-1",
		binding: input.binding === undefined ? null : input.binding,
		context: {
			origin: "WEBHOOK",
			changeAt: new Date("2027-01-01T00:00:01.000Z"),
			changeId: "stripe-event-1",
		},
	};
}

function paidInvoiceFact(priceId = "stripe-price-1"): StripePaidInvoiceFact {
	return {
		kind: "PAID_INVOICE",
		billingReason: "SUBSCRIPTION_CYCLE",
		providerInvoiceId: "stripe-invoice-1",
		providerSubscriptionId: "stripe-subscription-1",
		customerId: "stripe-customer-1",
		providerInvoicePaymentId: "stripe-invoice-payment-1",
		providerChargeId: "stripe-charge-1",
		providerPaymentIntentId: "stripe-payment-intent-1",
		priceId,
		amountPaid: 19_000_000n,
		currency: "USD",
		periodStart: PERIOD_START,
		periodEnd: PERIOD_END,
		context: {
			origin: "WEBHOOK",
			changeAt: new Date("2027-01-01T00:00:01.000Z"),
			changeId: "stripe-invoice-event-1",
		},
	};
}

function reducerClient(input: {
	existingSubscription?: ReturnType<typeof subscription> | null;
	lookupPlan?: ReturnType<typeof billingPlan> | null;
	scheduledPlan?: ReturnType<typeof billingPlan> | null;
	existingPurchase?: ReturnType<typeof purchase> | null;
}) {
	let createdPurchaseData: Record<string, unknown> | null = null;
	let currentSubscription = input.existingSubscription ?? null;
	let currentPurchase = input.existingPurchase ?? currentSubscription?.purchase ?? null;
	const lookupPlan = input.lookupPlan ?? billingPlan();

	const client = {
		$queryRaw: async () => [],
		subscription: {
			findUnique: async () => currentSubscription,
			findMany: async () => (currentSubscription ? [currentSubscription] : []),
			create: async ({ data }: { data: Record<string, unknown> }) => {
				currentSubscription = {
					...subscription(),
					...data,
					plan: lookupPlan,
					purchase: currentPurchase ?? purchase(),
				};
				return currentSubscription;
			},
			update: async ({ data }: { data: Record<string, unknown> }) => ({
				...currentSubscription!,
				...data,
			}),
		},
		billingPlan: {
			findUnique: async ({ where }: { where: Record<string, unknown> }) =>
				"id" in where && where.id === currentSubscription?.scheduledPlanId
					? (input.scheduledPlan ?? null)
					: lookupPlan,
		},
		purchase: {
			findUnique: async () => input.existingPurchase ?? null,
			create: async ({ data }: { data: Record<string, unknown> }) => {
				createdPurchaseData = data;
				currentPurchase = { ...purchase(), ...data };
				return currentPurchase;
			},
			update: async ({ data }: { data: Record<string, unknown> }) => ({
				...currentPurchase!,
				...data,
			}),
		},
		user: {
			findUnique: async () => ({ paymentsCustomerId: "stripe-customer-1" }),
			findFirst: async () => null,
			updateMany: async () => ({ count: 1 }),
		},
		organization: {
			findUnique: async () => null,
			findFirst: async () => null,
			updateMany: async () => ({ count: 1 }),
		},
		billingPeriod: {
			findUnique: async () => null,
			create: async ({ data }: { data: Record<string, unknown> }) => ({
				id: "stripe-period-1",
				...data,
			}),
		},
		auditLog: {
			create: async ({ data }: { data: Record<string, unknown> }) => data,
		},
	};

	return {
		client: client as unknown as ReducerClient,
		createdPurchase: () => createdPurchaseData,
	};
}

describe("Stripe subscription product-kind isolation", () => {
	it("rejects a Credit Pack plan already bound to a subscription", async () => {
		const fixture = reducerClient({
			existingSubscription: subscription({ planProductKind: "CREDIT_PACK" }),
		});

		await expect(applyStripeBillingFact(subscriptionFact(), fixture.client)).rejects.toThrow(
			"STRIPE_SUBSCRIPTION_PLAN_UNMAPPED",
		);
	});

	it("rejects a Credit Pack Purchase already bound to a subscription", async () => {
		const fixture = reducerClient({
			existingSubscription: subscription({ purchaseProductKind: "CREDIT_PACK" }),
		});

		await expect(applyStripeBillingFact(subscriptionFact(), fixture.client)).rejects.toThrow(
			"STRIPE_SUBSCRIPTION_PURCHASE_BINDING_INVALID",
		);
	});

	it("rejects a Credit Pack plan before scheduling a subscription plan change", async () => {
		const fixture = reducerClient({
			existingSubscription: subscription(),
			lookupPlan: billingPlan({
				id: "stripe-credit-pack-plan",
				priceId: "stripe-credit-pack-price",
				productKind: "CREDIT_PACK",
			}),
		});

		await expect(
			applyStripeBillingFact(
				subscriptionFact({ priceId: "stripe-credit-pack-price" }),
				fixture.client,
			),
		).rejects.toThrow("STRIPE_SUBSCRIPTION_PLAN_UNMAPPED");
	});

	it("rejects an existing scheduled plan that resolves to a Credit Pack", async () => {
		const fixture = reducerClient({
			existingSubscription: subscription({ scheduledPlanId: "stripe-credit-pack-plan" }),
			lookupPlan: billingPlan(),
			scheduledPlan: billingPlan({
				id: "stripe-credit-pack-plan",
				priceId: "stripe-credit-pack-price",
				productKind: "CREDIT_PACK",
			}),
		});

		await expect(applyStripeBillingFact(subscriptionFact(), fixture.client)).rejects.toThrow(
			"STRIPE_SUBSCRIPTION_PLAN_UNMAPPED",
		);
	});

	it("rejects a Credit Pack BillingPlan carried by a new checkout binding", async () => {
		const creditPackPlan = billingPlan({ productKind: "CREDIT_PACK" });
		const fixture = reducerClient({ existingSubscription: null, lookupPlan: creditPackPlan });

		await expect(
			applyStripeBillingFact(
				subscriptionFact({
					binding: {
						billingPlanId: creditPackPlan.id,
						planKey: "creator",
						ownerType: "USER",
						ownerId: "user-1",
						submittedByUserId: "user-1",
					},
				}),
				fixture.client,
			),
		).rejects.toThrow("STRIPE_BILLING_PLAN_BINDING_INVALID");
	});

	it("rejects a Credit Pack BillingPlan resolved from a paid invoice price", async () => {
		const fixture = reducerClient({
			existingSubscription: subscription(),
			lookupPlan: billingPlan({ productKind: "CREDIT_PACK" }),
		});

		await expect(
			applyStripeBillingFact(paidInvoiceFact(), fixture.client, {
				now: new Date("2026-12-01T00:00:00.000Z"),
			}),
		).rejects.toThrow("STRIPE_INVOICE_PLAN_UNMAPPED");
	});

	it("rejects a paid invoice whose existing subscription plan is a Credit Pack", async () => {
		const fixture = reducerClient({
			existingSubscription: subscription({ planProductKind: "CREDIT_PACK" }),
			lookupPlan: billingPlan(),
		});

		await expect(
			applyStripeBillingFact(paidInvoiceFact(), fixture.client, {
				now: new Date("2026-12-01T00:00:00.000Z"),
			}),
		).rejects.toThrow("STRIPE_SUBSCRIPTION_PLAN_UNMAPPED");
	});

	it("rejects a paid invoice when its existing scheduled plan is a Credit Pack", async () => {
		const fixture = reducerClient({
			existingSubscription: subscription({ scheduledPlanId: "stripe-credit-pack-plan" }),
			lookupPlan: billingPlan(),
			scheduledPlan: billingPlan({
				id: "stripe-credit-pack-plan",
				priceId: "stripe-credit-pack-price",
				productKind: "CREDIT_PACK",
			}),
		});

		await expect(
			applyStripeBillingFact(paidInvoiceFact(), fixture.client, {
				now: new Date("2026-12-01T00:00:00.000Z"),
			}),
		).rejects.toThrow("STRIPE_SUBSCRIPTION_PLAN_UNMAPPED");
	});

	it("rejects a Credit Pack Purchase on the failed-invoice entry point", async () => {
		const fixture = reducerClient({
			existingSubscription: subscription({ purchaseProductKind: "CREDIT_PACK" }),
		});

		await expect(
			applyStripeBillingFact(
				{
					kind: "INVOICE_PAYMENT_FAILED",
					providerInvoiceId: "stripe-invoice-1",
					providerSubscriptionId: "stripe-subscription-1",
					customerId: "stripe-customer-1",
					context: {
						origin: "WEBHOOK",
						changeAt: new Date("2027-01-01T00:00:01.000Z"),
						changeId: "stripe-failed-invoice-event-1",
					},
				},
				fixture.client,
			),
		).rejects.toThrow("STRIPE_SUBSCRIPTION_PURCHASE_BINDING_INVALID");
	});

	it("persists a newly bound subscription Purchase explicitly as PLAN", async () => {
		const plan = billingPlan();
		const fixture = reducerClient({ existingSubscription: null, lookupPlan: plan });

		await expect(
			applyStripeBillingFact(
				subscriptionFact({
					binding: {
						billingPlanId: plan.id,
						planKey: "creator",
						ownerType: "USER",
						ownerId: "user-1",
						submittedByUserId: "user-1",
					},
				}),
				fixture.client,
			),
		).resolves.toEqual({ grantsCreated: 0 });
		expect(fixture.createdPurchase()).toMatchObject({
			type: "SUBSCRIPTION",
			productKind: "PLAN",
		});
	});
});
