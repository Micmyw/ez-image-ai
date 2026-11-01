import { describe, expect, it } from "vitest";

import { GET, HEAD } from "./route";

describe("/health route", () => {
	it("returns the same alive JSON as /api/health", async () => {
		const response = GET();
		expect(response.status).toBe(200);
		expect(response.headers.get("location")).toBeNull();
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ status: "alive" });
	});

	it("answers HEAD without a login redirect", async () => {
		const response = HEAD();
		expect(response.status).toBe(200);
		expect(response.headers.get("location")).toBeNull();
		expect(await response.text()).toBe("");
		expect(response.headers.get("content-type")).toContain("application/json");
	});
});
