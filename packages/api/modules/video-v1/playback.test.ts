import { describe, expect, it } from "vitest";

import { parseVideoRange, verifyPlaybackGrant, signPlaybackGrant } from "./playback-policy";

describe("video V1 private playback", () => {
	it("supports closed, open and suffix byte ranges", () => {
		expect(parseVideoRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
		expect(parseVideoRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
		expect(parseVideoRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
		expect(parseVideoRange("bytes=0-100", 10)).toEqual({ start: 0, end: 9 });
	});
	it("returns 416 for invalid ranges, ignores multipart rather than forging it", () => {
		for (const value of [
			"bytes=10-",
			"bytes=6-3",
			"bytes=-0",
			"bytes=x-y",
			"bytes=9007199254740999-",
		])
			expect(parseVideoRange(value, 10)).toBe("invalid");
		expect(parseVideoRange("bytes=0-1,4-5", 10)).toBeNull();
	});
	it("binds five-minute grants to owner, content and disposition and rejects expiry", () => {
		const identity = {
			userId: "user1",
			jobId: "job1",
			assetId: "asset1",
			checksum: "a".repeat(64),
			expires: 300_000,
			download: false,
		};
		const secret = "local-test-key-".repeat(4);
		const signature = signPlaybackGrant(identity, secret);
		expect(verifyPlaybackGrant(identity, signature, secret, 1)).toBe(true);
		expect(verifyPlaybackGrant(identity, signature, secret, 300_001)).toBe(false);
		expect(verifyPlaybackGrant({ ...identity, userId: "user2" }, signature, secret, 1)).toBe(false);
		expect(
			verifyPlaybackGrant({ ...identity, checksum: "b".repeat(64) }, signature, secret, 1),
		).toBe(false);
		expect(verifyPlaybackGrant({ ...identity, download: true }, signature, secret, 1)).toBe(false);
	});
});
