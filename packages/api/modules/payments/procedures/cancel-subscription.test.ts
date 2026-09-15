import { call } from "@orpc/server";
import type { Session } from "@repo/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { cancelSubscription, getPaymentProvider, requestSubscriptionCancellation } = vi.hoisted(
	() => ({
		cancelSubscription: vi.fn(),
		getPaymentProvider: vi.fn(),
		requestSubscriptionCancellation: vi.fn(),
	}),
);

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	getOrganizationMembership: vi.fn(),
	getPurchaseById: vi.fn(),
}));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/payments", () => ({ getPaymentProvider, requestSubscriptionCancellation }));

import { auth } from "@repo/auth";
import { getPurchaseById, getOrganizationMembership } from "@repo/database";

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
		expect(requestSubscriptionCancellation).toHaveBeenCalledWith(
			{
				purchaseId: "purchase-paypal",
				ownerType: "USER",
				ownerId: "user-1",
			},
			{},
		);
		expect(cancelSubscription).not.toHaveBeenCalled();
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

	it("rejects another user's purchase before queuing a cancellation", async () => {
		vi.mocked(getPurchaseById).mockResolvedValue({
			id: "other-purchase",
			provider: "paypal",
			userId: "other-user",
			organizationId: null,
			subscriptionId: "other-subscription",
		} as never);
		await expect(
			call(
				cancelPurchaseSubscription,
				{ purchaseId: "other-purchase" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(requestSubscriptionCancellation).not.toHaveBeenCalled();
	});

	it.each(["owner", "member"])(
		"requires organization ownership for an organization %s",
		async (role) => {
			vi.mocked(getPurchaseById).mockResolvedValue({
				id: "org-purchase",
				provider: "waffo",
				userId: null,
				organizationId: "org-1",
				subscriptionId: "org-subscription",
			} as never);
			vi.mocked(getOrganizationMembership).mockResolvedValue({ role } as never);
			const result = call(
				cancelPurchaseSubscription,
				{ purchaseId: "org-purchase" },
				{ context: { headers: new Headers() } },
			);
			if (role === "owner") {
				await expect(result).resolves.toEqual({ status: "CANCEL_REQUESTED" });
				expect(requestSubscriptionCancellation).toHaveBeenCalledWith(
					{
						purchaseId: "org-purchase",
						ownerType: "ORGANIZATION",
						ownerId: "org-1",
					},
					{},
				);
			} else {
				await expect(result).rejects.toMatchObject({ code: "NOT_FOUND" });
				expect(requestSubscriptionCancellation).not.toHaveBeenCalled();
			}
			expect(cancelSubscription).not.toHaveBeenCalled();
		},
	);

	it("does not claim acceptance when the durable request cannot be saved", async () => {
		requestSubscriptionCancellation.mockRejectedValueOnce(new Error("database failure"));
		await expect(
			call(
				cancelPurchaseSubscription,
				{ purchaseId: "purchase-paypal" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
		expect(cancelSubscription).not.toHaveBeenCalled();
	});
});
