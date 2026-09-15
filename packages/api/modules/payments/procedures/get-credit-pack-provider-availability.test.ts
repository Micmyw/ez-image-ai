import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	findBillingPlan,
	getCreditPackProviderProductId,
	isPaymentProviderCheckoutAvailable,
	resolveCreditPackProviderAvailability,
} = vi.hoisted(() => ({
	findBillingPlan: vi.fn(),
	getCreditPackProviderProductId: vi.fn(),
	isPaymentProviderCheckoutAvailable: vi.fn(),
	resolveCreditPackProviderAvailability: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({
	db: { billingPlan: { findUnique: findBillingPlan } },
}));
vi.mock("@repo/payments", () => ({
	getCreditPackProviderProductId,
	isPaymentProviderCheckoutAvailable,
}));
vi.mock("../provider-availability", () => ({ resolveCreditPackProviderAvailability }));

import { auth } from "@repo/auth";

import {
	creditPackProviderAvailabilityInputSchema,
	getCreditPackProviderAvailability,
} from "./get-credit-pack-provider-availability";

describe("getCreditPackProviderAvailability", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getCreditPackProviderProductId.mockReturnValue("PROD-CREDITS-1500");
		isPaymentProviderCheckoutAvailable.mockResolvedValue(true);
		findBillingPlan.mockResolvedValue(null);
	});

	it("is public and returns only the server-authorized PayPal and Waffo choices", async () => {
		resolveCreditPackProviderAvailability.mockImplementation(async (selection, dependencies) => {
			expect(selection).toEqual({ packKey: "credits-1500" });
			expect(await dependencies.isCheckoutAvailable("paypal")).toBe(true);
			expect(dependencies.getProviderProductId("paypal")).toBe("PROD-CREDITS-1500");
			await expect(dependencies.findBillingPlan("paypal", "PROD-CREDITS-1500")).resolves.toBeNull();
			return [
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
			];
		});

		await expect(
			call(
				getCreditPackProviderAvailability,
				{ packKey: "credits-1500" },
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
		expect(auth.api.getSession).not.toHaveBeenCalled();
	});

	it("rejects fields that could select a provider product or Stripe", () => {
		expect(
			creditPackProviderAvailabilityInputSchema.safeParse({
				packKey: "credits-1500",
				provider: "stripe",
				providerProductId: "price_attacker_controlled",
			}),
		).toMatchObject({ success: false });
	});

	it("defensively excludes Stripe from the public response", async () => {
		resolveCreditPackProviderAvailability.mockResolvedValue([
			{
				name: "stripe",
				capabilities: {
					checkout: true,
					portal: true,
					cancellation: true,
					seatUpdates: true,
					webhooks: true,
				},
			},
		]);

		await expect(
			call(
				getCreditPackProviderAvailability,
				{ packKey: "credits-1500" },
				{ context: { headers: new Headers() } },
			),
		).resolves.toEqual({ providers: [] });
	});
});
