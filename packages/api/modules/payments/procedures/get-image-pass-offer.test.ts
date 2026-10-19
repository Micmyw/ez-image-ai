import { call } from "@orpc/server";
import { getImagePassOfferSnapshot } from "@repo/config/image-pass";
import { IMAGE_PASS_PAYPAL_SKU } from "@repo/config/image-pass.server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({ assertLiveBillingDataIsolation: vi.fn() }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/payments", () => ({
	isPaymentProviderCheckoutAvailable: vi.fn(),
	findPriceByPlanId: vi.fn(),
	resolvePaymentProvider: vi.fn(),
}));
import { getImagePassOffer, resolveImagePassOfferAvailability } from "./get-image-pass-offer";

const plan = {
	provider: "paypal",
	providerPriceId: IMAGE_PASS_PAYPAL_SKU,
	productKind: "IMAGE_PASS",
	name: "image-pass-3",
	active: true,
	priceMicros: 1_000_000n,
	currency: "USD",
	creditsPerPeriod: 0n,
	metadata: { imagePassOfferSnapshot: getImagePassOfferSnapshot() },
};
const dependencies = () => ({
	isBillingEnabled: () => true,
	findPlan: vi.fn(async () => plan),
	isCheckoutAvailable: vi.fn(async () => true),
	assertEnvironmentReady: vi.fn(async () => {}),
});
afterEach(() => vi.unstubAllEnvs());
describe("public image-pass offer availability", () => {
	it("exposes only availability for an exact active server-owned offer", async () => {
		await expect(resolveImagePassOfferAvailability(dependencies())).resolves.toEqual({
			available: true,
		});
	});
	it.each([
		null,
		{ ...plan, active: false },
		{ ...plan, currency: "EUR" },
		{ ...plan, priceMicros: 2_000_000n },
		{ ...plan, providerPriceId: "other-offer" },
	])("hides absent, inactive or mismatched metadata", async (candidate) => {
		const deps = { ...dependencies(), findPlan: async () => candidate };
		await expect(resolveImagePassOfferAvailability(deps)).resolves.toEqual({ available: false });
		expect(deps.assertEnvironmentReady).not.toHaveBeenCalled();
	});
	it.each(["billing-disabled", "provider-unavailable", "isolation-failed", "database-unavailable"])(
		"fails closed for %s",
		async (failure) => {
			const deps = dependencies();
			if (failure === "billing-disabled") deps.isBillingEnabled = () => false;
			if (failure === "provider-unavailable") deps.isCheckoutAvailable.mockResolvedValue(false);
			if (failure === "isolation-failed")
				deps.assertEnvironmentReady.mockRejectedValue(new Error("internal detail"));
			if (failure === "database-unavailable")
				deps.findPlan.mockRejectedValue(new Error("internal detail"));
			await expect(resolveImagePassOfferAvailability(deps)).resolves.toEqual({ available: false });
		},
	);
	it("does not advertise a billing row from another provider environment", async () => {
		vi.stubEnv("PAYPAL_ENVIRONMENT", "live");
		await expect(
			resolveImagePassOfferAvailability({
				...dependencies(),
				findPlan: async () => ({
					...plan,
					metadata: { ...plan.metadata, providerEnvironment: "sandbox" },
				}),
			}),
		).resolves.toEqual({ available: false });
	});
	it("is public and returns no-store availability without loading an owner", async () => {
		vi.stubEnv("BILLING_ENABLED", "false");
		const responseHeaders = new Headers();
		await expect(
			call(getImagePassOffer, undefined, { context: { headers: new Headers(), responseHeaders } }),
		).resolves.toEqual({ available: false });
		expect(responseHeaders.get("Cache-Control")).toBe("no-store");
	});
});
