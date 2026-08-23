import { getPublicProductCatalog } from "@repo/ai";
import { describe, expect, it } from "vitest";

import { stableMediaErrorCode } from "./lib/errors";
import { decodeCursor, encodeCursor, jsonBigInt } from "./types";

describe("media browser contract", () => {
	it("publishes only product fields and never provider routing fields", () => {
		const catalog = getPublicProductCatalog();
		expect(catalog.products.length).toBeGreaterThan(0);
		for (const product of catalog.products) {
			expect(product).not.toHaveProperty("provider");
			expect(product).not.toHaveProperty("providerModelId");
			expect(product).not.toHaveProperty("providerCostMicros");
		}
	});

	it("keeps cursors opaque and BigInt DTOs JSON-safe", () => {
		const input = { createdAt: new Date("2026-08-13T00:00:00.000Z"), id: "job_123" };
		const cursor = encodeCursor(input);
		expect(cursor).not.toContain("2026-08-13");
		expect(decodeCursor(cursor)).toEqual(input);
		expect(JSON.stringify({ credits: jsonBigInt(9_007_199_254_740_993n) })).toBe(
			'{"credits":"9007199254740993"}',
		);
	});

	it("maps provider failures to stable public errors without raw messages", () => {
		expect(stableMediaErrorCode(new Error("Bearer secret-key provider exploded"))).toBe(
			"PROVIDER_UNAVAILABLE",
		);
	});

	it("maps rejected and review-required prompts to one stable public policy code", () => {
		expect(stableMediaErrorCode(new Error("TEXT_MODERATION_REJECT"))).toBe("CONTENT_NOT_ALLOWED");
		expect(stableMediaErrorCode(new Error("TEXT_MODERATION_REVIEW"))).toBe("CONTENT_NOT_ALLOWED");
	});

	it.each([
		"GENERATION_RETRY_IN_PROGRESS",
		"GENERATION_RETRY_FAILED",
		"IDEMPOTENCY_CONFLICT",
	] as const)("preserves the safe retry error code %s", (code) => {
		expect(stableMediaErrorCode(new Error(code))).toBe(code);
	});
});
