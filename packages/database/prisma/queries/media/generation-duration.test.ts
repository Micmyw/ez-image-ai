import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import { describe, expect, it, vi } from "vitest";

import { getGenerationDurationEstimate } from "./generation-duration";
import type { MediaDatabaseClient } from "./types";

const input = {
	productKey: "image-nano-banana-2-lite",
	skuKey: "nano-banana-2-lite-1k",
	serviceClass: "STANDARD",
} as const;
const asOf = new Date("2026-11-14T10:00:00Z");
const ready = {
	sampleSize: 5,
	p50Seconds: 39.6,
	p90Seconds: 68.1,
	asOf,
	latestSampleAt: new Date("2026-11-14T08:00:00Z"),
};

function database(row: typeof ready | Record<string, unknown>) {
	const query = vi.fn().mockResolvedValue([row]);
	return { query, client: { $queryRaw: query } as unknown as MediaDatabaseClient };
}

describe("recent completed generation durations", () => {
	it("returns only bounded aggregate whole-job observations and isolates current versions", async () => {
		const { query, client } = database(ready);
		expect(await getGenerationDurationEstimate(input, client)).toEqual({
			kind: "range",
			minimumSeconds: 40,
			maximumSeconds: 69,
			sampleSize: 5,
			asOf: asOf.toISOString(),
			latestSampleAt: ready.latestSampleAt.toISOString(),
			percentiles: "p50-p90",
			windowHours: 168,
			cohort: "completed-tasks-excluding-marked-internal",
		});
		const sql = query.mock.calls[0]![0];
		expect(sql.text).toContain('job."terminalAt" - job."createdAt"');
		expect(sql.text).not.toContain('attempt."completedAt"');
		expect(sql.text).toContain("LIMIT 500");
		expect(sql.text).toContain("job.\"status\" = 'SUCCEEDED'");
		expect(sql.text).toContain("COALESCE(owner.\"role\", '') <> 'admin'");
		expect(sql.text).toContain('marked."internal" = true');
		expect(sql.text).toContain('job."archivedCreditsCharged" IS NULL');
		expect(sql.values).toEqual(
			expect.arrayContaining([
				input.productKey,
				input.skuKey,
				"STANDARD",
				DEFAULT_PRODUCT_CONFIG.catalogVersion,
				DEFAULT_PRODUCT_CONFIG.pricingVersion,
				200,
			]),
		);
	});
	it.each([
		{ sampleSize: 4 },
		{ latestSampleAt: new Date("2026-11-13T09:59:59Z") },
		{ latestSampleAt: new Date("2026-11-14T10:00:01Z") },
		{ latestSampleAt: null },
		{ p50Seconds: null },
		{ p90Seconds: Number.NaN },
		{ p50Seconds: -2 },
		{ p50Seconds: 80, p90Seconds: 70 },
	])("keeps seconds out of insufficient or invalid observations: %o", async (change) => {
		const { client } = database({ ...ready, ...change });
		expect(await getGenerationDurationEstimate(input, client)).toEqual({ kind: "processing" });
	});
	it("rejects a mismatched public SKU before reading the database", async () => {
		const { client, query } = database(ready);
		await expect(
			getGenerationDurationEstimate({ ...input, skuKey: "gpt-image-2-1k" }, client),
		).rejects.toThrow("SKU does not belong");
		expect(query).not.toHaveBeenCalled();
	});
});
