import { WaffoPancake } from "@waffo/pancake-ts";

import type { PaymentProvider } from "../../types";
import {
	cancelWaffoSubscription,
	createWaffoCheckoutLink,
	createWaffoWebhookVerifier,
	type WaffoSdkBoundary,
} from "./waffo";

type WaffoEnvironment = "test" | "prod";

export function createWaffoClient(
	environment: Record<string, string | undefined> = process.env,
): WaffoSdkBoundary {
	const waffoEnvironment = getWaffoEnvironment(environment);
	return new WaffoPancake({
		merchantId: requiredValue(environment.WAFFO_MERCHANT_ID),
		privateKey: requiredValue(environment.WAFFO_PRIVATE_KEY),
		webhookPublicKey: requiredValue(environment.WAFFO_WEBHOOK_PUBLIC_KEY),
		environment: waffoEnvironment,
	});
}

export function createWaffoProvider(
	environment: Record<string, string | undefined> = process.env,
	client?: WaffoSdkBoundary,
): PaymentProvider {
	const configuredClient = client ?? createWaffoClient(environment);
	return {
		name: "waffo",
		capabilities: {
			checkout: true,
			portal: false,
			cancellation: true,
			seatUpdates: false,
			webhooks: true,
		},
		createCheckout: (options) => createWaffoCheckoutLink(configuredClient, options),
		cancelSubscription: (id) => cancelWaffoSubscription(configuredClient, id),
	};
}

export function createConfiguredWaffoWebhookVerifier(
	environment: Record<string, string | undefined> = process.env,
	client?: WaffoSdkBoundary,
) {
	const waffoEnvironment = getWaffoEnvironment(environment);
	return createWaffoWebhookVerifier(client ?? createWaffoClient(environment), waffoEnvironment);
}

function getWaffoEnvironment(environment: Record<string, string | undefined>): WaffoEnvironment {
	const value = environment.WAFFO_ENVIRONMENT;
	if (value !== "test" && value !== "prod") throw new Error("WAFFO_CONFIGURATION_INCOMPLETE");
	return value;
}

function requiredValue(value: string | undefined): string {
	const result = value?.trim();
	if (!result) throw new Error("WAFFO_CONFIGURATION_INCOMPLETE");
	return result;
}

export * from "./waffo";
