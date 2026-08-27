import { call } from "@orpc/server";
import type { Session } from "@repo/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findBillingPlan } = vi.hoisted(() => ({
	findBillingPlan: vi.fn(),
}));

vi.mock("@repo/auth", () => ({
	auth: {
		api: {
			getSession: vi.fn(),
		},
	},
}));

vi.mock("@repo/database", () => ({
	getOrganizationById: vi.fn(),
	getOrganizationMembership: vi.fn(),
}));

vi.mock("@repo/database/client", () => ({
	db: {
		billingPlan: {
			findUnique: findBillingPlan,
		},
	},
}));

vi.mock("@repo/payments", () => ({
	createCheckoutLink: vi.fn(),
	findPriceByPlanId: vi.fn(),
	getCustomerIdFromEntity: vi.fn(),
	getProviderPriceIdByPlanId: vi.fn(),
	isPlanId: vi.fn(),
}));

import { auth } from "@repo/auth";
import { getOrganizationById, getOrganizationMembership } from "@repo/database";
import {
	createCheckoutLink as createCheckoutLinkWithProvider,
	findPriceByPlanId,
	getCustomerIdFromEntity,
	getProviderPriceIdByPlanId,
	isPlanId,
} from "@repo/payments";

import { createCheckoutLink } from "./create-checkout-link";

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

describe("createCheckoutLink", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue(authenticatedSession);
	});

	it("rejects checkout management for an unauthorized organization", async () => {
		vi.mocked(getOrganizationMembership).mockResolvedValueOnce(null);
		vi.mocked(isPlanId).mockReturnValueOnce(true);
		vi.mocked(findPriceByPlanId).mockReturnValueOnce({
			type: "subscription",
			interval: "month",
			amount: 19,
			currency: "USD",
		});
		vi.mocked(getProviderPriceIdByPlanId).mockReturnValueOnce("price_creator_monthly");

		await expect(
			call(
				createCheckoutLink,
				{
					planId: "creator",
					type: "subscription",
					interval: "month",
					organizationId: "organization-2",
				},
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(getCustomerIdFromEntity).not.toHaveBeenCalled();
		expect(createCheckoutLinkWithProvider).not.toHaveBeenCalled();
	});

	it("fails closed before database or Stripe access when the configured Price ID is missing", async () => {
		vi.mocked(isPlanId).mockReturnValueOnce(true);
		vi.mocked(findPriceByPlanId).mockReturnValueOnce({
			type: "subscription",
			interval: "month",
			amount: 19,
			currency: "USD",
		});
		vi.mocked(getProviderPriceIdByPlanId).mockReturnValueOnce(null);

		await expect(
			call(
				createCheckoutLink,
				{
					planId: "creator",
					type: "subscription",
					interval: "month",
					redirectUrl: "http://localhost:3000/checkout-return",
				},
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(getCustomerIdFromEntity).not.toHaveBeenCalled();
		expect(findBillingPlan).not.toHaveBeenCalled();
		expect(createCheckoutLinkWithProvider).not.toHaveBeenCalled();
	});

	it("fails closed when the internal billing snapshot drifts from the canonical plan", async () => {
		vi.mocked(isPlanId).mockReturnValueOnce(true);
		vi.mocked(findPriceByPlanId).mockReturnValueOnce({
			type: "subscription",
			interval: "month",
			amount: 19,
			currency: "USD",
		});
		vi.mocked(getProviderPriceIdByPlanId).mockReturnValueOnce("price_creator_monthly");
		vi.mocked(getCustomerIdFromEntity).mockResolvedValueOnce(null);
		findBillingPlan.mockResolvedValueOnce({
			id: "billing-plan-drifted",
			active: true,
			name: "creator",
			metadata: { planId: "creator" },
			creditsPerPeriod: 999n,
			priceMicros: 19_000_000n,
			currency: "USD",
		} as never);

		await expect(
			call(
				createCheckoutLink,
				{
					planId: "creator",
					type: "subscription",
					interval: "month",
					redirectUrl: "http://localhost:3000/checkout-return",
				},
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(createCheckoutLinkWithProvider).not.toHaveBeenCalled();
	});

	it("allows organization owners to create checkout links", async () => {
		vi.mocked(getOrganizationMembership).mockResolvedValueOnce({ role: "owner" } as never);
		vi.mocked(getCustomerIdFromEntity).mockResolvedValueOnce(null);
		vi.mocked(isPlanId).mockReturnValueOnce(true);
		vi.mocked(findPriceByPlanId).mockReturnValueOnce({
			type: "subscription",
			interval: "month",
			amount: 19,
			currency: "USD",
			priceId: "price-1",
			seatBased: true,
		});
		vi.mocked(getProviderPriceIdByPlanId).mockReturnValueOnce("price-1");
		findBillingPlan.mockResolvedValueOnce({
			id: "billing-plan-1",
			active: true,
			name: "creator",
			metadata: { planId: "creator" },
			creditsPerPeriod: 1_000n,
			priceMicros: 19_000_000n,
			currency: "USD",
		} as never);
		vi.mocked(getOrganizationById).mockResolvedValueOnce({
			id: "organization-1",
			name: "Test Organization",
			slug: "test-organization",
			logo: null,
			createdAt: new Date(),
			metadata: null,
			paymentsCustomerId: null,
			members: [
				{
					id: "membership-1",
					organizationId: "organization-1",
					userId: "user-1",
					role: "owner",
					createdAt: new Date(),
				},
			],
			invitations: [],
		});
		vi.mocked(createCheckoutLinkWithProvider).mockResolvedValueOnce(
			"https://payments.example/checkout/session-1",
		);

		const result = await call(
			createCheckoutLink,
			{
				planId: "creator",
				type: "subscription",
				interval: "month",
				organizationId: "organization-1",
			},
			{ context: { headers: new Headers() } },
		);

		expect(result).toEqual({
			checkoutLink: "https://payments.example/checkout/session-1",
		});
		expect(createCheckoutLinkWithProvider).toHaveBeenCalledWith(
			expect.objectContaining({
				billingPlanId: "billing-plan-1",
				ownerId: "organization-1",
				ownerType: "ORGANIZATION",
				organizationId: "organization-1",
				planKey: "creator",
				seats: 1,
				submittedByUserId: "user-1",
			}),
		);
	});
});
