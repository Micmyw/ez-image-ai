import { call } from "@orpc/server";
import type { Session } from "@repo/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	captureCheckout,
	getPaymentCheckoutIntentForOwner,
	getPaymentProvider,
	ingestPaymentEvent,
	isPaymentProviderConfigured,
	paymentsConfig,
	verifyOrganizationBillingManagement,
} = vi.hoisted(() => ({
	captureCheckout: vi.fn(),
	getPaymentCheckoutIntentForOwner: vi.fn(),
	getPaymentProvider: vi.fn(),
	ingestPaymentEvent: vi.fn(),
	isPaymentProviderConfigured: vi.fn(),
	paymentsConfig: { billingAttachedTo: "user" as "user" | "organization" },
	verifyOrganizationBillingManagement: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	getPaymentCheckoutIntentForOwner,
	ingestPaymentEvent,
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));
vi.mock("@repo/payments", () => ({ getPaymentProvider, isPaymentProviderConfigured }));
vi.mock("@repo/payments/config", () => ({ config: paymentsConfig }));
vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationBillingManagement,
}));

import { auth } from "@repo/auth";

import {
	capturePayPalCreditPackCheckout,
	capturePayPalCreditPackCheckoutInputSchema,
} from "./capture-paypal-credit-pack-checkout";

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

const intent = {
	id: "credit-pack-intent-1",
	provider: "paypal",
	productKind: "CREDIT_PACK",
	status: "PROVIDER_PENDING",
	providerSessionId: "PAYPAL-ORDER-1",
	providerOrderId: "PAYPAL-ORDER-1",
	billingPlan: { productKind: "CREDIT_PACK" },
	creditPackFulfillment: null,
};

function capturedEvent(overrides: Record<string, unknown> = {}) {
	return {
		providerEventId: "capture-response:PAYPAL-CAPTURE-1",
		normalizedTransactionId: "PAYPAL-CAPTURE-1",
		envelope: {
			id: "capture-response:PAYPAL-CAPTURE-1",
			event_type: "PAYMENT.CAPTURE.COMPLETED",
			resource: {
				id: "PAYPAL-CAPTURE-1",
				status: "COMPLETED",
				custom_id: "credit-pack-intent-1",
				supplementary_data: { related_ids: { order_id: "PAYPAL-ORDER-1" } },
				...overrides,
			},
		},
	};
}

describe("capturePayPalCreditPackCheckout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-06T09:00:00.000Z"));
		vi.clearAllMocks();
		paymentsConfig.billingAttachedTo = "user";
		vi.mocked(auth.api.getSession).mockResolvedValue(authenticatedSession);
		getPaymentCheckoutIntentForOwner.mockResolvedValue(intent);
		isPaymentProviderConfigured.mockReturnValue(true);
		captureCheckout.mockResolvedValue(capturedEvent());
		getPaymentProvider.mockReturnValue({ captureCheckout });
		ingestPaymentEvent.mockResolvedValue({ event: { id: "payment-event-1" }, replayed: false });
		verifyOrganizationBillingManagement.mockResolvedValue(null);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not accept a client-controlled idempotency key", () => {
		expect(
			capturePayPalCreditPackCheckoutInputSchema.safeParse({
				intentId: "credit-pack-intent-1",
				providerOrderId: "PAYPAL-ORDER-1",
				idempotencyKey: "attacker-controlled",
			}),
		).toMatchObject({ success: false });
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
				capturePayPalCreditPackCheckout,
				{ intentId: "credit-pack-intent-1", providerOrderId: "PAYPAL-ORDER-1" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(getPaymentCheckoutIntentForOwner).not.toHaveBeenCalled();
		expect(captureCheckout).not.toHaveBeenCalled();
	});

	it("captures the owner-scoped order with a stable bounded key and only ingests its event", async () => {
		await expect(
			call(
				capturePayPalCreditPackCheckout,
				{ intentId: "credit-pack-intent-1", providerOrderId: "PAYPAL-ORDER-1" },
				{ context: { headers: new Headers() } },
			),
		).resolves.toEqual({ accepted: true, replayed: false });

		const firstKey = captureCheckout.mock.calls[0]?.[0]?.idempotencyKey as string;
		expect(firstKey).toMatch(/^cp-[a-f0-9]{35}$/);
		expect(Buffer.byteLength(firstKey)).toBeLessThanOrEqual(38);
		await call(
			capturePayPalCreditPackCheckout,
			{ intentId: "credit-pack-intent-1", providerOrderId: "PAYPAL-ORDER-1" },
			{ context: { headers: new Headers() } },
		);
		expect(captureCheckout.mock.calls[1]?.[0]?.idempotencyKey).toBe(firstKey);
		expect(ingestPaymentEvent).toHaveBeenCalledWith(
			{
				provider: "paypal",
				providerEventId: "capture-response:PAYPAL-CAPTURE-1",
				normalizedTransactionId: "PAYPAL-CAPTURE-1",
				verifiedAt: new Date("2026-09-06T09:00:00.000Z"),
				receivedAt: new Date("2026-09-06T09:00:00.000Z"),
				envelope: capturedEvent().envelope,
			},
			expect.anything(),
		);
	});

	it("rejects a capture fact that is not correlated to the trusted intent", async () => {
		captureCheckout.mockResolvedValue(capturedEvent({ custom_id: "different-intent" }));

		await expect(
			call(
				capturePayPalCreditPackCheckout,
				{ intentId: "credit-pack-intent-1", providerOrderId: "PAYPAL-ORDER-1" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
		expect(ingestPaymentEvent).not.toHaveBeenCalled();
	});

	it("does not capture an order outside the authenticated owner scope", async () => {
		getPaymentCheckoutIntentForOwner.mockResolvedValue(null);

		await expect(
			call(
				capturePayPalCreditPackCheckout,
				{ intentId: "credit-pack-intent-1", providerOrderId: "PAYPAL-ORDER-1" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(captureCheckout).not.toHaveBeenCalled();
		expect(ingestPaymentEvent).not.toHaveBeenCalled();
	});

	it("does not capture a Stripe credit-pack intent", async () => {
		getPaymentCheckoutIntentForOwner.mockResolvedValue({
			...intent,
			provider: "stripe",
		});

		await expect(
			call(
				capturePayPalCreditPackCheckout,
				{ intentId: "credit-pack-intent-1", providerOrderId: "PAYPAL-ORDER-1" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(captureCheckout).not.toHaveBeenCalled();
		expect(ingestPaymentEvent).not.toHaveBeenCalled();
	});

	it("returns an idempotent acknowledgement after fulfillment already exists", async () => {
		getPaymentCheckoutIntentForOwner.mockResolvedValue({
			...intent,
			status: "COMPLETED",
			creditPackFulfillment: { id: "fulfillment-1" },
		});

		await expect(
			call(
				capturePayPalCreditPackCheckout,
				{ intentId: "credit-pack-intent-1", providerOrderId: "PAYPAL-ORDER-1" },
				{ context: { headers: new Headers() } },
			),
		).resolves.toEqual({ accepted: true, replayed: true });
		expect(captureCheckout).not.toHaveBeenCalled();
	});
});
