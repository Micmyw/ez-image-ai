import { readFileSync } from "node:fs";

import type { ImageSkuKey, ProductModelKey } from "@repo/config";
import { describe, expect, it, vi } from "vitest";

import { KieProviderAdapter } from "../providers/kie";
import type { ProviderSubmitInput } from "../types";
import { getCatalogEntry } from "./catalog";

// Generated from the deployed baseline, not from the implementation under test.
const baseline = JSON.parse(
	readFileSync(
		new URL("./fixtures/kie-production-provider-contract-2026-09-07.2.json", import.meta.url),
		"utf8",
	),
) as {
	products: Array<{
		productKey: ProductModelKey;
		defaultSkuKey: string;
		cells: Array<{
			skuKey: ImageSkuKey;
			aspectRatios: string[];
			controls: Array<{ key: string; defaultValue: string; options: string[] }>;
			routes: Array<{
				provider: string;
				providerModelId: string;
				providerCostMicros: number;
				weight: number;
			}>;
			request: {
				providerModelId: string;
				sourceField: string;
				parameters: Record<string, string | boolean>;
				outputFormats?: Record<string, string>;
				backgrounds?: Record<string, string>;
			};
		}>;
	}>;
};

describe("provider contracts covered by the prior production approval", () => {
	for (const product of baseline.products) {
		it(`${product.productKey} retains its legal inputs, route costs and actual provider payloads`, async () => {
			const entry = getCatalogEntry(product.productKey);
			const matrix = entry.imageSpecMatrix!;
			expect(entry.inputKinds).toEqual(["image-to-image"]);
			expect(matrix.defaultSkuKey).toBe(product.defaultSkuKey);
			expect(matrix.cells.map((cell) => cell.skuKey)).toEqual(
				product.cells.map((cell) => cell.skuKey),
			);
			for (const cell of product.cells) {
				const current = matrix.cells.find((candidate) => candidate.skuKey === cell.skuKey)!;
				expect(current.aspectRatios).toEqual(cell.aspectRatios);
				expect(current.routes).toEqual(cell.routes);
				expect(
					(current.controls ?? []).map((control) => ({
						key: control.key,
						defaultValue: control.defaultValue,
						options: control.options.map((option) => option.key),
					})),
				).toEqual(cell.controls);
				const variations: Array<{ aspectRatio: string; controls: Record<string, string> }> = [
					...cell.aspectRatios.map((aspectRatio) => ({ aspectRatio, controls: {} })),
					...cell.controls.flatMap((control) =>
						control.options.map((value) => ({
							aspectRatio: cell.aspectRatios[0]!,
							controls: { [control.key]: value },
						})),
					),
				];
				for (const variation of variations) {
					const fetch = vi.fn<typeof globalThis.fetch>(
						async () =>
							new Response(JSON.stringify({ code: 200, data: { taskId: "contract-check-only" } }), {
								headers: { "content-type": "application/json" },
							}),
					);
					const adapter = new KieProviderAdapter({ apiKey: "local-contract-check", fetch });
					await adapter.submit({
						attemptId: "contract-check",
						providerModelId: cell.request.providerModelId,
						input: {
							kind: "image-to-image",
							prompt: "Preserve the subject",
							skuKey: cell.skuKey,
							aspectRatio: variation.aspectRatio,
							sourceAsset: {
								assetId: "fixture-asset",
								transferUrl: "https://transfer.test/input.png",
							},
							...variation.controls,
						} as ProviderSubmitInput["input"],
					});
					const parameters = { ...cell.request.parameters };
					for (const [key, value] of Object.entries(variation.controls)) {
						if (key === "outputFormat")
							parameters.output_format = cell.request.outputFormats![value];
						if (key === "background") parameters.background = cell.request.backgrounds![value];
					}
					expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
						model: cell.request.providerModelId,
						input: {
							[cell.request.sourceField]: ["https://transfer.test/input.png"],
							prompt: "Preserve the subject",
							aspect_ratio: variation.aspectRatio,
							...parameters,
						},
					});
				}
			}
		});
	}
});
