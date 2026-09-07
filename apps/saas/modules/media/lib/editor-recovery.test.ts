import { EZPIC_PRODUCT_KEYS } from "@repo/config/client";
import { describe, expect, it } from "vitest";

import { hasEditorRecoveryRequest, resolveEditorAllowedProductKeys } from "./editor-recovery";
import { buildEditAgainRecoveryCandidate, resolveEditorRecovery } from "./editor-recovery.server";

const SOURCE_ASSET_ID = "asset_01J5ABCD1234EFGH5678JKLMNP";
const sourceAsset = {
	id: SOURCE_ASSET_ID,
	status: "READY",
	mimeType: "image/png",
	deletedAt: null,
};

describe("resolveEditorRecovery", () => {
	it("treats a parent-only branch URL as a recovery request that must fail closed", () => {
		expect(hasEditorRecoveryRequest({ parentJob: "job-parent" }, null)).toBe(true);
		expect(hasEditorRecoveryRequest({}, null)).toBe(false);
	});

	it("derives current Kie-backed product entitlements from the durable billing plan", () => {
		expect(resolveEditorAllowedProductKeys({ planId: "creator" }, "ignored")).toEqual([
			...EZPIC_PRODUCT_KEYS,
		]);
		expect(resolveEditorAllowedProductKeys({}, "unknown-plan")).toEqual([
			"image-nano-banana-2-lite",
		]);
	});

	it("preserves a matrix-valid paid selection for upgrade", () => {
		expect(
			resolveEditorRecovery({
				requested: true,
				candidate: {
					productKey: "image-gpt-image-2",
					input: {
						kind: "image-to-image",
						prompt: "  Replace the sky with a soft sunset  ",
						sourceAssetId: SOURCE_ASSET_ID,
						skuKey: "gpt-image-2-4k",
						aspectRatio: "16:9",
					},
				},
				sourceAsset,
				allowedProductKeys: ["image-nano-banana-2-lite"],
			}),
		).toEqual({
			initialDraft: {
				productKey: "image-gpt-image-2",
				input: {
					kind: "image-to-image",
					prompt: "Replace the sky with a soft sunset",
					sourceAssetId: SOURCE_ASSET_ID,
					skuKey: "gpt-image-2-4k",
					aspectRatio: "16:9",
				},
			},
			restoreState: "ready",
			notice: "quality-upgrade-required",
		});
	});

	it("preserves Nano Banana JPEG when recovering a claimed or reused draft", () => {
		expect(
			resolveEditorRecovery({
				requested: true,
				candidate: {
					productKey: "image-nano-banana",
					input: {
						kind: "image-to-image",
						prompt: "  Keep the composition  ",
						sourceAssetId: SOURCE_ASSET_ID,
						skuKey: "nano-banana-default",
						aspectRatio: "4:3",
						outputFormat: "jpeg",
						background: "transparent",
						provider: "kie",
						providerModelId: "must-not-copy",
						providerCostMicros: 20_000,
						credentials: "must-not-copy",
						unknownSetting: "must-not-copy",
					},
				},
				sourceAsset,
				allowedProductKeys: ["image-nano-banana"],
			}),
		).toEqual({
			initialDraft: {
				productKey: "image-nano-banana",
				input: {
					kind: "image-to-image",
					prompt: "Keep the composition",
					sourceAssetId: SOURCE_ASSET_ID,
					skuKey: "nano-banana-default",
					aspectRatio: "4:3",
					outputFormat: "jpeg",
				},
			},
			restoreState: "ready",
			notice: null,
		});
	});

	it("preserves GPT Image 2 1K transparent background through Edit again recovery", () => {
		const candidate = buildEditAgainRecoveryCandidate(
			{
				productKey: "image-gpt-image-2",
				inputSnapshot: {
					kind: "image-to-image",
					prompt: "Previous prompt",
					sourceAssetId: "asset-previous",
					skuKey: "gpt-image-2-1k",
					aspectRatio: "1:1",
					background: "transparent",
					provider: "kie",
					providerModelId: "must-not-copy",
					providerCostMicros: 30_000,
					credentials: "must-not-copy",
					unknownSetting: "must-not-copy",
				},
			},
			SOURCE_ASSET_ID,
		);

		expect(candidate).toEqual({
			productKey: "image-gpt-image-2",
			input: {
				kind: "image-to-image",
				prompt: "",
				sourceAssetId: SOURCE_ASSET_ID,
				skuKey: "gpt-image-2-1k",
				aspectRatio: "1:1",
				background: "transparent",
			},
		});
		expect(
			resolveEditorRecovery({
				requested: true,
				candidate,
				sourceAsset,
				allowedProductKeys: ["image-gpt-image-2"],
			}),
		).toMatchObject({
			initialDraft: {
				productKey: "image-gpt-image-2",
				input: {
					prompt: "",
					skuKey: "gpt-image-2-1k",
					aspectRatio: "1:1",
					background: "transparent",
				},
			},
			notice: null,
		});
	});

	it("keeps a matrix-valid source while private verification is finishing", () => {
		expect(
			resolveEditorRecovery({
				requested: true,
				candidate: {
					productKey: "image-nano-banana-2-lite",
					input: {
						kind: "image-to-image",
						prompt: "Keep the subject and change the background",
						sourceAssetId: SOURCE_ASSET_ID,
						skuKey: "nano-banana-2-lite-1k",
						aspectRatio: "auto",
					},
				},
				sourceAsset: { ...sourceAsset, status: "VERIFYING", mimeType: "image/webp" },
				allowedProductKeys: ["image-nano-banana-2-lite"],
			}),
		).toMatchObject({
			restoreState: "verifying",
			initialDraft: {
				productKey: "image-nano-banana-2-lite",
				input: { sourceAssetId: SOURCE_ASSET_ID, skuKey: "nano-banana-2-lite-1k" },
			},
		});
	});

	it("restores an empty-prompt edit-again candidate without losing its SKU", () => {
		const candidate = buildEditAgainRecoveryCandidate(
			{
				productKey: "image-seedream-5-pro",
				inputSnapshot: {
					kind: "image-to-image",
					prompt: "Previous prompt",
					sourceAssetId: "asset-previous",
					skuKey: "seedream-5-pro-high-2k",
					aspectRatio: "9:16",
					providerModelId: "must-not-copy",
				},
			},
			SOURCE_ASSET_ID,
		);

		expect(candidate).toEqual({
			productKey: "image-seedream-5-pro",
			input: {
				kind: "image-to-image",
				prompt: "",
				sourceAssetId: SOURCE_ASSET_ID,
				skuKey: "seedream-5-pro-high-2k",
				aspectRatio: "9:16",
			},
		});
		expect(
			resolveEditorRecovery({
				requested: true,
				candidate,
				sourceAsset,
				allowedProductKeys: ["image-seedream-5-pro"],
			}),
		).toMatchObject({
			initialDraft: {
				productKey: "image-seedream-5-pro",
				input: {
					prompt: "",
					skuKey: "seedream-5-pro-high-2k",
					aspectRatio: "9:16",
				},
			},
			notice: null,
		});
	});

	it.each([
		[
			"a SKU from another product",
			{
				productKey: "image-nano-banana-2-lite",
				input: {
					kind: "image-to-image",
					prompt: "x",
					sourceAssetId: SOURCE_ASSET_ID,
					skuKey: "gpt-image-2-2k",
					aspectRatio: "1:1",
				},
			},
		],
		[
			"an aspect ratio outside the selected SKU matrix",
			{
				productKey: "image-gpt-image-2",
				input: {
					kind: "image-to-image",
					prompt: "x",
					sourceAssetId: SOURCE_ASSET_ID,
					skuKey: "gpt-image-2-4k",
					aspectRatio: "1:1",
				},
			},
		],
	] as const)("rejects %s", (_label, candidate) => {
		expect(
			resolveEditorRecovery({
				requested: true,
				candidate,
				sourceAsset,
				allowedProductKeys: [
					"image-nano-banana-2-lite",
					"image-gpt-image-2",
					"image-seedream-5-pro",
				],
			}),
		).toEqual({ initialDraft: null, restoreState: "error", notice: "unavailable" });
	});

	it.each([
		[
			"image-fast",
			"16:9",
			["image-nano-banana-2-lite"] as const,
			"image-nano-banana-2-lite",
			"nano-banana-2-lite-1k",
			"16:9",
			null,
		],
		[
			"image-quality",
			"auto",
			["image-nano-banana-2-lite"] as const,
			"image-gpt-image-2",
			"gpt-image-2-2k",
			"1:1",
			"quality-upgrade-required",
		],
	] as const)(
		"migrates legacy %s recovery into a legal current selection",
		(productKey, aspectRatio, allowedProductKeys, targetProduct, skuKey, targetRatio, notice) => {
			expect(
				resolveEditorRecovery({
					requested: true,
					candidate: {
						productKey,
						input: {
							kind: "image-to-image",
							prompt: "Legacy prompt",
							sourceAssetId: SOURCE_ASSET_ID,
							aspectRatio,
						},
					},
					sourceAsset,
					allowedProductKeys: [...allowedProductKeys],
				}),
			).toMatchObject({
				initialDraft: {
					productKey: targetProduct,
					input: { skuKey, aspectRatio: targetRatio },
				},
				notice,
			});
		},
	);

	it.each([
		["missing draft", null, null],
		[
			"deleted image",
			{
				productKey: "image-nano-banana-2-lite",
				input: {
					kind: "image-to-image",
					prompt: "Change the light",
					sourceAssetId: SOURCE_ASSET_ID,
					skuKey: "nano-banana-2-lite-1k",
					aspectRatio: "auto",
				},
			},
			{ ...sourceAsset, status: "DELETED", deletedAt: new Date("2026-08-25") },
		],
		[
			"non-editor input",
			{
				productKey: "video-fast",
				input: { kind: "image-to-video", prompt: "Animate it", sourceAssetId: SOURCE_ASSET_ID },
			},
			sourceAsset,
		],
	] as const)("reports an explicit error for %s", (_case, candidate, asset) => {
		expect(
			resolveEditorRecovery({
				requested: true,
				candidate,
				sourceAsset: asset,
				allowedProductKeys: ["image-nano-banana-2-lite"],
			}),
		).toEqual({ initialDraft: null, restoreState: "error", notice: "unavailable" });
	});

	it("keeps an ordinary visit empty without showing a recovery error", () => {
		expect(
			resolveEditorRecovery({
				requested: false,
				candidate: null,
				sourceAsset: null,
				allowedProductKeys: ["image-nano-banana-2-lite"],
			}),
		).toEqual({ initialDraft: null, restoreState: "idle", notice: null });
	});
});
