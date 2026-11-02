import type { CheckoutBrowserDiagnosticInput } from "@repo/api/modules/payments/checkout-diagnostic-types";

// This narrow operational receipt is independent of optional marketing
// analytics. No URL, PayPal token, referrer, fingerprint or free text is sent.
// Use the procedure's OpenAPI transport so keepalive survives navigation.
export function reportCheckoutDiagnostic(input: CheckoutBrowserDiagnosticInput): void {
	try {
		void fetch("/api/payments/checkout-diagnostics", {
			method: "POST",
			credentials: "same-origin",
			keepalive: true,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ intentId: input.intentId, event: input.event }),
		}).catch(() => undefined);
	} catch {
		// Diagnostic transport must not prevent purchase or navigation.
	}
}

export function redirectCheckout(intentId: string, navigate: () => void): void {
	reportCheckoutDiagnostic({ intentId, event: "redirect_requested" });
	try {
		navigate();
	} catch (error) {
		reportCheckoutDiagnostic({ intentId, event: "redirect_failed" });
		throw error;
	}
}

export function checkoutReturnEvent(
	approved: boolean,
	canceled: boolean,
): CheckoutBrowserDiagnosticInput["event"] {
	return approved && canceled
		? "return_conflicting"
		: canceled
			? "return_canceled"
			: approved
				? "return_approved"
				: "return_unmarked";
}
