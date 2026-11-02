import { expect, type Route } from "@playwright/test";
import type { CheckoutBrowserDiagnosticInput } from "@repo/api/modules/payments/checkout-diagnostic-types";

export type CheckoutDiagnosticReceipt = CheckoutBrowserDiagnosticInput;

// Intercept only the operational receipt. No diagnostic or financial write
// reaches the local server, and payment tokens/URLs must not enter the payload.
export async function mockCheckoutDiagnostic(
	route: Route,
	intentId: string,
	receipts: CheckoutDiagnosticReceipt[],
) {
	const request = route.request();
	expect(request.method()).toBe("POST");
	const input = request.postDataJSON();
	expect(Object.keys(input).sort()).toEqual(["event", "intentId"]);
	expect(input.intentId).toBe(intentId);
	expect([
		"link_received",
		"redirect_requested",
		"redirect_failed",
		"return_unmarked",
		"return_approved",
		"return_canceled",
		"return_conflicting",
		"capture_request_failed",
	]).toContain(input.event);
	receipts.push(input);
	await route.fulfill({ json: { recorded: true } });
}
