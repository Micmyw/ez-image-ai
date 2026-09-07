import { call } from "@orpc/server";
import type { Session } from "@repo/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPlanIdByProviderPriceId, getPlanPriceByProviderPriceId, resolvePaymentProvider } =
	vi.hoisted(() => ({
		getPlanIdByProviderPriceId: vi.fn(),
		getPlanPriceByProviderPriceId: vi.fn(),
		resolvePaymentProvider: vi.fn(),
	}));

vi.mock("@repo/auth", () => ({
	auth: {
		api: {
			getSession: vi.fn(),
		},
	},
}));

vi.mock("@repo/database", async () => {
	const { z } = await import("zod");

	return {
		PurchaseSchema: z.object({ provider: z.string() }),
		getOrganizationMembership: vi.fn(),
		getPurchasesByOrganizationId: vi.fn(),
		getPurchasesByUserId: vi.fn(),
	};
});
vi.mock("@repo/payments", () => ({
	getPlanIdByProviderPriceId,
	getPlanPriceByProviderPriceId,
	resolvePaymentProvider,
}));

import { auth } from "@repo/auth";
import {
	getOrganizationMembership,
	getPurchasesByOrganizationId,
	getPurchasesByUserId,
} from "@repo/database";

import { listPurchases } from "./list-purchases";

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

const organizationMembership = {
	id: "membership-1",
	organizationId: "organization-1",
	userId: "user-1",
	role: "member",
	createdAt: new Date(),
	organization: {
		id: "organization-1",
		name: "Test Organization",
		slug: "test-organization",
		logo: null,
		createdAt: new Date(),
		metadata: null,
		paymentsCustomerId: null,
	},
} satisfies NonNullable<Awaited<ReturnType<typeof getOrganizationMembership>>>;

describe("listPurchases", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue(authenticatedSession);
	});

	it("rejects access to purchases for an organization the user does not belong to", async () => {
		vi.mocked(getOrganizationMembership).mockResolvedValueOnce(null);

		await expect(
			call(
				listPurchases,
				{ organizationId: "organization-2" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(getPurchasesByOrganizationId).not.toHaveBeenCalled();
	});

	it("allows organization members to list their organization's purchases", async () => {
		vi.mocked(getOrganizationMembership).mockResolvedValueOnce(organizationMembership);
		vi.mocked(getPurchasesByOrganizationId).mockResolvedValueOnce([]);

		const result = await call(
			listPurchases,
			{ organizationId: "organization-1" },
			{ context: { headers: new Headers() } },
		);

		expect(result).toEqual([]);
		expect(getPurchasesByOrganizationId).toHaveBeenCalledWith("organization-1");
	});

	it("scopes personal purchases to the authenticated user", async () => {
		vi.mocked(getPurchasesByUserId).mockResolvedValueOnce([]);

		const result = await call(listPurchases, {}, { context: { headers: new Headers() } });

		expect(result).toEqual([]);
		expect(getPurchasesByUserId).toHaveBeenCalledWith("user-1");
		expect(getOrganizationMembership).not.toHaveBeenCalled();
	});

	it("resolves plan and management capabilities within the purchase provider namespace", async () => {
		vi.mocked(getPurchasesByUserId).mockResolvedValueOnce([
			{
				id: "purchase-paypal",
				provider: "paypal",
				productKind: "PLAN",
				priceId: "P-CREATOR-MONTHLY",
				type: "SUBSCRIPTION",
				customerId: "paypal-customer",
				subscriptionId: "I-SUBSCRIPTION",
				organizationId: null,
				userId: "user-1",
				status: "active",
				createdAt: new Date("2026-08-31T00:00:00Z"),
				updatedAt: new Date("2026-08-31T00:00:00Z"),
			},
		] as never);
		getPlanIdByProviderPriceId.mockReturnValue("creator");
		getPlanPriceByProviderPriceId.mockReturnValue({
			planId: "creator",
			price: { type: "subscription", interval: "month", amount: 19, currency: "USD" },
		});
		resolvePaymentProvider.mockReturnValue({
			name: "paypal",
			capabilities: {
				checkout: true,
				portal: false,
				cancellation: true,
				seatUpdates: false,
				webhooks: true,
			},
		});

		const result = await call(listPurchases, {}, { context: { headers: new Headers() } });

		expect(getPlanIdByProviderPriceId).toHaveBeenCalledWith("paypal", "P-CREATOR-MONTHLY");
		expect(result[0]).toMatchObject({
			provider: "paypal",
			planId: "creator",
			providerCapabilities: {
				portal: false,
				cancellation: true,
				seatUpdates: false,
			},
		});
	});

	it("does not project a credit-pack purchase as a plan entitlement", async () => {
		vi.mocked(getPurchasesByUserId).mockResolvedValueOnce([
			{
				id: "purchase-credit-pack",
				provider: "paypal",
				productKind: "CREDIT_PACK",
				priceId: "PROD-CREDITS-1500",
				type: "ONE_TIME",
				customerId: "paypal-customer",
				subscriptionId: null,
				organizationId: null,
				userId: "user-1",
				status: "completed",
				createdAt: new Date("2026-09-06T00:00:00Z"),
				updatedAt: new Date("2026-09-06T00:00:00Z"),
				mediaSubscription: null,
			},
		] as never);
		getPlanIdByProviderPriceId.mockReturnValue("creator");
		getPlanPriceByProviderPriceId.mockReturnValue({
			planId: "creator",
			price: { type: "subscription", interval: "month", amount: 19, currency: "USD" },
		});

		const result = await call(listPurchases, {}, { context: { headers: new Headers() } });

		expect(result[0]).toMatchObject({ planId: null, planPrice: null });
		expect(getPlanIdByProviderPriceId).not.toHaveBeenCalled();
		expect(getPlanPriceByProviderPriceId).not.toHaveBeenCalled();
	});

	it("keeps a historical subscription's persisted plan after its provider price ID rotates", async () => {
		vi.mocked(getPurchasesByUserId).mockResolvedValueOnce([
			{
				id: "purchase-historical",
				provider: "stripe",
				productKind: "PLAN",
				priceId: "price_creator_monthly_retired",
				type: "SUBSCRIPTION",
				customerId: "stripe-customer",
				subscriptionId: "sub-historical",
				organizationId: null,
				userId: "user-1",
				status: "active",
				createdAt: new Date("2026-08-31T00:00:00Z"),
				updatedAt: new Date("2026-08-31T00:00:00Z"),
				mediaSubscription: {
					ownerType: "USER",
					ownerId: "user-1",
					provider: "stripe",
					plan: {
						provider: "stripe",
						priceMicros: 17_000_000n,
						currency: "USD",
						metadata: {
							planId: "creator",
							interval: "month",
						},
					},
				},
			},
		] as never);
		getPlanIdByProviderPriceId.mockReturnValue(null);
		getPlanPriceByProviderPriceId.mockReturnValue(null);

		const result = await call(listPurchases, {}, { context: { headers: new Headers() } });

		expect(result[0]).toMatchObject({
			provider: "stripe",
			planId: "creator",
			planPrice: {
				type: "subscription",
				interval: "month",
				amount: 17,
				currency: "USD",
			},
		});
	});

	it("does not recover a persisted plan from a different owner", async () => {
		vi.mocked(getPurchasesByUserId).mockResolvedValueOnce([
			{
				id: "purchase-wrong-owner",
				provider: "stripe",
				productKind: "PLAN",
				priceId: "price_creator_monthly_retired",
				type: "SUBSCRIPTION",
				customerId: "stripe-customer",
				subscriptionId: "sub-wrong-owner",
				organizationId: null,
				userId: "user-1",
				status: "active",
				createdAt: new Date("2026-08-31T00:00:00Z"),
				updatedAt: new Date("2026-08-31T00:00:00Z"),
				mediaSubscription: {
					ownerType: "USER",
					ownerId: "user-2",
					provider: "stripe",
					plan: {
						provider: "stripe",
						priceMicros: 17_000_000n,
						currency: "USD",
						metadata: { planId: "creator", interval: "month" },
					},
				},
			},
		] as never);
		getPlanIdByProviderPriceId.mockReturnValue(null);
		getPlanPriceByProviderPriceId.mockReturnValue(null);

		const result = await call(listPurchases, {}, { context: { headers: new Headers() } });

		expect(result[0]).toMatchObject({
			provider: "stripe",
			planId: null,
			planPrice: null,
		});
	});

	it("does not recover a persisted plan from a different provider", async () => {
		vi.mocked(getPurchasesByUserId).mockResolvedValueOnce([
			{
				id: "purchase-wrong-provider",
				provider: "stripe",
				productKind: "PLAN",
				priceId: "price_creator_monthly_retired",
				type: "SUBSCRIPTION",
				customerId: "stripe-customer",
				subscriptionId: "sub-wrong-provider",
				organizationId: null,
				userId: "user-1",
				status: "active",
				createdAt: new Date("2026-08-31T00:00:00Z"),
				updatedAt: new Date("2026-08-31T00:00:00Z"),
				mediaSubscription: {
					ownerType: "USER",
					ownerId: "user-1",
					provider: "paypal",
					plan: {
						provider: "paypal",
						priceMicros: 17_000_000n,
						currency: "USD",
						metadata: { planId: "creator", interval: "month" },
					},
				},
			},
		] as never);
		getPlanIdByProviderPriceId.mockReturnValue(null);
		getPlanPriceByProviderPriceId.mockReturnValue(null);

		const result = await call(listPurchases, {}, { context: { headers: new Headers() } });

		expect(result[0]).toMatchObject({
			provider: "stripe",
			planId: null,
			planPrice: null,
		});
	});

	it("keeps an organization's historical plan after its provider price ID rotates", async () => {
		vi.mocked(getOrganizationMembership).mockResolvedValueOnce(organizationMembership);
		vi.mocked(getPurchasesByOrganizationId).mockResolvedValueOnce([
			{
				id: "purchase-organization-historical",
				provider: "stripe",
				productKind: "PLAN",
				priceId: "price_studio_annual_retired",
				type: "SUBSCRIPTION",
				customerId: "stripe-customer",
				subscriptionId: "sub-organization-historical",
				organizationId: "organization-1",
				userId: null,
				status: "active",
				createdAt: new Date("2026-08-31T00:00:00Z"),
				updatedAt: new Date("2026-08-31T00:00:00Z"),
				mediaSubscription: {
					ownerType: "ORGANIZATION",
					ownerId: "organization-1",
					provider: "stripe",
					plan: {
						provider: "stripe",
						priceMicros: 790_000_000n,
						currency: "USD",
						metadata: { planId: "studio", interval: "year" },
					},
				},
			},
		] as never);
		getPlanIdByProviderPriceId.mockReturnValue(null);
		getPlanPriceByProviderPriceId.mockReturnValue(null);

		const result = await call(
			listPurchases,
			{ organizationId: "organization-1" },
			{ context: { headers: new Headers() } },
		);

		expect(result[0]).toMatchObject({
			provider: "stripe",
			planId: "studio",
			planPrice: {
				type: "subscription",
				interval: "year",
				amount: 790,
				currency: "USD",
			},
		});
	});
});
