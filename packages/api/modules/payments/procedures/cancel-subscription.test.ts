import { call } from "@orpc/server";
import type { Session } from "@repo/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { cancelSubscription, getPaymentProvider } = vi.hoisted(() => ({
	cancelSubscription: vi.fn(),
	getPaymentProvider: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	getOrganizationMembership: vi.fn(),
	getPurchaseById: vi.fn(),
}));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));
vi.mock("@repo/payments", () => ({ getPaymentProvider }));

import { auth } from "@repo/auth";
import { getPurchaseById } from "@repo/database";

import { cancelPurchaseSubscription } from "./cancel-subscription";

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

describe("cancelPurchaseSubscription", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue(authenticatedSession);
		vi.mocked(getPurchaseById).mockResolvedValue({
			id: "purchase-paypal",
			provider: "paypal",
			userId: "user-1",
			organizationId: null,
			subscriptionId: "I-SUBSCRIPTION",
		} as never);
		getPaymentProvider.mockReturnValue({
			name: "paypal",
			capabilities: {
				checkout: true,
				portal: false,
				cancellation: true,
				seatUpdates: false,
				webhooks: true,
			},
			createCheckout: vi.fn(),
			cancelSubscription,
		});
	});

	it("routes cancellation through the provider recorded on the owned purchase", async () => {
		await expect(
			call(
				cancelPurchaseSubscription,
				{ purchaseId: "purchase-paypal" },
				{ context: { headers: new Headers() } },
			),
		).resolves.toEqual({ status: "CANCEL_REQUESTED" });
		expect(getPaymentProvider).toHaveBeenCalledWith("paypal");
		expect(cancelSubscription).toHaveBeenCalledWith("I-SUBSCRIPTION");
	});

	it("fails closed when the provider does not implement cancellation", async () => {
		getPaymentProvider.mockReturnValueOnce({
			name: "paypal",
			capabilities: {
				checkout: true,
				portal: false,
				cancellation: false,
				seatUpdates: false,
				webhooks: true,
			},
			createCheckout: vi.fn(),
		});
		await expect(
			call(
				cancelPurchaseSubscription,
				{ purchaseId: "purchase-paypal" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(cancelSubscription).not.toHaveBeenCalled();
	});
});
