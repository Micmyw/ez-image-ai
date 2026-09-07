import { call } from "@orpc/server";
import type { Session } from "@repo/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	bindCheckoutIntent,
	bindCheckoutIntentOrder,
	createCheckoutIntent,
	findBillingPlan,
	findEffectivePaidSubscription,
	getPaymentCheckoutIntentForOwner,
	getPaymentCheckoutIntentForOwnerByIdempotencyKey,
	getPaymentCustomer,
	getPaymentProvider,
	getProviderProductId,
	isExactCreditPackBillingPlanSnapshot,
	isPaymentProviderConfigured,
	markCheckoutIntentProviderCreating,
	paymentsConfig,
	providerCheckout,
	providerRecoverCheckout,
	resetCheckoutIntentProviderCreating,
	transitionCheckoutIntentToReview,
	verifyOrganizationBillingManagement,
} = vi.hoisted(() => ({
	bindCheckoutIntent: vi.fn(),
	bindCheckoutIntentOrder: vi.fn(),
	createCheckoutIntent: vi.fn(),
	findBillingPlan: vi.fn(),
	findEffectivePaidSubscription: vi.fn(),
	getPaymentCheckoutIntentForOwner: vi.fn(),
	getPaymentCheckoutIntentForOwnerByIdempotencyKey: vi.fn(),
	getPaymentCustomer: vi.fn(),
	getPaymentProvider: vi.fn(),
	getProviderProductId: vi.fn(),
	isExactCreditPackBillingPlanSnapshot: vi.fn(),
	isPaymentProviderConfigured: vi.fn(),
	markCheckoutIntentProviderCreating: vi.fn(),
	paymentsConfig: { billingAttachedTo: "user" as "user" | "organization" },
	providerCheckout: vi.fn(),
	providerRecoverCheckout: vi.fn(),
	resetCheckoutIntentProviderCreating: vi.fn(),
	transitionCheckoutIntentToReview: vi.fn(),
	verifyOrganizationBillingManagement: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	bindPaymentCheckoutIntentOrder: bindCheckoutIntentOrder,
	bindPaymentCheckoutIntentSession: bindCheckoutIntent,
	createPaymentCheckoutIntent: createCheckoutIntent,
	findEffectivePaidSubscription,
	getPaymentCheckoutIntentForOwner,
	getPaymentCheckoutIntentForOwnerByIdempotencyKey,
	getPaymentCustomer,
	markPaymentCheckoutIntentProviderCreating: markCheckoutIntentProviderCreating,
	resetPaymentCheckoutIntentProviderCreating: resetCheckoutIntentProviderCreating,
	transitionPaymentCheckoutIntentToReview: transitionCheckoutIntentToReview,
}));
vi.mock("@repo/database/client", () => ({
	db: { billingPlan: { findUnique: findBillingPlan } },
}));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));
vi.mock("@repo/payments", () => ({
	getCreditPackProviderProductId: getProviderProductId,
	getPaymentProvider,
	isPaymentProviderConfigured,
}));
vi.mock("@repo/payments/config", () => ({ config: paymentsConfig }));
vi.mock("../provider-availability", () => ({ isExactCreditPackBillingPlanSnapshot }));
vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationBillingManagement,
}));

import { auth } from "@repo/auth";

import {
	createCreditPackCheckout,
	creditPackCheckoutInputSchema,
} from "./create-credit-pack-checkout";

const authenticatedSession = {
	session: {
		id: "session-1",
		createdAt: new Date("2026-09-01T00:00:00.000Z"),
		updatedAt: new Date("2026-09-01T00:00:00.000Z"),
		userId: "user-1",
		expiresAt: new Date("2027-09-01T00:00:00.000Z"),
		token: "session-token",
		ipAddress: null,
		userAgent: null,
		impersonatedBy: null,
		activeOrganizationId: null,
	},
	user: {
		id: "user-1",
		name: "Test User",
		email: "test@example.com",
		emailVerified: true,
		image: null,
		createdAt: new Date("2026-09-01T00:00:00.000Z"),
		updatedAt: new Date("2026-09-01T00:00:00.000Z"),
		role: "user",
		banned: null,
		banReason: null,
		banExpires: null,
		onboardingComplete: true,
		locale: null,
		twoFactorEnabled: false,
		lastActiveOrganizationId: null,
		isAnonymous: false,
	},
} satisfies Session;

const billingPlan = {
	id: "billing-plan-paypal-credits-1500",
	provider: "paypal",
	providerPriceId: "PROD-CREDITS-1500",
	productKind: "CREDIT_PACK" as const,
	active: true,
	version: 1,
	name: "credits-1500",
	creditsPerPeriod: 1_500n,
	priceMicros: 59_000_000n,
	currency: "USD",
	metadata: {},
};

describe("createCreditPackCheckout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-06T08:30:00.000Z"));
		vi.clearAllMocks();
		paymentsConfig.billingAttachedTo = "user";
		process.env.NEXT_PUBLIC_SAAS_URL = "https://app.ezpic.test";
		vi.mocked(auth.api.getSession).mockResolvedValue(authenticatedSession);
		isPaymentProviderConfigured.mockReturnValue(true);
		getProviderProductId.mockReturnValue("PROD-CREDITS-1500");
		findBillingPlan.mockResolvedValue(billingPlan);
		isExactCreditPackBillingPlanSnapshot.mockReturnValue(true);
		findEffectivePaidSubscription.mockResolvedValue({
			id: "subscription-ultimate",
			ownerType: "USER",
			ownerId: "user-1",
			status: "ACTIVE",
			graceEndsAt: null,
			plan: { metadata: { planId: "ultimate" }, name: "ultimate" },
		});
		getPaymentCustomer.mockResolvedValue(null);
		getPaymentCheckoutIntentForOwnerByIdempotencyKey.mockResolvedValue(null);
		createCheckoutIntent.mockResolvedValue({
			intent: {
				id: "credit-pack-intent-1",
				status: "CREATED",
				providerSessionId: null,
				providerCheckoutUrl: null,
			},
			replayed: false,
		});
		getPaymentCheckoutIntentForOwner.mockResolvedValue({
			id: "credit-pack-intent-1",
			idempotencyKey: "credit-pack-checkout-0001",
			provider: "paypal",
			status: "CREATED",
			submittedByUserId: "user-1",
			productKind: "CREDIT_PACK",
			billingPlanId: billingPlan.id,
			planKey: "credits-1500",
			interval: "one-time",
			creditPackCatalogVersion: "2026-09-06.1",
			creditPackPricingVersion: "2026-09-06.1",
			creditPackSubscriberEligibilityVersion: "2026-09-06.1",
			creditPackBaseCredits: 1_500n,
			creditPackBonusCredits: 300n,
			creditPackTotalCredits: 1_800n,
			creditPackExpiryMonths: 6,
			creditPackSubscriberBonusEligible: true,
			creditPackSubscriberSubscriptionId: "subscription-ultimate",
			creditPackSubscriberPlanKey: "ultimate",
			creditPackEligibilityEvaluatedAt: new Date("2026-09-06T08:30:00.000Z"),
			billingPlan,
			creditPackFulfillment: null,
		});
		markCheckoutIntentProviderCreating.mockResolvedValue({
			id: "credit-pack-intent-1",
			status: "PROVIDER_CREATING",
		});
		providerCheckout.mockResolvedValue({
			checkoutUrl: "https://www.sandbox.paypal.com/approve",
			providerSessionId: "PAYPAL-ORDER-1",
			expiresAt: null,
		});
		providerRecoverCheckout.mockResolvedValue({ status: "UNKNOWN" });
		resetCheckoutIntentProviderCreating.mockResolvedValue({ count: 1 });
		transitionCheckoutIntentToReview.mockResolvedValue({ count: 1 });
		getPaymentProvider.mockReturnValue({
			name: "paypal",
			capabilities: {
				checkout: true,
				portal: false,
				cancellation: true,
				seatUpdates: false,
				webhooks: true,
			},
			createCheckout: providerCheckout,
			recoverCheckout: providerRecoverCheckout,
		});
		verifyOrganizationBillingManagement.mockResolvedValue(null);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("accepts only PayPal or Waffo and server-owned product selection", () => {
		expect(
			creditPackCheckoutInputSchema.safeParse({
				provider: "stripe",
				packKey: "credits-1500",
				idempotencyKey: "credit-pack-checkout-0001",
			}),
		).toMatchObject({ success: false });
		expect(
			creditPackCheckoutInputSchema.safeParse({
				provider: "paypal",
				packKey: "credits-1500",
				idempotencyKey: "credit-pack-checkout-0001",
				amountMicros: 1,
				providerProductId: "PROD-ATTACKER",
			}),
		).toMatchObject({ success: false });
	});

	it("requires an authenticated non-anonymous user", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue(null);

		await expect(
			call(
				createCreditPackCheckout,
				{
					provider: "paypal",
					packKey: "credits-1500",
					idempotencyKey: "credit-pack-checkout-0001",
				},
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(getPaymentCheckoutIntentForOwnerByIdempotencyKey).not.toHaveBeenCalled();
		expect(providerCheckout).not.toHaveBeenCalled();
	});

	it("freezes subscription eligibility and creates a PayPal one-time checkout", async () => {
		getPaymentCheckoutIntentForOwner.mockResolvedValue({
			id: "credit-pack-intent-1",
			idempotencyKey: "credit-pack-checkout-canonical-0001",
			provider: "paypal",
			status: "CREATED",
			submittedByUserId: "user-1",
			productKind: "CREDIT_PACK",
			billingPlanId: billingPlan.id,
			planKey: "credits-1500",
			interval: "one-time",
			creditPackCatalogVersion: "2026-09-06.1",
			creditPackPricingVersion: "2026-09-06.1",
			creditPackSubscriberEligibilityVersion: "2026-09-06.1",
			creditPackBaseCredits: 1_500n,
			creditPackBonusCredits: 300n,
			creditPackTotalCredits: 1_800n,
			creditPackExpiryMonths: 6,
			creditPackSubscriberBonusEligible: true,
			creditPackSubscriberSubscriptionId: "subscription-ultimate",
			creditPackSubscriberPlanKey: "ultimate",
			creditPackEligibilityEvaluatedAt: new Date("2026-09-06T08:30:00.000Z"),
			billingPlan,
			creditPackFulfillment: null,
		});
		const result = await call(
			createCreditPackCheckout,
			{
				provider: "paypal",
				packKey: "credits-1500",
				idempotencyKey: "credit-pack-checkout-alias-0002",
			},
			{ context: { headers: new Headers() } },
		);

		expect(result).toEqual({
			checkoutLink: "https://www.sandbox.paypal.com/approve",
		});
		expect(getPaymentCheckoutIntentForOwnerByIdempotencyKey).toHaveBeenCalledWith(
			{
				ownerType: "USER",
				ownerId: "user-1",
				idempotencyKey: "credit-pack-checkout-alias-0002",
			},
			expect.anything(),
		);
		expect(findEffectivePaidSubscription).toHaveBeenCalledWith(
			{
				ownerType: "USER",
				ownerId: "user-1",
				now: new Date("2026-09-06T08:30:00.000Z"),
			},
			expect.anything(),
		);
		expect(createCheckoutIntent).toHaveBeenCalledWith(
			{
				provider: "paypal",
				ownerType: "USER",
				ownerId: "user-1",
				submittedByUserId: "user-1",
				billingPlanId: billingPlan.id,
				productKind: "CREDIT_PACK",
				planKey: "credits-1500",
				interval: "one-time",
				idempotencyKey: "credit-pack-checkout-alias-0002",
				now: new Date("2026-09-06T08:30:00.000Z"),
				creditPackSnapshot: {
					catalogVersion: "2026-09-06.1",
					pricingVersion: "2026-09-06.1",
					subscriberEligibilityVersion: "2026-09-06.1",
					baseCredits: 1_500n,
					bonusCredits: 300n,
					totalCredits: 1_800n,
					expiryMonths: 6,
					subscriberBonusEligible: true,
					subscriberSubscriptionId: "subscription-ultimate",
					subscriberPlanKey: "ultimate",
					eligibilityEvaluatedAt: new Date("2026-09-06T08:30:00.000Z"),
				},
			},
			expect.anything(),
		);
		expect(providerCheckout).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "one-time",
				priceId: "PROD-CREDITS-1500",
				amountMicros: 59_000_000n,
				currency: "USD",
				billingPlanId: billingPlan.id,
				checkoutIntentId: "credit-pack-intent-1",
				idempotencyKey: "credit-pack-checkout-canonical-0001",
				planKey: "credits-1500",
				ownerType: "USER",
				ownerId: "user-1",
				redirectUrl:
					"https://app.ezpic.test/credit-pack-checkout-return?intentId=credit-pack-intent-1",
			}),
		);
		expect(markCheckoutIntentProviderCreating).toHaveBeenCalledWith(
			{ intentId: "credit-pack-intent-1", provider: "paypal" },
			expect.anything(),
		);
		expect(markCheckoutIntentProviderCreating.mock.invocationCallOrder[0]).toBeLessThan(
			providerCheckout.mock.invocationCallOrder[0]!,
		);
		expect(bindCheckoutIntent).toHaveBeenCalledWith(
			{
				intentId: "credit-pack-intent-1",
				provider: "paypal",
				providerSessionId: "PAYPAL-ORDER-1",
				providerOrderId: "PAYPAL-ORDER-1",
				providerCheckoutUrl: "https://www.sandbox.paypal.com/approve",
				expiresAt: null,
			},
			expect.anything(),
		);
	});

	it("does not award a subscriber bonus without an effective paid plan", async () => {
		findEffectivePaidSubscription.mockResolvedValue(null);
		getPaymentCheckoutIntentForOwner.mockResolvedValue({
			id: "credit-pack-intent-1",
			provider: "waffo",
			status: "CREATED",
			submittedByUserId: "user-1",
			productKind: "CREDIT_PACK",
			billingPlanId: "billing-plan-waffo-credits-1500",
			planKey: "credits-1500",
			interval: "one-time",
			creditPackCatalogVersion: "2026-09-06.1",
			creditPackPricingVersion: "2026-09-06.1",
			creditPackSubscriberEligibilityVersion: "2026-09-06.1",
			creditPackBaseCredits: 1_500n,
			creditPackBonusCredits: 0n,
			creditPackTotalCredits: 1_500n,
			creditPackExpiryMonths: 6,
			creditPackSubscriberBonusEligible: false,
			creditPackSubscriberSubscriptionId: null,
			creditPackSubscriberPlanKey: null,
			creditPackEligibilityEvaluatedAt: new Date("2026-09-06T08:30:00.000Z"),
			billingPlan: {
				...billingPlan,
				id: "billing-plan-waffo-credits-1500",
				provider: "waffo",
				providerPriceId: "product-waffo-credits-1500",
			},
			creditPackFulfillment: null,
		});

		await call(
			createCreditPackCheckout,
			{
				provider: "waffo",
				packKey: "credits-1500",
				idempotencyKey: "credit-pack-checkout-0002",
			},
			{ context: { headers: new Headers() } },
		);

		expect(createCheckoutIntent).toHaveBeenCalledWith(
			expect.objectContaining({
				creditPackSnapshot: expect.objectContaining({
					subscriberBonusEligible: false,
					subscriberSubscriptionId: null,
					subscriberPlanKey: null,
					bonusCredits: 0n,
					totalCredits: 1_500n,
				}),
			}),
			expect.anything(),
		);
		expect(bindCheckoutIntent).toHaveBeenCalledWith(
			expect.not.objectContaining({ providerOrderId: expect.anything() }),
			expect.anything(),
		);
	});

	it("reuses the first frozen intent on an idempotent retry", async () => {
		getPaymentCheckoutIntentForOwnerByIdempotencyKey.mockResolvedValue({
			id: "credit-pack-intent-frozen",
			provider: "paypal",
			submittedByUserId: "user-1",
			productKind: "CREDIT_PACK",
			billingPlanId: billingPlan.id,
			planKey: "credits-1500",
			interval: "one-time",
			status: "PROVIDER_PENDING",
			providerSessionId: "PAYPAL-ORDER-FROZEN",
			providerCheckoutUrl: "https://www.sandbox.paypal.com/frozen-approval",
			creditPackCatalogVersion: "2026-09-06.1",
			creditPackPricingVersion: "2026-09-06.1",
			creditPackSubscriberEligibilityVersion: "2026-09-06.1",
			creditPackBaseCredits: 1_500n,
			creditPackBonusCredits: 300n,
			creditPackTotalCredits: 1_800n,
			creditPackExpiryMonths: 6,
			creditPackSubscriberBonusEligible: true,
			creditPackSubscriberSubscriptionId: "subscription-ultimate",
			creditPackSubscriberPlanKey: "ultimate",
			creditPackEligibilityEvaluatedAt: new Date("2026-09-05T08:30:00.000Z"),
			billingPlan,
			creditPackFulfillment: null,
		});
		findEffectivePaidSubscription.mockResolvedValue(null);
		vi.setSystemTime(new Date("2026-09-07T08:30:00.000Z"));

		await expect(
			call(
				createCreditPackCheckout,
				{
					provider: "paypal",
					packKey: "credits-1500",
					idempotencyKey: "credit-pack-checkout-0001",
				},
				{ context: { headers: new Headers() } },
			),
		).resolves.toEqual({
			checkoutLink: "https://www.sandbox.paypal.com/frozen-approval",
		});
		expect(findEffectivePaidSubscription).not.toHaveBeenCalled();
		expect(findBillingPlan).not.toHaveBeenCalled();
		expect(createCheckoutIntent).not.toHaveBeenCalled();
		expect(providerCheckout).not.toHaveBeenCalled();
	});

	it("recovers and binds a provider-created checkout after local binding was interrupted", async () => {
		getPaymentCheckoutIntentForOwnerByIdempotencyKey.mockResolvedValue({
			id: "credit-pack-intent-1",
			idempotencyKey: "credit-pack-checkout-canonical-0001",
			provider: "paypal",
			status: "PROVIDER_CREATING",
			updatedAt: new Date("2026-09-06T08:29:00.000Z"),
			submittedByUserId: "user-1",
			productKind: "CREDIT_PACK",
			billingPlanId: billingPlan.id,
			planKey: "credits-1500",
			interval: "one-time",
			creditPackCatalogVersion: "2026-09-06.1",
			creditPackPricingVersion: "2026-09-06.1",
			creditPackSubscriberEligibilityVersion: "2026-09-06.1",
			creditPackBaseCredits: 1_500n,
			creditPackBonusCredits: 300n,
			creditPackTotalCredits: 1_800n,
			creditPackExpiryMonths: 6,
			creditPackSubscriberBonusEligible: true,
			creditPackSubscriberSubscriptionId: "subscription-ultimate",
			creditPackSubscriberPlanKey: "ultimate",
			creditPackEligibilityEvaluatedAt: new Date("2026-09-06T08:28:00.000Z"),
			billingPlan,
			creditPackFulfillment: null,
		});
		providerRecoverCheckout.mockResolvedValue({
			status: "FOUND",
			providerOrderId: "PAYPAL-ORDER-RECOVERED",
			checkout: {
				checkoutUrl: "https://www.sandbox.paypal.com/recovered-approval",
				providerSessionId: "PAYPAL-ORDER-RECOVERED",
				expiresAt: new Date("2026-09-06T11:29:00.000Z"),
			},
		});

		await expect(
			call(
				createCreditPackCheckout,
				{
					provider: "paypal",
					packKey: "credits-1500",
					idempotencyKey: "credit-pack-checkout-alias-0002",
				},
				{ context: { headers: new Headers() } },
			),
		).resolves.toEqual({
			checkoutLink: "https://www.sandbox.paypal.com/recovered-approval",
		});
		expect(providerRecoverCheckout).toHaveBeenCalledWith(
			expect.objectContaining({
				checkoutIntentId: "credit-pack-intent-1",
				idempotencyKey: "credit-pack-checkout-canonical-0001",
				providerCreatingAt: new Date("2026-09-06T08:29:00.000Z"),
				now: new Date("2026-09-06T08:30:00.000Z"),
			}),
		);
		expect(bindCheckoutIntent).toHaveBeenCalledWith(
			expect.objectContaining({
				providerSessionId: "PAYPAL-ORDER-RECOVERED",
				providerOrderId: "PAYPAL-ORDER-RECOVERED",
			}),
			expect.anything(),
		);
		expect(markCheckoutIntentProviderCreating).not.toHaveBeenCalled();
		expect(providerCheckout).not.toHaveBeenCalled();
	});

	it("rejects reuse of an idempotency key for a different credit pack", async () => {
		getPaymentCheckoutIntentForOwnerByIdempotencyKey.mockResolvedValue({
			id: "credit-pack-intent-existing",
			provider: "paypal",
			submittedByUserId: "user-1",
			productKind: "CREDIT_PACK",
			billingPlanId: billingPlan.id,
			planKey: "credits-3000",
			interval: "one-time",
			status: "PROVIDER_PENDING",
			providerSessionId: "PAYPAL-ORDER-EXISTING",
			providerCheckoutUrl: "https://www.sandbox.paypal.com/existing-approval",
			creditPackCatalogVersion: "2026-09-06.1",
			creditPackPricingVersion: "2026-09-06.1",
			creditPackSubscriberEligibilityVersion: "2026-09-06.1",
			creditPackBaseCredits: 1_500n,
			creditPackBonusCredits: 300n,
			creditPackTotalCredits: 1_800n,
			creditPackExpiryMonths: 6,
			creditPackSubscriberBonusEligible: true,
			creditPackSubscriberSubscriptionId: "subscription-ultimate",
			creditPackSubscriberPlanKey: "ultimate",
			creditPackEligibilityEvaluatedAt: new Date("2026-09-05T08:30:00.000Z"),
			billingPlan,
			creditPackFulfillment: null,
		});

		await expect(
			call(
				createCreditPackCheckout,
				{
					provider: "paypal",
					packKey: "credits-1500",
					idempotencyKey: "credit-pack-checkout-reused-0001",
				},
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(createCheckoutIntent).not.toHaveBeenCalled();
		expect(providerCheckout).not.toHaveBeenCalled();
	});

	it("derives organization ownership from the trusted active session", async () => {
		paymentsConfig.billingAttachedTo = "organization";
		vi.mocked(auth.api.getSession).mockResolvedValue({
			...authenticatedSession,
			session: {
				...authenticatedSession.session,
				activeOrganizationId: "organization-1",
			},
		});
		verifyOrganizationBillingManagement.mockResolvedValue({
			organization: { id: "organization-1" },
			role: "owner",
		});
		findEffectivePaidSubscription.mockResolvedValue(null);

		await call(
			createCreditPackCheckout,
			{
				provider: "paypal",
				packKey: "credits-1500",
				idempotencyKey: "credit-pack-checkout-org-0001",
			},
			{ context: { headers: new Headers() } },
		);

		expect(verifyOrganizationBillingManagement).toHaveBeenCalledWith("organization-1", "user-1");
		expect(findEffectivePaidSubscription).toHaveBeenCalledWith(
			expect.objectContaining({ ownerType: "ORGANIZATION", ownerId: "organization-1" }),
			expect.anything(),
		);
		expect(createCheckoutIntent).toHaveBeenCalledWith(
			expect.objectContaining({ ownerType: "ORGANIZATION", ownerId: "organization-1" }),
			expect.anything(),
		);
		expect(providerCheckout).toHaveBeenCalledWith(
			expect.objectContaining({
				ownerType: "ORGANIZATION",
				ownerId: "organization-1",
				organizationId: "organization-1",
			}),
		);
	});
});
