import type { PaymentProvider } from "../types";
import { getPaymentProvider } from "./runtime-registry";

type ProviderResolver = (name: string) => PaymentProvider | null;

export async function cancelProviderSubscription(
	providerName: string,
	providerSubscriptionId: string,
	resolve: ProviderResolver = getPaymentProvider,
): Promise<void> {
	const provider = resolve(providerName);
	if (!provider?.capabilities.cancellation || !provider.cancelSubscription) {
		throw new Error("PAYMENT_PROVIDER_CANCELLATION_UNSUPPORTED");
	}
	await provider.cancelSubscription(providerSubscriptionId);
}

export async function setProviderSubscriptionSeats(
	providerName: string,
	providerSubscriptionId: string,
	seats: number,
	resolve: ProviderResolver = getPaymentProvider,
): Promise<void> {
	const provider = resolve(providerName);
	if (!provider?.capabilities.seatUpdates || !provider.setSubscriptionSeats) {
		throw new Error("PAYMENT_PROVIDER_SEAT_UPDATES_UNSUPPORTED");
	}
	await provider.setSubscriptionSeats({ id: providerSubscriptionId, seats });
}
