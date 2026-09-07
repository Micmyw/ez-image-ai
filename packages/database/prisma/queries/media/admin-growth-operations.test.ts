import { describe, expect, it, vi } from "vitest";

import { getAdminGrowthOperations } from "./admin-growth-operations";

describe("Admin growth operations safe catalog", () => {
	it("derives SKU filtering and controls from the supplied provider-free matrix", async () => {
		const queryRaw = vi
			.fn()
			.mockResolvedValueOnce([
				{
					jobs: 1n,
					succeeded: 1n,
					failed: 0n,
					successRate: 1,
					p50LatencyMs: 100n,
					p95LatencyMs: 100n,
					reserved: 7n,
					charged: 7n,
					released: 0n,
				},
			])
			.mockResolvedValueOnce([{ total: 1n, rejected: 0n }])
			.mockResolvedValueOnce([{ sessions: 1n, repeated: 0n }])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{
					productKey: "image-gpt-image-2",
					skuKey: "gpt-image-2-1k",
					status: "SUCCEEDED",
					jobs: 1n,
				},
			]);
		const findMany = vi.fn().mockResolvedValue([]);
		const products = [
			{
				productKey: "image-gpt-image-2" as const,
				publicName: "Catalog-defined image product",
				skuCells: [
					{
						skuKey: "gpt-image-2-1k" as const,
						aspectRatios: ["auto", "1:1"] as const,
					},
				],
			},
		];

		const result = await getAdminGrowthOperations(
			{
				productKey: "image-gpt-image-2",
				skuKey: "gpt-image-2-1k",
				from: new Date("2026-09-01T00:00:00.000Z"),
				to: new Date("2026-09-02T00:00:00.000Z"),
				generationEnabled: true,
			},
			{ $queryRaw: queryRaw, runtimeConfigOverride: { findMany } } as never,
			products,
		);

		expect(result.controls.products).toEqual([
			{
				productKey: "image-gpt-image-2",
				publicName: "Catalog-defined image product",
				enabled: true,
			},
		]);
		expect(result.skuBreakdown).toEqual([
			{
				productKey: "image-gpt-image-2",
				skuKey: "gpt-image-2-1k",
				status: "SUCCEEDED",
				jobs: 1,
			},
		]);
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					active: true,
					configKey: {
						in: ["media.generation.enabled", "media.model.image-gpt-image-2.enabled"],
					},
				},
			}),
		);
		expect(JSON.stringify(result)).not.toMatch(
			/provider|modelId|costMicros|marginMicros|credential|secret/i,
		);
	});
});
