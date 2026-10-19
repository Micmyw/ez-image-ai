import { call } from "@orpc/server";
import type { Session } from "@repo/auth";
import { getImagePassOfferSnapshot } from "@repo/config/image-pass";
import { IMAGE_PASS_PAYPAL_SKU } from "@repo/config/image-pass.server";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
	intent: vi.fn(),
	byKey: vi.fn(),
	createIntent: vi.fn(),
	plan: vi.fn(),
	bind: vi.fn(),
	mark: vi.fn(),
	customer: vi.fn(),
	provider: vi.fn(),
	checkout: vi.fn(),
	capture: vi.fn(),
	ingest: vi.fn(),
	grant: vi.fn(),
}));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	getPaymentCheckoutIntentForOwner: mocks.intent,
	getPaymentCheckoutIntentForOwnerByIdempotencyKey: mocks.byKey,
	createPaymentCheckoutIntent: mocks.createIntent,
	bindPaymentCheckoutIntentSession: mocks.bind,
	markPaymentCheckoutIntentProviderCreating: mocks.mark,
	getPaymentCustomer: mocks.customer,
	ingestPaymentEvent: mocks.ingest,
	getImagePassPurchaseForCheckoutIntent: mocks.grant,
}));
vi.mock("@repo/database/client", () => ({ db: { billingPlan: { findUnique: mocks.plan } } }));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));
vi.mock("@repo/payments", async () => ({
	getPaymentProvider: mocks.provider,
	isPaymentProviderConfigured: () => true,
	isPaymentProviderCheckoutAvailable: async () => true,
	normalizeProviderPaymentEvent: (
		await import("../../../../payments/provider/lifecycle-normalization")
	).normalizeProviderPaymentEvent,
}));
vi.mock("../billing-gate", () => ({
	assertNewBillingEnabled: vi.fn(),
	assertBillingEnvironmentReady: vi.fn(),
}));
vi.mock("../checkout-attribution", async () => ({
	...(await vi.importActual("../checkout-attribution")),
	captureCheckoutAttribution: async () => undefined,
}));
vi.mock("./checkout-recovery", () => ({ recoverProviderCreatingCheckout: vi.fn() }));
import { auth } from "@repo/auth";

import { capturePayPalImagePassCheckout } from "./capture-paypal-image-pass-checkout";
import {
	createImagePassCheckout,
	imagePassCheckoutInputSchema,
} from "./create-image-pass-checkout";
import {
	getImagePassCheckoutState,
	resolveImagePassCheckoutState,
} from "./get-image-pass-checkout-state";
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

const plan = {
	id: "plan-image-pass",
	provider: "paypal",
	providerPriceId: IMAGE_PASS_PAYPAL_SKU,
	productKind: "IMAGE_PASS",
	active: true,
	name: "image-pass-3",
	creditsPerPeriod: 0n,
	priceMicros: 1000000n,
	currency: "USD",
	metadata: { imagePassOfferSnapshot: getImagePassOfferSnapshot() },
};
const intent = {
	id: "intent-image-pass",
	provider: "paypal",
	ownerType: "USER",
	ownerId: "user-1",
	submittedByUserId: "user-1",
	productKind: "IMAGE_PASS",
	planKey: "image-pass-3",
	interval: "one-time",
	idempotencyKey: "image-pass-attempt-1",
	billingPlanId: plan.id,
	billingPlan: plan,
	imagePassOfferSnapshot: getImagePassOfferSnapshot(),
	status: "CREATED",
	providerOrderId: "ORDER-1",
	providerSessionId: "ORDER-1",
};
const input = { provider: "paypal" as const, idempotencyKey: "image-pass-attempt-1" };
const context = { context: { headers: new Headers() } };
function captured(patch: Record<string, unknown> = {}) {
	return {
		providerEventId: "capture-response:CAPTURE-1",
		normalizedTransactionId: "CAPTURE-1",
		envelope: {
			id: "capture-response:CAPTURE-1",
			event_type: "PAYMENT.CAPTURE.COMPLETED",
			resource: {
				id: "CAPTURE-1",
				status: "COMPLETED",
				final_capture: true,
				custom_id: intent.id,
				amount: { value: "1.00", currency_code: "USD" },
				create_time: "2026-10-19T12:00:00.000Z",
				supplementary_data: { related_ids: { order_id: "ORDER-1" } },
				...patch,
			},
		},
	};
}
describe("PayPal image-pass checkout", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://app.ezpic.test");
		vi.mocked(auth.api.getSession).mockResolvedValue(authenticatedSession);
		mocks.intent.mockResolvedValue(intent);
		mocks.byKey.mockResolvedValue(null);
		mocks.plan.mockResolvedValue(plan);
		mocks.createIntent.mockResolvedValue({ intent, replayed: false });
		mocks.customer.mockResolvedValue(null);
		mocks.checkout.mockResolvedValue({
			checkoutUrl: "https://www.sandbox.paypal.com/approve",
			providerSessionId: "ORDER-1",
			expiresAt: null,
		});
		mocks.provider.mockReturnValue({
			capabilities: { checkout: true },
			createCheckout: mocks.checkout,
			captureCheckout: mocks.capture,
		});
		mocks.capture.mockResolvedValue(captured());
		mocks.ingest.mockResolvedValue({ replayed: false });
		mocks.grant.mockResolvedValue(null);
	});
	afterEach(() => vi.unstubAllEnvs());
	it.each([
		{ provider: "waffo" },
		{ amount: "0.01" },
		{ currency: "EUR" },
		{ units: 30 },
		{ packKey: "credits-1500" },
	])("rejects provider and client price overrides %j", (patch) =>
		expect(imagePassCheckoutInputSchema.safeParse({ ...input, ...patch }).success).toBe(false),
	);
	it("creates only the server priced one-dollar order and frozen three-image snapshot", async () => {
		await expect(call(createImagePassCheckout, input, context)).resolves.toEqual({
			checkoutLink: "https://www.sandbox.paypal.com/approve",
			intentId: intent.id,
		});
		expect(mocks.createIntent).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "paypal",
				ownerType: "USER",
				ownerId: "user-1",
				productKind: "IMAGE_PASS",
				imagePassOfferSnapshot: getImagePassOfferSnapshot(),
			}),
			expect.anything(),
		);
		expect(mocks.checkout).toHaveBeenCalledWith(
			expect.objectContaining({
				priceId: IMAGE_PASS_PAYPAL_SKU,
				currency: "USD",
				amountMicros: 1000000n,
				redirectUrl: `https://app.ezpic.test/image-pass-checkout-return?intentId=${intent.id}`,
			}),
		);
	});
	it.each([
		{ priceMicros: 1n },
		{ currency: "EUR" },
		{ providerPriceId: "another-sku" },
		{ creditsPerPeriod: 75n },
		{ metadata: {} },
	])("fails closed on mismatched server catalog %s", async (patch) => {
		mocks.plan.mockResolvedValue({ ...plan, ...patch });
		await expect(call(createImagePassCheckout, input, context)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.checkout).not.toHaveBeenCalled();
	});
	it("reuses the same pending intent without another provider order", async () => {
		mocks.byKey.mockResolvedValue({
			...intent,
			status: "PROVIDER_PENDING",
			providerCheckoutUrl: "https://www.sandbox.paypal.com/existing",
		});
		await expect(call(createImagePassCheckout, input, context)).resolves.toEqual({
			checkoutLink: "https://www.sandbox.paypal.com/existing",
			intentId: intent.id,
		});
		expect(mocks.createIntent).not.toHaveBeenCalled();
		expect(mocks.checkout).not.toHaveBeenCalled();
	});
	it("accepts a new purchase key after a prior checkout, without subscriber eligibility", async () => {
		await call(
			createImagePassCheckout,
			{ ...input, idempotencyKey: "image-pass-repeat-2" },
			context,
		);
		expect(mocks.createIntent).toHaveBeenCalledWith(
			expect.objectContaining({ idempotencyKey: "image-pass-repeat-2" }),
			expect.anything(),
		);
	});
	it("captures only the owner-bound trusted order and queues verified facts", async () => {
		mocks.intent.mockResolvedValue({ ...intent, status: "PROVIDER_PENDING" });
		await expect(
			call(
				capturePayPalImagePassCheckout,
				{ intentId: intent.id, providerOrderId: "ORDER-1" },
				context,
			),
		).resolves.toEqual({ accepted: true, replayed: false });
		expect(mocks.capture).toHaveBeenCalledWith({
			providerOrderId: "ORDER-1",
			idempotencyKey: expect.stringMatching(/^ip-[a-f0-9]{35}$/),
		});
		expect(mocks.ingest).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "paypal",
				verifiedAt: expect.any(Date),
				normalizedTransactionId: "CAPTURE-1",
			}),
			expect.anything(),
		);
	});
	it.each([
		{ amount: { value: "0.01", currency_code: "USD" } },
		{ amount: { value: "1.00", currency_code: "EUR" } },
		{ final_capture: false },
		{ custom_id: "somebody-else" },
		{ supplementary_data: { related_ids: { order_id: "another" } } },
	])("refuses mismatched or incomplete capture %j", async (patch) => {
		mocks.intent.mockResolvedValue({ ...intent, status: "PROVIDER_PENDING" });
		mocks.capture.mockResolvedValue(captured(patch));
		await expect(
			call(
				capturePayPalImagePassCheckout,
				{ intentId: intent.id, providerOrderId: "ORDER-1" },
				context,
			),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
		expect(mocks.ingest).not.toHaveBeenCalled();
	});
	it("cannot capture another owner's order", async () => {
		mocks.intent.mockResolvedValue(null);
		await expect(
			call(
				capturePayPalImagePassCheckout,
				{ intentId: intent.id, providerOrderId: "ORDER-1" },
				context,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.capture).not.toHaveBeenCalled();
	});
	it("repeated returns acknowledge an existing grant without a payment call", async () => {
		mocks.intent.mockResolvedValue({ ...intent, status: "COMPLETED" });
		mocks.grant.mockResolvedValue({ id: "grant-1", status: "ACTIVE" });
		await expect(
			call(
				capturePayPalImagePassCheckout,
				{ intentId: intent.id, providerOrderId: "ORDER-1" },
				context,
			),
		).resolves.toEqual({ accepted: true, replayed: true });
		expect(mocks.capture).not.toHaveBeenCalled();
	});
	it("state remains pending until the persisted grant exists", async () => {
		mocks.intent.mockResolvedValue({ ...intent, status: "COMPLETED" });
		await expect(
			call(getImagePassCheckoutState, { intentId: intent.id }, context),
		).resolves.toEqual({ status: "PENDING" });
		mocks.grant.mockResolvedValue({ id: "grant-1", status: "ACTIVE" });
		await expect(
			call(getImagePassCheckoutState, { intentId: intent.id }, context),
		).resolves.toEqual({ status: "COMPLETED" });
		expect(
			resolveImagePassCheckoutState({
				status: "COMPLETED",
				imagePassGrant: { id: "grant-1", status: "FROZEN" },
			}),
		).toEqual({ status: "REVIEW" });
	});
});
