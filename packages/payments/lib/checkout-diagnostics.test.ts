import { describe, expect, it, vi } from "vitest";

import { capturePayPalCheckoutOrder, getPayPalAccessToken } from "../provider/paypal/paypal";
import { CheckoutProviderResponseError, checkoutErrorDetails } from "./checkout-diagnostics";

describe("safe PayPal checkout errors", () => {
	it("retains bounded database/transport codes without inferring a declined payment", () => {
		const databaseError = Object.assign(new Error("query with customer data"), {
			name: "PrismaClientKnownRequestError",
			code: "P2028",
		});
		expect(checkoutErrorDetails(databaseError)).toEqual({ kind: "internal", code: "P2028" });
		expect(
			checkoutErrorDetails(
				new TypeError("fetch failed", { cause: { code: "ECONNRESET", address: "private-host" } }),
			),
		).toEqual({ kind: "transport", code: "ECONNRESET" });
		expect(checkoutErrorDetails(new TypeError("coding mistake"))).toEqual({ kind: "unknown" });
		expect(checkoutErrorDetails(new Error("PAYPAL_CUSTOMER_SECRET"))).toEqual({ kind: "unknown" });
	});
	it("retains provider codes and a support debug ID but excludes payer data and URLs", async () => {
		const request = vi.fn().mockResolvedValue({
			status: 422,
			debugId: "a12b34c56",
			body: {
				name: "UNPROCESSABLE_ENTITY",
				details: [{ issue: "INSTRUMENT_DECLINED", description: "payer@example.com" }],
				links: [{ href: "https://example.test/?token=secret" }],
			},
		});
		const error = await capturePayPalCheckoutOrder(
			{ request },
			{ accessToken: "synthetic", baseUrl: "https://api.invalid" },
			{ providerOrderId: "order-1", idempotencyKey: "capture-1" },
		).catch((value: unknown) => value);
		expect(checkoutErrorDetails(error)).toEqual({
			kind: "provider_response",
			code: "PAYPAL_CAPTURE_RESPONSE_INVALID",
			httpStatus: 422,
			providerIssue: "INSTRUMENT_DECLINED",
			debugId: "a12b34c56",
		});
		expect(JSON.stringify(error)).not.toMatch(/payer|secret|https/);
		expect(request).toHaveBeenCalledTimes(1);
	});
	it("records OAuth setup failures without confusing them with buyer rejection", async () => {
		const request = vi.fn().mockResolvedValue({
			status: 401,
			body: {
				name: "AUTHENTICATION_FAILURE",
				debug_id: "debug-123",
				access_token: "never-retain",
			},
		});
		const error = await getPayPalAccessToken(
			{ request },
			{ baseUrl: "https://api.invalid", clientId: "synthetic", clientSecret: "synthetic" },
		).catch((value: unknown) => value);
		expect(checkoutErrorDetails(error)).toMatchObject({
			code: "PAYPAL_OAUTH_RESPONSE_INVALID",
			httpStatus: 401,
			providerIssue: "AUTHENTICATION_FAILURE",
		});
		expect(JSON.stringify(error)).not.toContain("never-retain");
	});
	it("drops malformed diagnostic values and unknown error messages", () => {
		const error = new CheckoutProviderResponseError("PAYPAL_CAPTURE_RESPONSE_INVALID", {
			status: 502,
			debugId: "secret@example.com",
			body: { details: [{ issue: "secret@example.com" }] },
		});
		expect(checkoutErrorDetails(error)).toEqual({
			kind: "provider_response",
			code: "PAYPAL_CAPTURE_RESPONSE_INVALID",
			httpStatus: 502,
		});
		expect(checkoutErrorDetails(new Error("https://example.test/?token=secret"))).toEqual({
			kind: "unknown",
		});
	});
});
