import { describe, expect, it } from "vitest";

import type { GuestCapabilityProduct } from "./guest-draft-client";
import {
	localizeLandingProducts,
	landingDisabledReason,
	resolveLandingAspectRatioSelection,
	resolveLandingProductSelection,
	resolveLandingSkuSelection,
} from "./landing-generator-workflow";

const products = [
	{
		key: "image-nano-banana-2-lite" as const,
		label: "Nano Banana 2 Lite",
		description: "Everyday edits",
		credits: "5" as const,
		accessHint: "guest-trial" as const,
		aspectRatios: ["auto", "1:1", "16:9", "9:16"] as const,
		skuMatrix: {
			defaultSkuKey: "nano-banana-2-lite-1k" as const,
			dimensions: [
				{ key: "resolution" as const, label: "Resolution", options: [{ key: "1k", label: "1K" }] },
			],
			cells: [
				{
					skuKey: "nano-banana-2-lite-1k" as const,
					label: "1K",
					parameterValues: { resolution: "1k" },
					credits: 5,
					aspectRatios: ["auto", "1:1", "16:9", "9:16"] as const,
					controls: [],
				},
			],
		},
	},
	{
		key: "image-gpt-image-2" as const,
		label: "GPT Image 2",
		description: "Higher fidelity",
		credits: "11" as const,
		accessHint: "paid-account" as const,
		aspectRatios: ["1:1", "16:9", "9:16"] as const,
		skuMatrix: {
			defaultSkuKey: "gpt-image-2-2k" as const,
			dimensions: [
				{
					key: "resolution" as const,
					label: "Resolution",
					options: [
						{ key: "2k", label: "2K" },
						{ key: "4k", label: "4K" },
					],
				},
			],
			cells: [
				{
					skuKey: "gpt-image-2-2k" as const,
					label: "2K",
					parameterValues: { resolution: "2k" },
					credits: 11,
					aspectRatios: ["1:1", "16:9", "9:16"] as const,
					controls: [],
				},
				{
					skuKey: "gpt-image-2-4k" as const,
					label: "4K",
					parameterValues: { resolution: "4k" },
					credits: 17,
					aspectRatios: ["16:9", "9:16"] as const,
					controls: [],
				},
			],
		},
	},
] satisfies GuestCapabilityProduct[];

describe("landing generator workflow", () => {
	it("replaces server-owned English product and SKU labels before rendering", () => {
		const localized = localizeLandingProducts(products, {
			productLabel: (key) => `Localized product: ${key}`,
			productDescription: (key) => `Localized description: ${key}`,
			skuLabel: (key) => `Localized SKU: ${key}`,
		});

		expect(localized[0]?.label).toBe("Localized product: image-nano-banana-2-lite");
		expect(localized[0]?.description).toBe("Localized description: image-nano-banana-2-lite");
		expect(localized[0]?.skuMatrix.cells[0]?.label).toBe("Localized SKU: nano-banana-2-lite-1k");
		expect(JSON.stringify(localized)).not.toContain("Everyday edits");
	});

	it("keeps a valid tier selection and otherwise prefers the real guest trial", () => {
		expect(resolveLandingProductSelection(products, "image-gpt-image-2")).toBe("image-gpt-image-2");
		expect(resolveLandingProductSelection(products, null)).toBe("image-nano-banana-2-lite");
		expect(resolveLandingProductSelection(products.slice(1), "image-nano-banana-2-lite")).toBe(
			"image-gpt-image-2",
		);
		expect(resolveLandingProductSelection([], "image-nano-banana-2-lite")).toBeNull();
	});

	it("keeps a supported aspect ratio and falls back to Automatic for a changed tier", () => {
		expect(resolveLandingAspectRatioSelection(products[0]!, "16:9")).toBe("16:9");
		expect(resolveLandingAspectRatioSelection(products[1]!, "4:3")).toBe("1:1");
		expect(resolveLandingAspectRatioSelection(null, "16:9")).toBeNull();
	});

	it("keeps a model-local SKU and otherwise selects that model's default cell", () => {
		expect(resolveLandingSkuSelection(products[1]!, "gpt-image-2-4k")).toBe("gpt-image-2-4k");
		expect(resolveLandingSkuSelection(products[1]!, "nano-banana-2-lite-1k")).toBe(
			"gpt-image-2-2k",
		);
		expect(resolveLandingSkuSelection(null, "gpt-image-2-2k")).toBeNull();
	});

	it("names the first missing condition and never enables a busy workflow", () => {
		const ready = {
			stage: "ready" as const,
			capabilityEnabled: true,
			productSelected: true,
			hasSource: true,
			prompt: "Replace the background",
			turnstileReady: true,
		};

		expect(landingDisabledReason({ ...ready, stage: "checking" })).toBe("checking");
		expect(landingDisabledReason({ ...ready, capabilityEnabled: false })).toBe("unavailable");
		expect(landingDisabledReason({ ...ready, productSelected: false })).toBe("product");
		expect(landingDisabledReason({ ...ready, hasSource: false })).toBe("source");
		expect(landingDisabledReason({ ...ready, prompt: "   " })).toBe("prompt");
		expect(landingDisabledReason({ ...ready, turnstileReady: false })).toBe("verification");
		expect(landingDisabledReason(ready)).toBeNull();
		for (const stage of ["preparing", "uploading", "verifying", "handoff"] as const) {
			expect(landingDisabledReason({ ...ready, stage })).toBe("busy");
		}
	});
});
