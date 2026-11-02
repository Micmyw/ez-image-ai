import { describe, expect, it } from "vitest";

import {
	checkoutDiagnosticOutcome,
	checkoutDiagnosticSchema,
	type CheckoutDiagnostic,
} from "./checkout-diagnostics";

describe("checkout evidence boundaries", () => {
	it.each(["PROVIDER_PENDING", "EXPIRED", "CANCELED", "CREATED"])(
		"keeps %s unconfirmed despite browser approval/cancel claims",
		(status) => {
			const events: CheckoutDiagnostic[] = [
				{ version: 1, source: "browser", event: "return_approved" },
				{ version: 1, source: "browser", event: "return_canceled" },
			];
			expect(checkoutDiagnosticOutcome(status, events)).toBe("UNCONFIRMED");
			expect(checkoutDiagnosticOutcome(status, [])).toBe("UNCONFIRMED");
		},
	);
	it("keeps provider errors separate from final financial status", () => {
		const events: CheckoutDiagnostic[] = [
			{
				version: 1,
				source: "server",
				operation: "capture",
				phase: "failed",
				attemptId: "d207d786-220b-4a4c-9d5a-678645e04a53",
				error: { kind: "provider_response", httpStatus: 422, providerIssue: "INSTRUMENT_DECLINED" },
			},
		];
		expect(checkoutDiagnosticOutcome("PROVIDER_PENDING", events)).toBe("UNCONFIRMED");
		expect(checkoutDiagnosticOutcome("COMPLETED", events)).toBe("COMPLETED");
	});
	it("distinguishes a correlated capture, durable event ingestion and local completion", () => {
		const event: CheckoutDiagnostic = {
			version: 1,
			source: "server",
			operation: "capture",
			phase: "succeeded",
			attemptId: "d207d786-220b-4a4c-9d5a-678645e04a53",
		};
		expect(checkoutDiagnosticOutcome("PROVIDER_PENDING", [event])).toBe("CAPTURE_CONFIRMED");
		expect(checkoutDiagnosticOutcome("PROVIDER_PENDING", [{ ...event, operation: "ingest" }])).toBe(
			"PAYMENT_RECORDED",
		);
		expect(checkoutDiagnosticOutcome("COMPLETED", [])).toBe("COMPLETED");
	});
	it("rejects arbitrary browser fields and free-form provider messages", () => {
		expect(
			checkoutDiagnosticSchema.safeParse({
				version: 1,
				source: "browser",
				event: "return_approved",
				status: "COMPLETED",
			}).success,
		).toBe(false);
		expect(
			checkoutDiagnosticSchema.safeParse({
				version: 1,
				source: "server",
				operation: "capture",
				phase: "failed",
				attemptId: "d207d786-220b-4a4c-9d5a-678645e04a53",
				error: { kind: "unknown", message: "payer@example.com" },
			}).success,
		).toBe(false);
	});
});
