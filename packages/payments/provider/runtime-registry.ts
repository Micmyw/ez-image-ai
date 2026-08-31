import { createPayPalProvider } from "./paypal";
import { createPaymentProviderRegistry } from "./registry";
import { createStripeProvider } from "./stripe";
import { createWaffoProvider } from "./waffo";

export const paymentProviderRegistry = createPaymentProviderRegistry({
	stripe: createStripeProvider,
	paypal: createPayPalProvider,
	waffo: createWaffoProvider,
});

export function getPaymentProvider(name: string) {
	return paymentProviderRegistry.resolve(name);
}
