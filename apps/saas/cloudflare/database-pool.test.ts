import { describe, expect, it } from "vitest";

import { databasePoolSizeForRequest } from "./database-pool";

describe("request-owned diagnostics connection pool", () => {
	it.each([
		"adminMediaDiagnostics",
		"adminMediaHealth",
		"adminMediaTotals",
		"adminGuestDiagnostics",
	])("uses two connections for the normal RPC POST to %s", (procedure) => {
		expect(
			databasePoolSizeForRequest(
				new Request(`https://example.com/api/rpc/media/${procedure}`, { method: "POST" }),
			),
		).toBe(2);
	});
	it.each(["diagnostics", "health", "totals", "guest-diagnostics"])(
		"uses two connections for REST %s",
		(section) => {
			expect(
				databasePoolSizeForRequest(new Request(`https://example.com/api/admin/media/${section}`)),
			).toBe(2);
		},
	);
	it.each([
		"/",
		"/api/rpc/media/submitGeneration",
		"/api/webhooks/media/kie",
		"/api/admin/media/health/extra",
		"/api/rpc/media/adminMediaHealthExtra",
	])("keeps the ordinary pool for %s", (path) => {
		expect(
			databasePoolSizeForRequest(new Request(`https://example.com${path}`, { method: "POST" })),
		).toBe(1);
	});
	it("does not elevate an unsupported REST method", () => {
		expect(
			databasePoolSizeForRequest(
				new Request("https://example.com/api/admin/media/health", { method: "DELETE" }),
			),
		).toBe(1);
	});
});
