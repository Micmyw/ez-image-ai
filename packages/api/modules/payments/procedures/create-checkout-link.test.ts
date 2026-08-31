import { call } from "@orpc/server";
import type { Session } from "@repo/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	bindCheckoutIntent,
	createCheckoutIntent,
	findBillingPlan,
	getPaymentCustomer,
	providerCheckout,
} = vi.hoisted(() => ({
	bindCheckoutIntent: vi.fn(),
	createCheckoutIntent: vi.fn(),
	findBillingPlan: vi.fn(),
	getPaymentCustomer: vi.fn(),
	providerCheckout: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	bindPaymentCheckoutIntentSession: bindCheckoutIntent,
	createPaymentCheckoutIntent: createCheckoutIntent,
	getPaymentCustomer,
}));
vi.mock("@repo/database/client", () => ({
	db: { billingPlan: { findUnique: findBillingPlan } },
}));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));
vi.mock("@repo/payments", () => ({
	findPriceByPlanId: vi.fn(),
	getPaymentProvider: vi.fn(),
	getProviderPriceIdByPlanId: vi.fn(),
	isPaymentProviderConfigured: vi.fn(),
	paymentProviderNames: ["stripe", "paypal", "waffo"],
}));

import { auth } from "@repo/auth";
import {
	findPriceByPlanId,
	getPaymentProvider,
	getProviderPriceIdByPlanId,
	isPaymentProviderConfigured,
} from "@repo/payments";

import { checkoutInputSchema, createCheckoutLink } from "./create-checkout-link";

const authenticatedSession = {
	session: {
		id: "session-1",
		createdAt: new Date(),
		updatedAt: new Date(),
		userId: "user-1",
		expiresAt: new Date(Date.now() + 60_000),
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
		createdAt: new Date(),
		updatedAt: new Date(),
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

const monthlyPrice = {
	type: "subscription" as const,
	interval: "month" as const,
	amount: 19,
	currency: "USD",
	monthlyCredits: 1_000,
};

const billingPlan = {
	id: "billing-plan-paypal-creator-month",
	provider: "paypal",
	providerPriceId: "P-CREATOR-MONTHLY",
	active: true,
	name: "creator",
	creditsPerPeriod: 1_000n,
	priceMicros: 19_000_000n,
	currency: "USD",
	metadata: { planId: "creator", interval: "month", version: 1 },
};

describe("createCheckoutLink", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.NEXT_PUBLIC_SAAS_URL = "https://app.ezpic.test";
		vi.mocked(auth.api.getSession).mockResolvedValue(authenticatedSession);
		vi.mocked(isPaymentProviderConfigured).mockReturnValue(true);
		vi.mocked(findPriceByPlanId).mockReturnValue(monthlyPrice);
		vi.mocked(getProviderPriceIdByPlanId).mockReturnValue("P-CREATOR-MONTHLY");
		findBillingPlan.mockResolvedValue(billingPlan);
		getPaymentCustomer.mockResolvedValue(null);
		createCheckoutIntent.mockResolvedValue({
			intent: { id: "checkout-intent-1", providerSessionId: null },
			replayed: false,
		});
		providerCheckout.mockResolvedValue({
			checkoutUrl: "https://www.sandbox.paypal.com/approve",
			providerSessionId: "I-SUBSCRIPTION",
			expiresAt: null,
		});
		vi.mocked(getPaymentProvider).mockReturnValue({
			name: "paypal",
			capabilities: {
				checkout: true,
				portal: false,
				cancellation: true,
				seatUpdates: false,
				webhooks: true,
			},
			createCheckout: providerCheckout,
		});
	});

	it("accepts only provider, planId, interval, and idempotencyKey", () => {
		expect(
			checkoutInputSchema.safeParse({
				provider: "paypal",
				planId: "creator",
				interval: "month",
				idempotencyKey: "checkout-operation-0001",
				providerPriceId: "P-ATTACKER-CONTROLLED",
			}),
		).toMatchObject({ success: false });
	});

	it("fails closed before persistence or provider access when configuration is incomplete", async () => {
		vi.mocked(isPaymentProviderConfigured).mockReturnValue(false);

		await expect(
			call(
				createCheckoutLink,
				{
					provider: "paypal",
					planId: "creator",
					interval: "month",
					idempotencyKey: "checkout-operation-0001",
				},
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(createCheckoutIntent).not.toHaveBeenCalled();
		expect(providerCheckout).not.toHaveBeenCalled();
	});

	it("creates and binds an internal checkout intent before returning the provider URL", async () => {
		const result = await call(
			createCheckoutLink,
			{
				provider: "paypal",
				planId: "creator",
				interval: "month",
				idempotencyKey: "checkout-operation-0001",
			},
			{ context: { headers: new Headers() } },
		);

		expect(result).toEqual({ checkoutLink: "https://www.sandbox.paypal.com/approve" });
		expect(createCheckoutIntent).toHaveBeenCalledWith(
			{
				provider: "paypal",
				ownerType: "USER",
				ownerId: "user-1",
				submittedByUserId: "user-1",
				billingPlanId: billingPlan.id,
				planKey: "creator",
				interval: "month",
				idempotencyKey: "checkout-operation-0001",
			},
			expect.anything(),
		);
		expect(providerCheckout).toHaveBeenCalledWith(
			expect.objectContaining({
				priceId: "P-CREATOR-MONTHLY",
				currency: "USD",
				checkoutIntentId: "checkout-intent-1",
				ownerType: "USER",
				ownerId: "user-1",
				redirectUrl:
					"https://app.ezpic.test/checkout-return?expectedPlanId=creator&returnTo=%2Fcreate%3Fupgrade%3Dcomplete",
			}),
		);
		expect(bindCheckoutIntent).toHaveBeenCalledWith(
			{
				intentId: "checkout-intent-1",
				provider: "paypal",
				providerSessionId: "I-SUBSCRIPTION",
				expiresAt: null,
			},
			expect.anything(),
		);
	});

	it("reuses a provider-bound intent only when the replay returns the same session", async () => {
		createCheckoutIntent.mockResolvedValue({
			intent: { id: "checkout-intent-1", providerSessionId: "I-SUBSCRIPTION" },
			replayed: true,
		});

		await expect(
			call(
				createCheckoutLink,
				{
					provider: "paypal",
					planId: "creator",
					interval: "month",
					idempotencyKey: "checkout-operation-0001",
				},
				{ context: { headers: new Headers() } },
			),
		).resolves.toEqual({ checkoutLink: "https://www.sandbox.paypal.com/approve" });
		expect(bindCheckoutIntent).not.toHaveBeenCalled();
	});
});
