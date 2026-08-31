import { call } from "@orpc/server";
import type { Session } from "@repo/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveProviderAvailability } = vi.hoisted(() => ({
	resolveProviderAvailability: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({
	db: { billingPlan: { findUnique: vi.fn() } },
}));
vi.mock("@repo/payments", () => ({
	getProviderPriceIdByPlanId: vi.fn(),
	isPaymentProviderConfigured: vi.fn(),
	paymentProviderNames: ["stripe", "paypal", "waffo"],
}));
vi.mock("../provider-availability", () => ({ resolveProviderAvailability }));

import { auth } from "@repo/auth";

import { getProviderAvailability } from "./get-provider-availability";

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

describe("getProviderAvailability", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue(authenticatedSession);
	});

	it("returns the authenticated server-advertised provider choices", async () => {
		resolveProviderAvailability.mockResolvedValue([
			{
				name: "paypal",
				capabilities: {
					checkout: true,
					portal: false,
					cancellation: true,
					seatUpdates: false,
					webhooks: true,
				},
			},
		]);

		await expect(
			call(
				getProviderAvailability,
				{ planId: "creator", interval: "month" },
				{ context: { headers: new Headers() } },
			),
		).resolves.toEqual({
			providers: [
				{
					name: "paypal",
					capabilities: {
						checkout: true,
						portal: false,
						cancellation: true,
						seatUpdates: false,
						webhooks: true,
					},
				},
			],
		});
	});
});
