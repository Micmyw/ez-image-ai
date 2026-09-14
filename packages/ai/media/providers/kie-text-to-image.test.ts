import { DEFAULT_PRODUCT_CONFIG, type ProductModelKey } from "@repo/config";
import { describe, expect, it, vi } from "vitest";

import { getCatalogEntry, quoteCatalogInput } from "../catalog/catalog";
import { staticDispatchRouteFor } from "../catalog/dispatch-manifest";
import type { ProviderSubmitInput } from "../types";
import contracts from "./fixtures/kie-official-text-image-contracts-2026-09-14.json";
import { KieProviderAdapter } from "./kie";

describe("documented text-to-image contracts", () => {
	for (const official of contracts.products) {
		it(`${official.productKey} generates without a source through its documented image task`, async () => {
			const productKey = official.productKey as ProductModelKey;
			for (const cell of getCatalogEntry(productKey).imageSpecMatrix!.cells) {
				const controls = (cell.controls ?? []).reduce<Record<string, string>[]>(
					(choices, control) =>
						choices.flatMap((choice) =>
							control.options.map((option) => ({ ...choice, [control.key]: option.key })),
						),
					[{}],
				);
				for (const controlValues of controls) {
					for (const aspectRatio of cell.aspectRatios) {
						const input = {
							kind: "text-to-image" as const,
							prompt: "A ceramic vase in soft daylight",
							skuKey: cell.skuKey,
							aspectRatio,
							...controlValues,
						};
						expect(quoteCatalogInput({ productKey, input })).toMatchObject({
							skuKey: cell.skuKey,
							credits: cell.credits,
							catalogVersion: DEFAULT_PRODUCT_CONFIG.catalogVersion,
						});
						const fetch = vi.fn<typeof globalThis.fetch>(async () =>
							Response.json({ code: 200, data: { taskId: "text-image-task" } }),
						);
						const adapter = new KieProviderAdapter({ apiKey: "test", fetch });
						const result = await adapter.submit({
							attemptId: "text-generation",
							providerModelId: official.providerModelId,
							input,
						} as ProviderSubmitInput);
						expect(fetch.mock.calls[0]![0]).toBe(contracts.submitUrl);
						const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
						expect(body.model).toBe(official.providerModelId);
						for (const required of official.required) expect(body.input).toHaveProperty(required);
						const properties: Record<string, { type: string; enum?: string[] } | undefined> =
							official.properties;
						for (const [key, value] of Object.entries(body.input)) {
							expect(properties[key], `${productKey}: undocumented ${key}`).toBeDefined();
							if (properties[key]?.enum) expect(properties[key]!.enum).toContain(value);
						}
						expect(body.input).not.toHaveProperty("input_urls");
						expect(body.input).not.toHaveProperty("image_urls");
						expect(body.input).not.toHaveProperty("image_input");
						expect(result.reconciliation.statusUrl).toBe(
							`${contracts.statusUrl}?taskId=text-image-task`,
						);
						expect(staticDispatchRouteFor("image", "kie", official.providerModelId)).toBeDefined();
					}
				}
			}
		});
	}
});
