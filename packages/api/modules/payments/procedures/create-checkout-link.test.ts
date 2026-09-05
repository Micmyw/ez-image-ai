import { call } from "@orpc/server";
import type { Session } from "@repo/auth";
import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	bindCheckoutIntent,
	createCheckoutIntent,
	findBillingPlan,
	getPaymentCustomer,
	markCheckoutIntentProviderCreating,
	paymentsConfig,
	providerCheckout,
	verifyOrganizationBillingManagement,
} = vi.hoisted(() => ({
	bindCheckoutIntent: vi.fn(),
	createCheckoutIntent: vi.fn(),
	findBillingPlan: vi.fn(),
	getPaymentCustomer: vi.fn(),
	markCheckoutIntentProviderCreating: vi.fn(),
	paymentsConfig: { billingAttachedTo: "user" as "user" | "organization" },
	providerCheckout: vi.fn(),
	verifyOrganizationBillingManagement: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	bindPaymentCheckoutIntentSession: bindCheckoutIntent,
	createPaymentCheckoutIntent: createCheckoutIntent,
	getPaymentCustomer,
	markPaymentCheckoutIntentProviderCreating: markCheckoutIntentProviderCreating,
}));
vi.mock("@repo/database/client", () => ({
	db: { billingPlan: { findUnique: findBillingPlan } },
}));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));
vi.mock("@repo/payments/config", () => ({ config: paymentsConfig }));
vi.mock("@repo/payments", () => ({
	findPriceByPlanId: vi.fn(),
	getPaymentProvider: vi.fn(),
	getProviderPriceIdByPlanId: vi.fn(),
	isPaymentProviderConfigured: vi.fn(),
	paymentProviderNames: ["stripe", "paypal", "waffo"],
}));
vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationBillingManagement,
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
	monthlyCredits: 700,
};

const billingPlan = {
	id: "billing-plan-paypal-creator-month",
	provider: "paypal",
	providerPriceId: "P-CREATOR-MONTHLY",
	active: true,
	version: 1,
	name: "creator",
	creditsPerPeriod: 700n,
	priceMicros: 19_000_000n,
	currency: "USD",
	metadata: {
		planId: "creator",
		interval: "month",
		version: 1,
		pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
	},
};

describe("createCheckoutLink", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		paymentsConfig.billingAttachedTo = "user";
		process.env.NEXT_PUBLIC_SAAS_URL = "https://app.ezpic.test";
		vi.mocked(auth.api.getSession).mockResolvedValue(authenticatedSession);
		vi.mocked(isPaymentProviderConfigured).mockReturnValue(true);
		vi.mocked(findPriceByPlanId).mockReturnValue(monthlyPrice);
		vi.mocked(getProviderPriceIdByPlanId).mockReturnValue("P-CREATOR-MONTHLY");
		findBillingPlan.mockResolvedValue(billingPlan);
		getPaymentCustomer.mockResolvedValue(null);
		createCheckoutIntent.mockResolvedValue({
			intent: {
				id: "checkout-intent-1",
				status: "CREATED",
				providerSessionId: null,
				providerCheckoutUrl: null,
			},
			replayed: false,
		});
		markCheckoutIntentProviderCreating.mockResolvedValue({
			id: "checkout-intent-1",
			status: "PROVIDER_CREATING",
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

	it("fails closed before persistence or provider access for a stale pricing snapshot", async () => {
		findBillingPlan.mockResolvedValue({
			...billingPlan,
			metadata: { ...billingPlan.metadata, pricingVersion: "2026-08-25.1" },
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
		expect(markCheckoutIntentProviderCreating).toHaveBeenCalledWith(
			{ intentId: "checkout-intent-1", provider: "paypal" },
			expect.anything(),
		);
		expect(markCheckoutIntentProviderCreating.mock.invocationCallOrder[0]).toBeLessThan(
			providerCheckout.mock.invocationCallOrder[0]!,
		);
		expect(bindCheckoutIntent).toHaveBeenCalledWith(
			{
				intentId: "checkout-intent-1",
				provider: "paypal",
				providerSessionId: "I-SUBSCRIPTION",
				providerCheckoutUrl: "https://www.sandbox.paypal.com/approve",
				expiresAt: null,
			},
			expect.anything(),
		);
	});

	it("returns a persisted provider-bound checkout without invoking the provider again", async () => {
		createCheckoutIntent.mockResolvedValue({
			intent: {
				id: "checkout-intent-1",
				status: "PROVIDER_PENDING",
				providerSessionId: "I-SUBSCRIPTION",
				providerCheckoutUrl: "https://www.sandbox.paypal.com/persisted-approval",
			},
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
		).resolves.toEqual({
			checkoutLink: "https://www.sandbox.paypal.com/persisted-approval",
		});
		expect(markCheckoutIntentProviderCreating).not.toHaveBeenCalled();
		expect(providerCheckout).not.toHaveBeenCalled();
		expect(bindCheckoutIntent).not.toHaveBeenCalled();
	});

	it.each(["PROVIDER_CREATING", "COMPLETED", "CANCELED", "EXPIRED", "REVIEW"])(
		"rejects an exact %s replay before provider access",
		async (status) => {
			createCheckoutIntent.mockResolvedValue({
				intent: {
					id: "checkout-intent-1",
					status,
					providerSessionId: null,
					providerCheckoutUrl: null,
				},
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
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(markCheckoutIntentProviderCreating).not.toHaveBeenCalled();
			expect(providerCheckout).not.toHaveBeenCalled();
		},
	);

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

		await call(
			createCheckoutLink,
			{
				provider: "paypal",
				planId: "creator",
				interval: "month",
				idempotencyKey: "checkout-operation-0001",
			},
			{ context: { headers: new Headers() } },
		);

		expect(verifyOrganizationBillingManagement).toHaveBeenCalledWith("organization-1", "user-1");
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
		expect(getPaymentCustomer).toHaveBeenCalledWith(
			"paypal",
			{ ownerType: "ORGANIZATION", ownerId: "organization-1" },
			expect.anything(),
		);
	});

	it.each([
		[
			"without an active organization",
			null,
			{ organization: { id: "organization-1" }, role: "owner" },
		],
		["without billing-owner permission", "organization-1", null],
	] as const)("fails closed %s", async (_label, activeOrganizationId, membership) => {
		paymentsConfig.billingAttachedTo = "organization";
		vi.mocked(auth.api.getSession).mockResolvedValue({
			...authenticatedSession,
			session: { ...authenticatedSession.session, activeOrganizationId },
		});
		verifyOrganizationBillingManagement.mockResolvedValue(membership);

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
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(createCheckoutIntent).not.toHaveBeenCalled();
		expect(providerCheckout).not.toHaveBeenCalled();
	});
});
