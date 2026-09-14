import {
	EZPIC_PRODUCT_KEYS,
	IMAGE_ASPECT_RATIOS,
	IMAGE_PRODUCT_SELECTION_CONTRACTS,
	type ImageSkuKey,
	type ProductModelKey,
} from "@repo/config";
import { describe, expect, it, vi } from "vitest";

import { getCatalogEntry, quoteCatalogInput } from "../catalog/catalog";
import { staticDispatchRouteFor } from "../catalog/dispatch-manifest";
import type { ProviderSubmitInput } from "../types";
import officialContracts from "./fixtures/kie-official-image-contracts-2026-09-14.json";
import { KieProviderAdapter } from "./kie";

// Independent snapshots of Kie's published OpenAPI, including restrictions in prose.
// Never refresh this fixture from the application catalog or from adapter output.
interface OfficialProperty {
	type: string;
	enum?: string[];
	maxLength?: number;
	minLength?: number;
	maxItems?: number;
	deprecated?: boolean;
}
const sourceAsset = {
	assetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
	transferUrl: "https://transfer.test/source.png",
};
const prompt = "Preserve the subject and improve the lighting";

function capture() {
	const fetch = vi.fn<typeof globalThis.fetch>(async () =>
		Response.json({ code: 200, data: { taskId: "official-contract-check" } }),
	);
	return { fetch, adapter: new KieProviderAdapter({ apiKey: "contract-test", fetch }) };
}

function quotedInput(skuKey: string, aspectRatio: string, text = prompt) {
	return {
		kind: "image-to-image",
		prompt: text,
		sourceAssetId: sourceAsset.assetId,
		skuKey,
		aspectRatio,
	};
}

describe("Kie official image API contracts reviewed 2026-09-14", () => {
	it("covers every public image model with a distinct official model identifier", () => {
		expect(officialContracts.products.map((p) => p.productKey).sort()).toEqual(
			[...EZPIC_PRODUCT_KEYS].sort(),
		);
		expect(new Set(officialContracts.products.map((p) => p.providerModelId)).size).toBe(12);
	});

	for (const official of officialContracts.products) {
		const productKey = official.productKey as ProductModelKey;
		const selection =
			IMAGE_PRODUCT_SELECTION_CONTRACTS[productKey as (typeof EZPIC_PRODUCT_KEYS)[number]];
		const matrix = getCatalogEntry(productKey).imageSpecMatrix!;
		const properties: Partial<Record<string, OfficialProperty>> = official.properties;

		it(`${productKey}: quotes and submits every advertised choice to its exact documented API`, async () => {
			const sourceField = Object.keys(properties).find((key) => properties[key]!.type === "array")!;
			for (const cell of matrix.cells) {
				expect(cell.routes).toHaveLength(1);
				const route = cell.routes[0]!;
				expect(route.provider).toBe("kie");
				expect(route.providerModelId).toBe(official.providerModelId);
				expect(staticDispatchRouteFor("image", "kie", official.providerModelId)).toBeDefined();
				const variations = [
					...cell.aspectRatios.map((aspectRatio) => ({ aspectRatio })),
					...(cell.controls ?? []).flatMap((control) =>
						control.options.map((option) => ({
							aspectRatio: cell.aspectRatios[0]!,
							[control.key]: option.key,
						})),
					),
				];
				for (const variation of variations) {
					const quote = quoteCatalogInput({
						productKey,
						input: { ...quotedInput(cell.skuKey, variation.aspectRatio), ...variation },
					});
					expect(quote).toMatchObject({ productKey, skuKey: cell.skuKey, credits: cell.credits });
					const { fetch, adapter } = capture();
					const submission = await adapter.submit({
						attemptId: "official-contract",
						providerModelId: route.providerModelId,
						input: {
							kind: "image-to-image",
							prompt,
							sourceAsset,
							skuKey: cell.skuKey,
							...variation,
						} as ProviderSubmitInput["input"],
					});
					expect(fetch.mock.calls[0]![0]).toBe(officialContracts.submitUrl);
					expect(fetch.mock.calls[0]![1]?.method).toBe("POST");
					expect(submission.reconciliation.statusUrl).toBe(
						`${officialContracts.statusUrl}?taskId=official-contract-check`,
					);
					const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
					expect(body.model).toBe(official.providerModelId);
					expect(body.input[sourceField]).toEqual([sourceAsset.transferUrl]);
					for (const required of official.required) expect(body.input).toHaveProperty(required);
					for (const [key, value] of Object.entries(body.input)) {
						const property = properties[key];
						expect(property, `${productKey} sends undocumented field ${key}`).toBeDefined();
						if (!property) continue;
						expect(property.deprecated).not.toBe(true);
						if (property.enum) expect(property.enum).toContain(value);
						if (property.maxLength)
							expect((value as string).length).toBeLessThanOrEqual(property.maxLength);
						if (property.maxItems)
							expect((value as unknown[]).length).toBeLessThanOrEqual(property.maxItems);
					}
					if (cell.parameterValues.resolution && body.input.resolution !== undefined)
						expect(body.input.resolution).toBe(cell.parameterValues.resolution.toUpperCase());
					if (productKey === "image-seedream-4") {
						expect(body.input.image_resolution).toBe(
							cell.parameterValues.resolution!.toUpperCase(),
						);
						expect(body.input.max_images).toBe(1);
					}
					if (cell.parameterValues.quality)
						expect(body.input.quality).toBe(cell.parameterValues.quality);
				}
			}
		});

		it(`${productKey}: rejects every other model and unsupported ratio before any provider call`, async () => {
			const { fetch, adapter } = capture();
			for (const other of officialContracts.products.filter(
				(candidate) => candidate !== official,
			)) {
				await expect(
					adapter.submit({
						attemptId: "wrong-model",
						providerModelId: other.providerModelId,
						input: {
							kind: "image-to-image",
							prompt,
							sourceAsset,
							skuKey: selection.defaultSkuKey,
							aspectRatio: selection.defaultAspectRatio,
						},
					}),
				).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT" });
				expect(() =>
					quoteCatalogInput({
						productKey: other.productKey,
						input: quotedInput(selection.defaultSkuKey, selection.defaultAspectRatio),
					}),
				).toThrow();
			}
			for (const cell of matrix.cells) {
				for (const aspectRatio of IMAGE_ASPECT_RATIOS.filter(
					(ratio) => !cell.aspectRatios.includes(ratio),
				)) {
					expect(() =>
						quoteCatalogInput({ productKey, input: quotedInput(cell.skuKey, aspectRatio) }),
					).toThrow();
					await expect(
						adapter.submit({
							attemptId: "invalid-ratio",
							providerModelId: official.providerModelId,
							input: {
								kind: "image-to-image",
								prompt,
								sourceAsset,
								skuKey: cell.skuKey,
								aspectRatio,
							},
						}),
					).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT" });
				}
			}
			expect(fetch).not.toHaveBeenCalled();
		});

		it(`${productKey}: enforces documented prompt limits before quoting and submitting`, async () => {
			const upper = Math.min(properties.prompt!.maxLength ?? 10_000, 10_000);
			const lower = properties.prompt!.minLength ?? 1;
			const { fetch, adapter } = capture();
			for (const text of ["x".repeat(upper + 1), "x".repeat(lower - 1)]) {
				expect(() =>
					quoteCatalogInput({
						productKey,
						input: quotedInput(selection.defaultSkuKey, selection.defaultAspectRatio, text),
					}),
				).toThrow();
				await expect(
					adapter.submit({
						attemptId: "invalid-prompt",
						providerModelId: official.providerModelId,
						input: {
							kind: "image-to-image",
							prompt: text,
							sourceAsset,
							skuKey: selection.defaultSkuKey,
							aspectRatio: selection.defaultAspectRatio,
						},
					}),
				).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT" });
			}
			expect(fetch).not.toHaveBeenCalled();
		});
	}

	it.each(["gpt-image-2-5-sunburst-2k", "gpt-image-2-5-sunburst-4k"] as const)(
		"%s pairs transparent output with Kie's required extraction instruction",
		async (skuKey: ImageSkuKey) => {
			const { fetch, adapter } = capture();
			await adapter.submit({
				attemptId: "transparent",
				providerModelId: "gpt-image-2-5-sunburst-image-to-image",
				input: {
					kind: "image-to-image",
					prompt,
					sourceAsset,
					skuKey,
					aspectRatio: "1:1",
					background: "transparent",
				},
			});
			const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
			expect(body.input.prompt).toContain(prompt);
			expect(body.input.prompt).toMatch(/extract.*subject.*transparent/i);
			expect(body.input.prompt).toMatch(/no backdrop, scenery or shadow/i);
			expect(body.input.background).toBe("transparent");
		},
	);
});
