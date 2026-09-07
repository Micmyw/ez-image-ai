import type { PaymentProviderName } from "@repo/payments/types";

export interface CheckoutSelection {
	provider: SubscriptionCheckoutProvider;
	planId: "creator" | "ultimate" | "studio";
	interval: "month" | "year";
}

export type SubscriptionCheckoutProvider = Extract<PaymentProviderName, "paypal" | "waffo">;
export type CreditPackCheckoutProvider = Extract<PaymentProviderName, "paypal" | "waffo">;

export interface CreditPackCheckoutSelection {
	provider: CreditPackCheckoutProvider;
	packKey: string;
}

export type CreditPackCheckoutStatus = "PENDING" | "COMPLETED" | "REVIEW" | "EXPIRED" | "CANCELED";

export function createCheckoutAttemptController(createKey: () => string) {
	let active: { selection: CheckoutSelection; key: string } | null = null;

	return {
		begin(selection: CheckoutSelection): string {
			if (active && sameSelection(active.selection, selection)) return active.key;
			const key = createKey();
			active = { selection, key };
			return key;
		},
		succeeded(selection: CheckoutSelection): void {
			if (active && sameSelection(active.selection, selection)) active = null;
		},
	};
}

export function filterCreditPackCheckoutProviders(
	providers: readonly PaymentProviderName[],
): CreditPackCheckoutProvider[] {
	return filterSubscriptionCheckoutProviders(providers);
}

export function filterSubscriptionCheckoutProviders(
	providers: readonly PaymentProviderName[],
): SubscriptionCheckoutProvider[] {
	return providers.filter(isSubscriptionCheckoutProvider);
}

export function createCreditPackCheckoutAttemptController(createKey: () => string) {
	let active: { selection: CreditPackCheckoutSelection; key: string } | null = null;

	return {
		begin(selection: CreditPackCheckoutSelection): string {
			if (active && sameCreditPackSelection(active.selection, selection)) return active.key;
			const key = createKey();
			active = { selection, key };
			return key;
		},
		succeeded(selection: CreditPackCheckoutSelection): void {
			if (active && sameCreditPackSelection(active.selection, selection)) active = null;
		},
	};
}

export function getPayPalCreditPackCaptureInput(
	intentId: string,
	providerOrderId?: string,
): { intentId: string; providerOrderId: string } | null {
	if (!intentId || !providerOrderId) return null;

	return { intentId, providerOrderId };
}

export function getCreditPackCheckoutDestination(status?: CreditPackCheckoutStatus): string | null {
	return status === "COMPLETED" ? "/create?credits=purchased" : null;
}

function sameSelection(left: CheckoutSelection, right: CheckoutSelection): boolean {
	return (
		left.provider === right.provider &&
		left.planId === right.planId &&
		left.interval === right.interval
	);
}

function sameCreditPackSelection(
	left: CreditPackCheckoutSelection,
	right: CreditPackCheckoutSelection,
): boolean {
	return left.provider === right.provider && left.packKey === right.packKey;
}

export function isSubscriptionCheckoutProvider(
	provider: PaymentProviderName,
): provider is SubscriptionCheckoutProvider {
	return provider === "paypal" || provider === "waffo";
}
