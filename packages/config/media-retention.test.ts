import { describe, expect, it } from "vitest";

import {
	isImageAutomaticDeletionEnabled,
	isImageAutomaticDeletionPaused,
	isMediaAssetStorageReservationReference,
} from "./media-retention";

describe("temporary image retention pause", () => {
	it.each([undefined, "", "false", "TRUE", "1"])("requires an exact opt-in: %s", (value) => {
		expect(isImageAutomaticDeletionEnabled({ MEDIA_IMAGE_AUTO_DELETE_ENABLED: value })).toBe(false);
		expect(
			isImageAutomaticDeletionPaused(
				{ mimeType: "image/png", verificationEngine: "legacy" },
				{ MEDIA_IMAGE_AUTO_DELETE_ENABLED: value },
			),
		).toBe(true);
	});
	it("only pauses legacy image originals", () => {
		expect(isImageAutomaticDeletionEnabled({ MEDIA_IMAGE_AUTO_DELETE_ENABLED: "true" })).toBe(true);
		expect(
			isImageAutomaticDeletionPaused(
				{ mimeType: "image/png", verificationEngine: "legacy" },
				{ MEDIA_IMAGE_AUTO_DELETE_ENABLED: "true" },
			),
		).toBe(false);
		expect(
			isImageAutomaticDeletionPaused({ mimeType: "video/mp4", verificationEngine: "legacy" }, {}),
		).toBe(false);
		expect(
			isImageAutomaticDeletionPaused(
				{ mimeType: "image/png", verificationEngine: "video-workflow-v1" },
				{},
			),
		).toBe(false);
	});
	it.each(["generation-output", "media-draft", "temporary-reference"])(
		"binds %s storage release to the exact asset",
		(prefix) => {
			expect(isMediaAssetStorageReservationReference(`${prefix}:asset`, "asset")).toBe(true);
			expect(isMediaAssetStorageReservationReference(`${prefix}:other`, "asset")).toBe(false);
			expect(isMediaAssetStorageReservationReference("media-upload:asset", "asset")).toBe(false);
		},
	);
});
