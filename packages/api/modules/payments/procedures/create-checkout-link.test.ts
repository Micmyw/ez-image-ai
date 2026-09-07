import { call } from "@orpc/server";
import type { Session } from "@repo/auth";
import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	bindCheckoutIntent,
	bindCheckoutIntentOrder,
	createCheckoutIntent,
	findBillingPlan,
	getPaymentCheckoutIntentForOwner,
	getPaymentCheckoutIntentForOwnerByIdempotencyKey,
	getPaymentCustomer,
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
	getPaymentCheckoutIntentForOwner: vi.fn(),
	getPaymentCheckoutIntentForOwnerByIdempotencyKey: vi.fn(),
	getPaymentCustomer: vi.fn(),
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
	productKind: "PLAN" as const,
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
		getPaymentCheckoutIntentForOwnerByIdempotencyKey.mockResolvedValue(null);
		createCheckoutIntent.mockResolvedValue({
			intent: {
				id: "checkout-intent-1",
				idempotencyKey: "checkout-operation-0001",
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
		providerRecoverCheckout.mockResolvedValue({ status: "UNKNOWN" });
		resetCheckoutIntentProviderCreating.mockResolvedValue({ count: 1 });
		transitionCheckoutIntentToReview.mockResolvedValue({ count: 1 });
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
			recoverCheckout: providerRecoverCheckout,
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

	it("rejects Stripe while preserving PayPal and Waffo subscription checkout", async () => {
		expect(
			checkoutInputSchema.safeParse({
				provider: "stripe",
				planId: "creator",
				interval: "month",
				idempotencyKey: "checkout-operation-stripe-0001",
			}),
		).toMatchObject({ success: false });
		expect(
			checkoutInputSchema.safeParse({
				provider: "waffo",
				planId: "ultimate",
				interval: "year",
				idempotencyKey: "checkout-operation-waffo-0001",
			}),
		).toMatchObject({ success: true });

		await expect(
			call(
				createCheckoutLink,
				{
					provider: "stripe",
					planId: "creator",
					interval: "month",
					idempotencyKey: "checkout-operation-stripe-0001",
				} as never,
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(findBillingPlan).not.toHaveBeenCalled();
		expect(providerCheckout).not.toHaveBeenCalled();
	});

	it("accepts the Ultimate subscription tier", () => {
		expect(
			checkoutInputSchema.safeParse({
				provider: "paypal",
				planId: "ultimate",
				interval: "year",
				idempotencyKey: "checkout-operation-ultimate-0001",
			}),
		).toMatchObject({ success: true });
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
		createCheckoutIntent.mockResolvedValue({
			intent: {
				id: "checkout-intent-1",
				idempotencyKey: "checkout-operation-canonical-0001",
				status: "CREATED",
				providerSessionId: null,
				providerCheckoutUrl: null,
			},
			replayed: true,
		});
		const result = await call(
			createCheckoutLink,
			{
				provider: "paypal",
				planId: "creator",
				interval: "month",
				idempotencyKey: "checkout-operation-alias-0002",
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
				idempotencyKey: "checkout-operation-alias-0002",
			},
			expect.anything(),
		);
		expect(providerCheckout).toHaveBeenCalledWith(
			expect.objectContaining({
				priceId: "P-CREATOR-MONTHLY",
				currency: "USD",
				checkoutIntentId: "checkout-intent-1",
				idempotencyKey: "checkout-operation-canonical-0001",
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

	it("recovers a subscription checkout left in PROVIDER_CREATING without creating a duplicate", async () => {
		const historicalBillingPlan = {
			...billingPlan,
			id: "billing-plan-historical",
			providerPriceId: "P-CREATOR-HISTORICAL",
		};
		getPaymentCheckoutIntentForOwnerByIdempotencyKey.mockResolvedValue({
			id: "checkout-intent-1",
			idempotencyKey: "checkout-operation-canonical-0001",
			provider: "paypal",
			ownerType: "USER",
			ownerId: "user-1",
			submittedByUserId: "user-1",
			productKind: "PLAN",
			billingPlanId: historicalBillingPlan.id,
			planKey: "creator",
			interval: "month",
			status: "PROVIDER_CREATING",
			providerSessionId: null,
			providerCheckoutUrl: null,
			updatedAt: new Date("2026-09-06T08:29:00.000Z"),
			billingPlan: historicalBillingPlan,
		});
		providerRecoverCheckout.mockResolvedValue({
			status: "FOUND",
			checkout: {
				checkoutUrl: "https://www.sandbox.paypal.com/recovered-subscription",
				providerSessionId: "I-RECOVERED-SUBSCRIPTION",
				expiresAt: null,
			},
		});

		await expect(
			call(
				createCheckoutLink,
				{
					provider: "paypal",
					planId: "creator",
					interval: "month",
					idempotencyKey: "checkout-operation-alias-0002",
				},
				{ context: { headers: new Headers() } },
			),
		).resolves.toEqual({
			checkoutLink: "https://www.sandbox.paypal.com/recovered-subscription",
		});
		expect(providerRecoverCheckout).toHaveBeenCalledWith(
			expect.objectContaining({
				checkoutIntentId: "checkout-intent-1",
				idempotencyKey: "checkout-operation-canonical-0001",
				priceId: "P-CREATOR-HISTORICAL",
				providerCreatingAt: new Date("2026-09-06T08:29:00.000Z"),
			}),
		);
		expect(providerCheckout).not.toHaveBeenCalled();
		expect(markCheckoutIntentProviderCreating).not.toHaveBeenCalled();
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
