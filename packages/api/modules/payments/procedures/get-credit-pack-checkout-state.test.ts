import { call } from "@orpc/server";
import type { Session } from "@repo/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPaymentCheckoutIntentForOwner, paymentsConfig, verifyOrganizationBillingManagement } =
	vi.hoisted(() => ({
		getPaymentCheckoutIntentForOwner: vi.fn(),
		paymentsConfig: { billingAttachedTo: "user" as "user" | "organization" },
		verifyOrganizationBillingManagement: vi.fn(),
	}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({ getPaymentCheckoutIntentForOwner }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/payments/config", () => ({ config: paymentsConfig }));
vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationBillingManagement,
}));

import { auth } from "@repo/auth";

import {
	getCreditPackCheckoutState,
	resolveCreditPackCheckoutState,
} from "./get-credit-pack-checkout-state";

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

describe("resolveCreditPackCheckoutState", () => {
	it("does not report COMPLETED until the credit-pack fulfillment exists", () => {
		expect(
			resolveCreditPackCheckoutState({ status: "COMPLETED", creditPackFulfillment: null }),
		).toEqual({ status: "PENDING" });
		expect(
			resolveCreditPackCheckoutState({
				status: "COMPLETED",
				creditPackFulfillment: { id: "fulfillment-1" },
			}),
		).toEqual({ status: "COMPLETED" });
	});

	it.each(["REVIEW", "EXPIRED", "CANCELED"] as const)(
		"preserves the terminal %s state",
		(status) => {
			expect(resolveCreditPackCheckoutState({ status, creditPackFulfillment: null })).toEqual({
				status,
			});
		},
	);
});

describe("getCreditPackCheckoutState", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		paymentsConfig.billingAttachedTo = "user";
		vi.mocked(auth.api.getSession).mockResolvedValue(authenticatedSession);
		verifyOrganizationBillingManagement.mockResolvedValue(null);
	});

	it("reads only the authenticated owner's credit-pack intent", async () => {
		getPaymentCheckoutIntentForOwner.mockResolvedValue({
			id: "credit-pack-intent-1",
			provider: "paypal",
			productKind: "CREDIT_PACK",
			status: "PROVIDER_PENDING",
			billingPlan: { productKind: "CREDIT_PACK" },
			creditPackFulfillment: null,
		});

		await expect(
			call(
				getCreditPackCheckoutState,
				{ intentId: "credit-pack-intent-1" },
				{ context: { headers: new Headers() } },
			),
		).resolves.toEqual({ status: "PENDING" });
		expect(getPaymentCheckoutIntentForOwner).toHaveBeenCalledWith(
			{ intentId: "credit-pack-intent-1", ownerType: "USER", ownerId: "user-1" },
			expect.anything(),
		);
	});

	it("does not reveal an intent outside the owner scope", async () => {
		getPaymentCheckoutIntentForOwner.mockResolvedValue(null);

		await expect(
			call(
				getCreditPackCheckoutState,
				{ intentId: "credit-pack-intent-1" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("fails closed when organization billing ownership is missing", async () => {
		paymentsConfig.billingAttachedTo = "organization";
		vi.mocked(auth.api.getSession).mockResolvedValue({
			...authenticatedSession,
			session: {
				...authenticatedSession.session,
				activeOrganizationId: "organization-1",
			},
		});

		await expect(
			call(
				getCreditPackCheckoutState,
				{ intentId: "credit-pack-intent-1" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(getPaymentCheckoutIntentForOwner).not.toHaveBeenCalled();
	});

	it("does not surface a Stripe credit-pack state", async () => {
		getPaymentCheckoutIntentForOwner.mockResolvedValue({
			id: "credit-pack-intent-1",
			provider: "stripe",
			productKind: "CREDIT_PACK",
			status: "COMPLETED",
			billingPlan: { productKind: "CREDIT_PACK" },
			creditPackFulfillment: { id: "fulfillment-1" },
		});

		await expect(
			call(
				getCreditPackCheckoutState,
				{ intentId: "credit-pack-intent-1" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
