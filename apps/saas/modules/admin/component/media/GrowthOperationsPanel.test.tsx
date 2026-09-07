import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations:
		(namespace: string) => (key: string, values?: Record<string, string | number>) => {
			if (namespace === "media.create.products") {
				const products: Record<string, string> = {
					"image-nano-banana-2-lite.label": "Nano Banana 2 Lite",
					"image-gpt-image-2.label": "GPT Image 2",
					"image-seedream-5-pro.label": "Seedream 5 Pro",
				};
				return products[key] ?? key;
			}
			return values ? `${key}:${JSON.stringify(values)}` : key;
		},
}));

import { GrowthOperationsSummary } from "./GrowthOperationsPanel";

describe("growth operations summary", () => {
	it("renders aggregate diagnostics for a representative public-product subset and stable SKUs", () => {
		const markup = renderToStaticMarkup(
			<GrowthOperationsSummary
				data={{
					summary: {
						jobs: 10,
						succeeded: 8,
						failed: 2,
						successRate: 0.8,
						latencyMs: { p50: 2_000, p95: 9_000 },
						moderationRejectionRate: 0.1,
						repeatEditRate: 0.25,
					},
					credits: { reserved: "100", charged: "80", released: "20" },
					failureCodes: [{ code: "PROVIDER_FAILED", count: 2 }],
					skuBreakdown: [
						{
							productKey: "image-gpt-image-2",
							skuKey: "gpt-image-2-4k",
							status: "SUCCEEDED",
							jobs: 8,
						},
					],
					controls: {
						generationEnabled: true,
						products: [
							{
								productKey: "image-nano-banana-2-lite",
								publicName: "Nano Banana 2 Lite",
								enabled: true,
							},
							{
								productKey: "image-gpt-image-2",
								publicName: "GPT Image 2",
								enabled: false,
							},
							{
								productKey: "image-seedream-5-pro",
								publicName: "Seedream 5 Pro",
								enabled: true,
							},
						],
					},
				}}
			/>,
		);

		for (const value of [
			"Nano Banana 2 Lite",
			"GPT Image 2",
			"Seedream 5 Pro",
			"gpt-image-2-4k",
			"PROVIDER_FAILED",
			"100",
			"80",
			"20",
		]) {
			expect(markup).toContain(value);
		}
		expect(markup).not.toMatch(
			/video-fast|video-quality|prompt|signedUrl|jobId|objectKey|provider-a|private-model-a|125000|kie/i,
		);
	});
});
