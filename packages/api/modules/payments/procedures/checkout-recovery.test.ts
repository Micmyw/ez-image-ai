import { beforeEach, describe, expect, it, vi } from "vitest";

const { bindOrder, bindSession, getIntentForOwner, resetProviderCreating, transitionToReview } =
	vi.hoisted(() => ({
		bindOrder: vi.fn(),
		bindSession: vi.fn(),
		getIntentForOwner: vi.fn(),
		resetProviderCreating: vi.fn(),
		transitionToReview: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	bindPaymentCheckoutIntentOrder: bindOrder,
	bindPaymentCheckoutIntentSession: bindSession,
	getPaymentCheckoutIntentForOwner: getIntentForOwner,
	resetPaymentCheckoutIntentProviderCreating: resetProviderCreating,
	transitionPaymentCheckoutIntentToReview: transitionToReview,
}));

import type { PaymentProvider } from "@repo/payments/types";

import { recoverProviderCreatingCheckout } from "./checkout-recovery";

const owner = { ownerType: "USER" as const, ownerId: "user-1" };
const intent = {
	id: "checkout-intent-1",
	provider: "paypal" as const,
	productKind: "CREDIT_PACK" as const,
	status: "PROVIDER_CREATING" as const,
	updatedAt: new Date("2026-09-06T01:00:00.000Z"),
};
const checkoutOptions = {
	type: "one-time" as const,
	priceId: "PROD-CREDITS-1500",
	currency: "USD",
	amountMicros: 59_000_000n,
	description: "EzPic 1,500 Credits",
	billingPlanId: "billing-plan-pack-1",
	checkoutIntentId: intent.id,
	idempotencyKey: "checkout-pack-attempt-1",
	planKey: "credits-1500",
	...owner,
	submittedByUserId: "user-1",
};

function provider(recoverCheckout?: PaymentProvider["recoverCheckout"]): PaymentProvider {
	return {
		name: "paypal",
		capabilities: {
			checkout: true,
			portal: false,
			cancellation: true,
			seatUpdates: false,
			webhooks: true,
		},
		createCheckout: vi.fn(),
		...(recoverCheckout ? { recoverCheckout } : {}),
	};
}

describe("provider-creating checkout recovery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		bindSession.mockResolvedValue({ id: intent.id, status: "PROVIDER_PENDING" });
		bindOrder.mockResolvedValue({ id: intent.id, providerOrderId: "provider-order-1" });
		resetProviderCreating.mockResolvedValue({ count: 1 });
		transitionToReview.mockResolvedValue({ count: 1 });
	});

	it("binds and reuses a checkout authoritatively recovered by the provider", async () => {
		const checkout = {
			checkoutUrl: "https://provider.test/recovered",
			providerSessionId: "provider-session-1",
			expiresAt: new Date("2026-09-06T03:00:00.000Z"),
		};

		await expect(
			recoverProviderCreatingCheckout(
				{
					provider: provider(vi.fn().mockResolvedValue({ status: "FOUND", checkout })),
					owner,
					intent,
					checkoutOptions,
					now: new Date("2026-09-06T02:00:00.000Z"),
				},
				{} as never,
			),
		).resolves.toEqual({ kind: "RECOVERED", checkout });
		expect(bindSession).toHaveBeenCalledWith(
			{
				intentId: intent.id,
				provider: "paypal",
				providerSessionId: "provider-session-1",
				providerCheckoutUrl: "https://provider.test/recovered",
				expiresAt: checkout.expiresAt,
			},
			expect.anything(),
		);
		expect(resetProviderCreating).not.toHaveBeenCalled();
		expect(transitionToReview).not.toHaveBeenCalled();
	});

	it("reuses the exact session when another request won the local bind race", async () => {
		const checkout = {
			checkoutUrl: "https://provider.test/recovered",
			providerSessionId: "provider-session-1",
			expiresAt: new Date("2026-09-06T03:00:00.000Z"),
		};
		bindSession.mockRejectedValue(new Error("PAYMENT_CHECKOUT_INTENT_BINDING_CONFLICT"));
		getIntentForOwner.mockResolvedValue({
			...intent,
			status: "PROVIDER_PENDING",
			providerSessionId: checkout.providerSessionId,
			providerCheckoutUrl: checkout.checkoutUrl,
			expiresAt: checkout.expiresAt,
		});

		await expect(
			recoverProviderCreatingCheckout(
				{
					provider: provider(vi.fn().mockResolvedValue({ status: "FOUND", checkout })),
					owner,
					intent,
					checkoutOptions,
					now: new Date("2026-09-06T02:00:00.000Z"),
				},
				{} as never,
			),
		).resolves.toEqual({ kind: "RECOVERED", checkout });
		expect(transitionToReview).not.toHaveBeenCalled();
	});

	it("moves conflicting provider sessions to REVIEW instead of choosing one", async () => {
		const checkout = {
			checkoutUrl: "https://provider.test/recovered",
			providerSessionId: "provider-session-recovered",
			expiresAt: null,
		};
		bindSession.mockRejectedValue(new Error("PAYMENT_CHECKOUT_INTENT_BINDING_CONFLICT"));
		getIntentForOwner.mockResolvedValue({
			...intent,
			status: "PROVIDER_PENDING",
			providerSessionId: "provider-session-other",
			providerOrderId: "provider-order-other",
			providerCheckoutUrl: "https://provider.test/other",
			expiresAt: null,
		});

		await expect(
			recoverProviderCreatingCheckout(
				{
					provider: provider(vi.fn().mockResolvedValue({ status: "FOUND", checkout })),
					owner,
					intent,
					checkoutOptions,
					now: new Date("2026-09-06T02:00:00.000Z"),
				},
				{} as never,
			),
		).resolves.toEqual({ kind: "REVIEW" });
		expect(transitionToReview).toHaveBeenCalledWith(
			{
				intentId: intent.id,
				provider: "paypal",
				ownerType: "USER",
				ownerId: "user-1",
				expectedStatus: "PROVIDER_PENDING",
				expectedProductKind: "CREDIT_PACK",
				expectedProviderSessionId: "provider-session-other",
				expectedProviderOrderId: "provider-order-other",
			},
			expect.anything(),
		);
	});

	it("allows retry only after an authoritative provider NOT_FOUND result", async () => {
		await expect(
			recoverProviderCreatingCheckout(
				{
					provider: provider(vi.fn().mockResolvedValue({ status: "NOT_FOUND" })),
					owner,
					intent,
					checkoutOptions,
					now: new Date("2026-09-06T02:00:00.000Z"),
				},
				{} as never,
			),
		).resolves.toEqual({ kind: "RETRY" });
		expect(resetProviderCreating).toHaveBeenCalledWith(
			{
				intentId: intent.id,
				provider: "paypal",
				expectedProductKind: "CREDIT_PACK",
				...owner,
			},
			expect.anything(),
		);
		expect(bindSession).not.toHaveBeenCalled();
		expect(transitionToReview).not.toHaveBeenCalled();
	});

	it("moves an unknown provider result to REVIEW without releasing the active scope", async () => {
		await expect(
			recoverProviderCreatingCheckout(
				{
					provider: provider(vi.fn().mockResolvedValue({ status: "UNKNOWN" })),
					owner,
					intent,
					checkoutOptions,
					now: new Date("2026-09-06T02:00:00.000Z"),
				},
				{} as never,
			),
		).resolves.toEqual({ kind: "REVIEW" });
		expect(transitionToReview).toHaveBeenCalledWith(
			{
				intentId: intent.id,
				provider: "paypal",
				expectedStatus: "PROVIDER_CREATING",
				expectedProductKind: "CREDIT_PACK",
				...owner,
			},
			expect.anything(),
		);
		expect(resetProviderCreating).not.toHaveBeenCalled();
	});

	it("binds a Waffo order that cannot resume checkout and then requires review", async () => {
		const waffoProvider = {
			...provider(
				vi.fn().mockResolvedValue({
					status: "FOUND_UNRESUMABLE",
					providerOrderId: "ORD_waffo_1",
				}),
			),
			name: "waffo" as const,
		};
		const waffoIntent = { ...intent, provider: "waffo" as const };

		await expect(
			recoverProviderCreatingCheckout(
				{
					provider: waffoProvider,
					owner,
					intent: waffoIntent,
					checkoutOptions,
					now: new Date("2026-09-06T02:00:00.000Z"),
				},
				{} as never,
			),
		).resolves.toEqual({ kind: "REVIEW" });
		expect(bindOrder).toHaveBeenCalledWith(
			{
				intentId: intent.id,
				provider: "waffo",
				providerOrderId: "ORD_waffo_1",
			},
			expect.anything(),
		);
		expect(transitionToReview).toHaveBeenCalledWith(
			{
				intentId: intent.id,
				provider: "waffo",
				expectedStatus: "PROVIDER_CREATING",
				expectedProductKind: "CREDIT_PACK",
				expectedProviderOrderId: "ORD_waffo_1",
				...owner,
			},
			expect.anything(),
		);
	});

	it("fails closed to review when the provider has no recovery capability", async () => {
		await expect(
			recoverProviderCreatingCheckout(
				{
					provider: provider(),
					owner,
					intent,
					checkoutOptions,
					now: new Date("2026-09-06T02:00:00.000Z"),
				},
				{} as never,
			),
		).resolves.toEqual({ kind: "REVIEW" });
		expect(transitionToReview).toHaveBeenCalledTimes(1);
	});
});
