export type PaymentAction = { key: string; stage: "starting" | "redirecting" } | null;

// One admission gate for all checkout controls in this browser document.
// The server remains authoritative across tabs, accounts and payment providers.
export function createPaymentActionController() {
	let state: PaymentAction = null;
	const listeners = new Set<() => void>();
	const publish = (next: PaymentAction) => {
		state = next;
		for (const listener of listeners) listener();
	};
	return {
		getSnapshot: () => state,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		acquire(key: string) {
			if (state) return false;
			publish({ key, stage: "starting" });
			return true;
		},
		redirecting() {
			if (state) publish({ ...state, stage: "redirecting" });
		},
		release() {
			publish(null);
		},
	};
}
