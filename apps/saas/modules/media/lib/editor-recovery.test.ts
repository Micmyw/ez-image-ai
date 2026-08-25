import { describe, expect, it } from "vitest";

import {
	hasEditorRecoveryRequest,
	resolveEditorAllowedProductKeys,
	resolveEditorRecovery,
} from "./editor-recovery";

const SOURCE_ASSET_ID = "asset_01J5ABCD1234EFGH5678JKLMNP";

describe("resolveEditorRecovery", () => {
	it("treats a parent-only branch URL as a recovery request that must fail closed", () => {
		expect(hasEditorRecoveryRequest({ parentJob: "job-parent" }, null)).toBe(true);
		expect(hasEditorRecoveryRequest({}, null)).toBe(false);
	});

	it("derives editor entitlements from the durable active billing plan and defaults safely", () => {
		expect(resolveEditorAllowedProductKeys({ planId: "creator" }, "ignored")).toEqual([
			"image-fast",
			"image-quality",
		]);
		expect(resolveEditorAllowedProductKeys({}, "unknown-plan")).toEqual(["image-fast"]);
	});

	it("preserves a claimed draft image and prompt while safely downgrading unavailable Quality", () => {
		expect(
			resolveEditorRecovery({
				requested: true,
				candidate: {
					productKey: "image-quality",
					input: {
						kind: "image-to-image",
						prompt: "  Replace the sky with a soft sunset  ",
						sourceAssetId: SOURCE_ASSET_ID,
					},
				},
				sourceAsset: {
					id: SOURCE_ASSET_ID,
					status: "READY",
					mimeType: "image/png",
					deletedAt: null,
				},
				allowedProductKeys: ["image-fast"],
			}),
		).toEqual({
			initialDraft: {
				productKey: "image-fast",
				input: {
					kind: "image-to-image",
					prompt: "Replace the sky with a soft sunset",
					sourceAssetId: SOURCE_ASSET_ID,
				},
			},
			restoreState: "ready",
			notice: "quality-downgraded",
		});
	});

	it("keeps a claimed source while private verification is still finishing", () => {
		expect(
			resolveEditorRecovery({
				requested: true,
				candidate: {
					productKey: "image-fast",
					input: {
						kind: "image-to-image",
						prompt: "Keep the subject and change the background",
						sourceAssetId: SOURCE_ASSET_ID,
					},
				},
				sourceAsset: {
					id: SOURCE_ASSET_ID,
					status: "VERIFYING",
					mimeType: "image/webp",
					deletedAt: null,
				},
				allowedProductKeys: ["image-fast", "image-quality"],
			}),
		).toMatchObject({
			restoreState: "verifying",
			initialDraft: { input: { sourceAssetId: SOURCE_ASSET_ID } },
		});
	});

	it.each([
		["READY", "ready"],
		["VERIFYING", "verifying"],
	] as const)(
		"restores a %s source with an empty prompt so the user can write a new instruction",
		(status, restoreState) => {
			expect(
				resolveEditorRecovery({
					requested: true,
					candidate: {
						productKey: "image-fast",
						input: {
							kind: "image-to-image",
							prompt: "",
							sourceAssetId: SOURCE_ASSET_ID,
						},
					},
					sourceAsset: {
						id: SOURCE_ASSET_ID,
						status,
						mimeType: "image/png",
						deletedAt: null,
					},
					allowedProductKeys: ["image-fast", "image-quality"],
				}),
			).toEqual({
				initialDraft: {
					productKey: "image-fast",
					input: {
						kind: "image-to-image",
						prompt: "",
						sourceAssetId: SOURCE_ASSET_ID,
					},
				},
				restoreState,
				notice: null,
			});
		},
	);

	it.each([
		["missing draft", null, null],
		[
			"deleted image",
			{
				productKey: "image-fast",
				input: {
					kind: "image-to-image",
					prompt: "Change the light",
					sourceAssetId: SOURCE_ASSET_ID,
				},
			},
			{
				id: SOURCE_ASSET_ID,
				status: "DELETED",
				mimeType: "image/png",
				deletedAt: new Date("2026-08-25T00:00:00.000Z"),
			},
		],
		[
			"non-editor input",
			{
				productKey: "video-fast",
				input: { kind: "image-to-video", prompt: "Animate it", sourceAssetId: SOURCE_ASSET_ID },
			},
			{
				id: SOURCE_ASSET_ID,
				status: "READY",
				mimeType: "image/png",
				deletedAt: null,
			},
		],
	] as const)(
		"reports an explicit error for %s without constructing an empty edit",
		(_case, candidate, sourceAsset) => {
			expect(
				resolveEditorRecovery({
					requested: true,
					candidate,
					sourceAsset,
					allowedProductKeys: ["image-fast"],
				}),
			).toEqual({ initialDraft: null, restoreState: "error", notice: "unavailable" });
		},
	);

	it("keeps an ordinary visit empty without showing a recovery error", () => {
		expect(
			resolveEditorRecovery({
				requested: false,
				candidate: null,
				sourceAsset: null,
				allowedProductKeys: ["image-fast"],
			}),
		).toEqual({ initialDraft: null, restoreState: "idle", notice: null });
	});
});
