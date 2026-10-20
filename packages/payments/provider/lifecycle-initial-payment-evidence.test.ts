import { describe, expect, it, vi } from "vitest";

import type { ProviderBillingFact } from "./lifecycle-normalization";
import { applyProviderBillingFact } from "./lifecycle-reducer";

vi.mock("@repo/database", async () => ({
	...(await import("../../database/shared/admin-analytics-payment-evidence")),
	createCreditGrant: vi.fn(),
	isDatabaseUniqueConflict: () => false,
	PAYMENT_PROVIDER_CORRELATION_MISSING: "PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING",
	requeuePaymentEventsMissingCheckoutCorrelation: vi.fn(),
	requeueCreditPackRefundEventsMissingCheckoutCorrelation: vi.fn(),
}));

const start = new Date("2026-10-01T00:00:00Z");
const end = new Date("2026-11-01T00:00:00Z");

function fixture(provider: "paypal" | "waffo", historical = false) {
	const plan = {
		id: "plan",
		providerPriceId: "price",
		productKind: "PLAN",
		priceMicros: 19_000_000n,
		currency: "USD",
		creditsPerPeriod: 100n,
		metadata: { interval: "month" },
	};
	const checkout = {
		id: "checkout",
		provider,
		ownerType: "USER",
		ownerId: "u",
		billingPlanId: "plan",
		billingPlan: plan,
		productKind: "PLAN",
		providerSessionId: "psp-sub",
		providerOrderId: provider === "waffo" ? "psp-sub" : null,
		status: "PROVIDER_PENDING",
		attribution: null,
	};
	let current: Record<string, unknown> | null = historical ? baseSubscription() : null;
	const periods: Record<string, unknown>[] = [];
	function baseSubscription() {
		return {
			id: "sub",
			provider,
			providerSubscriptionId: "psp-sub",
			ownerType: "USER",
			ownerId: "u",
			planId: "plan",
			plan,
			purchaseId: "purchase",
			purchase: {
				id: "purchase",
				provider,
				subscriptionId: "psp-sub",
				customerId: provider === "waffo" ? "USER:u" : "payer",
				productKind: "PLAN",
			},
			currentPeriodStart: start,
			currentPeriodEnd: end,
			initialPaymentEvidence: null,
			lastProviderEventAt: null,
			lastProviderEventId: null,
			renewalDisabledAt: null,
			refundTerminationRequestedAt: null,
		};
	}
	const client = {
		$queryRaw: async () => [],
		paymentCheckoutIntent: {
			findUnique: async () => checkout,
			updateMany: async () => ({ count: 1 }),
		},
		paymentCustomer: { findUnique: async () => null, create: async () => ({}) },
		purchase: {
			findUnique: async () => null,
			create: async () => baseSubscription().purchase,
			update: async () => ({}),
		},
		subscription: {
			findUnique: async () => current,
			create: async ({ data }: { data: Record<string, unknown> }) =>
				(current = { ...baseSubscription(), ...data }),
			update: async ({ data }: { data: Record<string, unknown> }) =>
				(current = { ...current, ...data }),
		},
		billingPeriod: {
			findMany: async ({ where }: { where: { providerInvoicePaymentId: string } }) =>
				periods.filter(
					(period) => period.providerInvoicePaymentId === where.providerInvoicePaymentId,
				),
			findUnique: async ({ where }: { where: { subscriptionId_startsAt: { startsAt: Date } } }) =>
				periods.find(
					(period) =>
						(period.startsAt as Date).getTime() ===
						where.subscriptionId_startsAt.startsAt.getTime(),
				) ?? null,
			create: async ({ data }: { data: Record<string, unknown> }) => {
				const period = { id: `period-${periods.length}`, refundedCredits: 0n, ...data };
				periods.push(period);
				return period;
			},
		},
		creditAccount: { upsert: async () => ({ id: "account" }) },
		creditLedgerEntry: { findUnique: async () => null },
	};
	const fact: ProviderBillingFact = {
		provider,
		providerSubscriptionId: "psp-sub",
		providerEventId: "activation",
		checkoutIntentId: "checkout",
		providerCustomerId: provider === "waffo" ? "USER:u" : "payer",
		status: "ACTIVE",
		cancelAtPeriodEnd: false,
		occurredAt: start,
		currentPeriod: { periodStart: start, periodEnd: end },
		payment: null,
	};
	return {
		client: client as unknown as Parameters<typeof applyProviderBillingFact>[1],
		fact,
		subscription: () => current,
	};
}

describe("provider reducer persists first-checkout evidence atomically", () => {
	it.each(["paypal", "waffo"] as const)(
		"freezes %s first payment and preserves it on renewal",
		async (provider) => {
			const state = fixture(provider);
			await applyProviderBillingFact(state.fact, state.client);
			expect(state.subscription()?.initialPaymentEvidence).toMatchObject({
				checkoutIntentId: "checkout",
				providerPaymentId: null,
			});
			const firstPaid = {
				...state.fact,
				currentPeriod: null,
				providerEventId: "first-paid",
				occurredAt: new Date(start.getTime() + 1_000),
				payment: {
					providerPaymentId: "first-payment",
					amountMicros: 19_000_000n,
					currency: "USD",
					periodStart: start,
					periodEnd: end,
				},
			};
			await applyProviderBillingFact(firstPaid, state.client);
			const frozen = state.subscription()?.initialPaymentEvidence;
			expect(frozen).toMatchObject({
				providerPaymentId: "first-payment",
				periodStart: start.toISOString(),
				periodEnd: end.toISOString(),
			});
			await applyProviderBillingFact(
				{
					...firstPaid,
					providerEventId: "renewal",
					occurredAt: new Date("2026-11-01T00:00:01Z"),
					payment: {
						...firstPaid.payment,
						providerPaymentId: "renewal-payment",
						periodStart: end,
						periodEnd: new Date("2026-12-01T00:00:00Z"),
					},
				},
				state.client,
			);
			expect(state.subscription()?.initialPaymentEvidence).toEqual(frozen);
		},
	);
	it("does not claim first-payment provenance for an old subscription", async () => {
		const state = fixture("paypal", true);
		await applyProviderBillingFact(
			{
				...state.fact,
				providerEventId: "historical-paid",
				payment: {
					providerPaymentId: "possibly-renewal",
					amountMicros: 19_000_000n,
					currency: "USD",
					periodStart: start,
					periodEnd: end,
				},
			},
			state.client,
		);
		expect(state.subscription()?.initialPaymentEvidence).toBeNull();
	});
});
