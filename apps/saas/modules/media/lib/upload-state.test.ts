import { describe, expect, it } from "vitest";

import {
	createPersistedUploadState,
	getPendingPartNumbers,
	parsePersistedUploadState,
} from "./upload-state";

describe("resumable media upload state", () => {
	it("persists only opaque session progress and never signed URLs or storage secrets", () => {
		const serialized = createPersistedUploadState({
			sessionId: "session_1",
			assetId: "asset_1",
			fileFingerprint: "video.mp4:1000:42",
			partCount: 3,
			completedParts: [{ partNumber: 1, etag: "etag-1" }],
		});
		expect(serialized).not.toContain("https://");
		expect(serialized).not.toContain("uploadId");
		expect(parsePersistedUploadState(serialized)).toEqual({
			sessionId: "session_1",
			assetId: "asset_1",
			fileFingerprint: "video.mp4:1000:42",
			partCount: 3,
			completedParts: [{ partNumber: 1, etag: "etag-1" }],
		});
	});

	it("calculates parts that need fresh URLs after refresh", () => {
		expect(
			getPendingPartNumbers({ partCount: 4, completedParts: [{ partNumber: 2, etag: "e" }] }),
		).toEqual([1, 3, 4]);
	});

	it("rejects corrupted or secret-bearing persisted state", () => {
		expect(
			parsePersistedUploadState(
				'{"sessionId":"x","assetId":"a","fileFingerprint":"f","partCount":1,"completedParts":[],"uploadUrl":"secret"}',
			),
		).toBeNull();
		expect(parsePersistedUploadState("not-json")).toBeNull();
	});
});
