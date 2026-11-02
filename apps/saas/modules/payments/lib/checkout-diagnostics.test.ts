import { afterEach, describe, expect, it, vi } from "vitest";

import {
	checkoutReturnEvent,
	redirectCheckout,
	reportCheckoutDiagnostic,
} from "./checkout-diagnostics";

afterEach(() => vi.unstubAllGlobals());
describe("checkout browser diagnostics", () => {
	it("sends only order reference and event using same-origin keepalive", () => {
		const fetch = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal("fetch", fetch);
		reportCheckoutDiagnostic({ intentId: "intent", event: "link_received" });
		expect(fetch).toHaveBeenCalledWith(
			"/api/payments/checkout-diagnostics",
			expect.objectContaining({
				credentials: "same-origin",
				keepalive: true,
				body: '{"intentId":"intent","event":"link_received"}',
			}),
		);
	});
	it.each(["reject", "throw", "pending"])(
		"does not delay or block navigation when telemetry is %s",
		(mode) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(() => {
					if (mode === "throw") throw new TypeError("offline");
					if (mode === "reject") return Promise.reject(new TypeError("offline"));
					return new Promise(() => undefined);
				}),
			);
			const navigate = vi.fn();
			redirectCheckout("intent", navigate);
			expect(navigate).toHaveBeenCalledTimes(1);
		},
	);
	it("records synchronous navigation failure without claiming provider-page receipt", () => {
		const fetch = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal("fetch", fetch);
		expect(() =>
			redirectCheckout("intent", () => {
				throw new Error("navigation blocked");
			}),
		).toThrow("navigation blocked");
		expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body).event)).toEqual([
			"redirect_requested",
			"redirect_failed",
		]);
	});
	it("preserves conflicting or absent return flags", () => {
		expect(checkoutReturnEvent(true, true)).toBe("return_conflicting");
		expect(checkoutReturnEvent(false, false)).toBe("return_unmarked");
		expect(checkoutReturnEvent(true, false)).toBe("return_approved");
		expect(checkoutReturnEvent(false, true)).toBe("return_canceled");
	});
});
