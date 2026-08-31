import { describe, expect, it, vi } from "vitest";

import type { PaymentProvider } from "../types";
import { cancelProviderSubscription, setProviderSubscriptionSeats } from "./management";

describe("provider-aware subscription management", () => {
	it("routes cancellation through the explicitly selected provider", async () => {
		const cancelSubscription = vi.fn();
		const provider = paymentProvider("paypal", { cancelSubscription });

		await expect(
			cancelProviderSubscription("paypal", "I-SUBSCRIPTION", () => provider),
		).resolves.toBeUndefined();
		expect(cancelSubscription).toHaveBeenCalledWith("I-SUBSCRIPTION");
	});

	it("rejects unsupported seat updates without falling back to another provider", async () => {
		const provider = paymentProvider("waffo", {});
		await expect(
			setProviderSubscriptionSeats("waffo", "ORD-SUBSCRIPTION", 3, () => provider),
		).rejects.toThrow("PAYMENT_PROVIDER_SEAT_UPDATES_UNSUPPORTED");
	});
});

function paymentProvider(
	name: PaymentProvider["name"],
	methods: Partial<Pick<PaymentProvider, "cancelSubscription" | "setSubscriptionSeats">>,
): PaymentProvider {
	return {
		name,
		capabilities: {
			checkout: true,
			portal: name === "stripe",
			cancellation: Boolean(methods.cancelSubscription),
			seatUpdates: Boolean(methods.setSubscriptionSeats),
			webhooks: true,
		},
		createCheckout: vi.fn(),
		...methods,
	};
}
