import {
	paymentProviderNames,
	type PaymentProvider,
	type PaymentProviderCapabilities,
} from "../types";

const capabilities = {
	stripe: {
		checkout: true,
		portal: true,
		cancellation: true,
		seatUpdates: true,
		webhooks: true,
	},
	paypal: {
		checkout: true,
		portal: false,
		cancellation: true,
		seatUpdates: false,
		webhooks: true,
	},
	waffo: {
		checkout: true,
		portal: false,
		cancellation: true,
		seatUpdates: false,
		webhooks: true,
	},
} as const satisfies Record<(typeof paymentProviderNames)[number], PaymentProviderCapabilities>;

export { paymentProviderNames };

type PaymentProviderSource = PaymentProvider | (() => PaymentProvider);

export function createPaymentProviderRegistry(
	providers: Record<(typeof paymentProviderNames)[number], PaymentProviderSource>,
) {
	return {
		resolve(name: string): PaymentProvider | null {
			if (!paymentProviderNames.includes(name as (typeof paymentProviderNames)[number]))
				return null;
			const source = providers[name as (typeof paymentProviderNames)[number]];
			return typeof source === "function" ? source() : source;
		},
	};
}

export function resolvePaymentProvider(name: string) {
	if (!paymentProviderNames.includes(name as (typeof paymentProviderNames)[number])) return null;
	const providerName = name as (typeof paymentProviderNames)[number];
	return { name: providerName, capabilities: capabilities[providerName] };
}

export function isPaymentProviderConfigured(
	provider: (typeof paymentProviderNames)[number],
	environment: Record<string, string | undefined> = process.env,
): boolean {
	if (provider === "stripe") {
		return hasValues(environment, ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
	}
	if (provider === "paypal") {
		return (
			hasValues(environment, ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"]) &&
			(environment.PAYPAL_ENVIRONMENT === "sandbox" || environment.PAYPAL_ENVIRONMENT === "live")
		);
	}
	return (
		hasValues(environment, [
			"WAFFO_MERCHANT_ID",
			"WAFFO_PRIVATE_KEY",
			"WAFFO_WEBHOOK_PUBLIC_KEY",
		]) &&
		(environment.WAFFO_ENVIRONMENT === "test" || environment.WAFFO_ENVIRONMENT === "prod")
	);
}

function hasValues(environment: Record<string, string | undefined>, keys: string[]): boolean {
	return keys.every((key) => Boolean(environment[key]?.trim()));
}
