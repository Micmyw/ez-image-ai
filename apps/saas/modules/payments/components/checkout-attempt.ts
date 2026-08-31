import type { PaymentProviderName } from "@repo/payments/types";

export interface CheckoutSelection {
	provider: PaymentProviderName;
	planId: "creator" | "studio";
	interval: "month" | "year";
}

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

function sameSelection(left: CheckoutSelection, right: CheckoutSelection): boolean {
	return (
		left.provider === right.provider &&
		left.planId === right.planId &&
		left.interval === right.interval
	);
}
