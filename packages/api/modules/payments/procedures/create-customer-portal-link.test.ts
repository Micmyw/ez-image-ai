import { call } from "@orpc/server";
import type { Session } from "@repo/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
		PurchaseSchema: z.object({}),
		getOrganizationMembership: vi.fn(),
		getPurchaseById: vi.fn(),
	};
});

vi.mock("@repo/payments", () => ({
	createCustomerPortalLink: vi.fn(),
	getPaymentProvider: vi.fn(),
}));

import { auth } from "@repo/auth";
import { getOrganizationMembership, getPurchaseById } from "@repo/database";
import {
	createCustomerPortalLink as createCustomerPortalLinkFn,
	getPaymentProvider,
} from "@repo/payments";

import { createCustomerPortalLink } from "./create-customer-portal-link";

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

const redirectUrl = new URL(
	"/settings/billing",
	process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000",
).toString();

describe("createCustomerPortalLink", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue(authenticatedSession);
		vi.mocked(createCustomerPortalLinkFn).mockResolvedValue("https://billing.stripe.test/session");
		vi.mocked(getPaymentProvider).mockReturnValue({
			name: "stripe",
			capabilities: {
				checkout: true,
				portal: true,
				cancellation: true,
				seatUpdates: true,
				webhooks: true,
			},
			createCheckout: vi.fn(),
			createPortal: vi.mocked(createCustomerPortalLinkFn),
		});
	});

	it("rejects an unowned purchase before creating a customer portal link", async () => {
		vi.mocked(getPurchaseById).mockResolvedValueOnce({
			id: "purchase-1",
			organizationId: null,
			userId: null,
			customerId: "cus_1",
			subscriptionId: null,
		} as never);

		await expect(
			call(
				createCustomerPortalLink,
				{ purchaseId: "purchase-1", redirectUrl },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(createCustomerPortalLinkFn).not.toHaveBeenCalled();
	});

	it("rejects a multiply owned purchase before creating a customer portal link", async () => {
		vi.mocked(getPurchaseById).mockResolvedValueOnce({
			id: "purchase-2",
			organizationId: "organization-1",
			userId: "user-1",
			customerId: "cus_2",
			subscriptionId: "sub_2",
		} as never);
		vi.mocked(getOrganizationMembership).mockResolvedValueOnce({ role: "owner" } as never);

		await expect(
			call(
				createCustomerPortalLink,
				{ purchaseId: "purchase-2", redirectUrl },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(createCustomerPortalLinkFn).not.toHaveBeenCalled();
	});

	it("fails closed when the purchase provider has no owner-scoped portal", async () => {
		vi.mocked(getPurchaseById).mockResolvedValueOnce({
			id: "purchase-paypal",
			provider: "paypal",
			organizationId: null,
			userId: "user-1",
			customerId: "paypal-customer",
			subscriptionId: "I-SUBSCRIPTION",
		} as never);
		vi.mocked(getPaymentProvider).mockReturnValueOnce({
			name: "paypal",
			capabilities: {
				checkout: true,
				portal: false,
				cancellation: true,
				seatUpdates: false,
				webhooks: true,
			},
			createCheckout: vi.fn(),
		});

		await expect(
			call(
				createCustomerPortalLink,
				{ purchaseId: "purchase-paypal", redirectUrl },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(createCustomerPortalLinkFn).not.toHaveBeenCalled();
	});
});
