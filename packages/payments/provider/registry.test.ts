import { describe, expect, it } from "vitest";

import type { PaymentProvider } from "../types";
import {
	createPaymentProviderRegistry,
	isPaymentProviderConfigured,
	paymentProviderNames,
	resolvePaymentProvider,
} from "./registry";

describe("payment provider registry", () => {
	it("resolves concrete providers by namespace without falling back to Stripe", () => {
		const createProvider = (name: PaymentProvider["name"]): PaymentProvider => ({
			name,
			capabilities: resolvePaymentProvider(name)!.capabilities,
			createCheckout: async () => ({
				checkoutUrl: `https://${name}.test/checkout`,
				providerSessionId: `${name}-session`,
				expiresAt: null,
			}),
		});
		const stripe = createProvider("stripe");
		const paypal = createProvider("paypal");
		const waffo = createProvider("waffo");
		const registry = createPaymentProviderRegistry({ stripe, paypal, waffo });

		expect(registry.resolve("paypal")).toBe(paypal);
		expect(registry.resolve("waffo")).toBe(waffo);
		expect(registry.resolve("unknown")).toBeNull();
		expect(registry.resolve("stripe")).toBe(stripe);
	});

	it("resolves the three explicit providers without colliding barrel exports", () => {
		expect(paymentProviderNames).toEqual(["stripe", "paypal", "waffo"]);
		expect(resolvePaymentProvider("stripe")?.name).toBe("stripe");
		expect(resolvePaymentProvider("paypal")?.name).toBe("paypal");
		expect(resolvePaymentProvider("waffo")?.name).toBe("waffo");
		expect(resolvePaymentProvider("unknown")).toBeNull();
	});

	it("advertises only capabilities each provider actually implements", () => {
		expect(resolvePaymentProvider("stripe")?.capabilities).toEqual({
			checkout: true,
			portal: true,
			cancellation: true,
			seatUpdates: true,
			webhooks: true,
		});
		expect(resolvePaymentProvider("paypal")?.capabilities).toEqual({
			checkout: true,
			portal: false,
			cancellation: true,
			seatUpdates: false,
			webhooks: true,
		});
		expect(resolvePaymentProvider("waffo")?.capabilities).toEqual({
			checkout: true,
			portal: false,
			cancellation: true,
			seatUpdates: false,
			webhooks: true,
		});
	});

	it("fails provider configuration closed unless every credential is present", () => {
		const paypal = {
			PAYPAL_CLIENT_ID: "client-id",
			PAYPAL_CLIENT_SECRET: "client-secret",
			PAYPAL_WEBHOOK_ID: "webhook-id",
			PAYPAL_ENVIRONMENT: "sandbox",
		};
		expect(isPaymentProviderConfigured("paypal", paypal)).toBe(true);
		expect(isPaymentProviderConfigured("paypal", { ...paypal, PAYPAL_WEBHOOK_ID: "" })).toBe(false);

		const waffo = {
			WAFFO_MERCHANT_ID: "MER_merchant",
			WAFFO_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
			WAFFO_WEBHOOK_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----",
			WAFFO_ENVIRONMENT: "test",
		};
		expect(isPaymentProviderConfigured("waffo", waffo)).toBe(true);
		expect(isPaymentProviderConfigured("waffo", { ...waffo, WAFFO_PRIVATE_KEY: "" })).toBe(false);
	});
});
