import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, string | number>) =>
		values ? `${key}:${JSON.stringify(values)}` : key,
}));

import { GrowthOperationsSummary } from "./GrowthOperationsPanel";

describe("growth operations summary", () => {
	it("renders only aggregate diagnostics and the two public EzPic product names", () => {
		const markup = renderToStaticMarkup(
			<GrowthOperationsSummary
				data={{
					generatedAt: "2026-08-25T00:00:00.000Z",
					summary: {
						jobs: 10,
						succeeded: 8,
						failed: 2,
						successRate: 0.8,
						latencyMs: { p50: 2_000, p95: 9_000 },
						averageProviderCostMicros: "125000",
						moderationRejectionRate: 0.1,
						repeatEditRate: 0.25,
					},
					credits: { reserved: "100", charged: "80", released: "20" },
					failureCodes: [{ code: "PROVIDER_FAILED", count: 2 }],
					routes: [
						{
							productKey: "image-quality",
							provider: "fal",
							model: "fal-ai/quality-edit",
							status: "SUCCEEDED",
							jobs: 8,
						},
					],
					controls: {
						generationEnabled: true,
						products: [
							{ productKey: "image-fast", publicName: "Standard Edit", enabled: true },
							{ productKey: "image-quality", publicName: "Quality Edit", enabled: false },
						],
					},
				}}
			/>,
		);

		for (const value of [
			"Standard Edit",
			"Quality Edit",
			"PROVIDER_FAILED",
			"fal",
			"fal-ai/quality-edit",
			"125000",
			"100",
			"80",
			"20",
		]) {
			expect(markup).toContain(value);
		}
		expect(markup).not.toMatch(/video-fast|video-quality|prompt|signedUrl|jobId|objectKey/i);
	});
});
