import { describe, expect, it } from "vitest";

import {
	assertCompletedObjectMatchesSession,
	parseUploadRequest,
	toMediaAssetDto,
} from "./upload-validation";

describe("media upload validation", () => {
	it("accepts only supported content types within product byte caps", () => {
		expect(parseUploadRequest({ contentType: "image/png", byteSize: 1024 })).toEqual({
			contentType: "image/png",
			byteSize: 1024,
			multipart: false,
		});
		expect(
			parseUploadRequest({ contentType: "video/mp4", byteSize: 30 * 1024 * 1024 }).multipart,
		).toBe(true);
		expect(() => parseUploadRequest({ contentType: "image/svg+xml", byteSize: 10 })).toThrow(
			/type/i,
		);
		expect(() =>
			parseUploadRequest({ contentType: "image/png", byteSize: 25 * 1024 * 1024 + 1 }),
		).toThrow(/limit/i);
	});

	it("requires HEAD metadata and magic bytes to agree before verification", () => {
		expect(() =>
			assertCompletedObjectMatchesSession({
				expectedContentType: "video/mp4",
				expectedBytes: 100,
				head: { contentLength: 100, contentType: "video/mp4", etag: '"etag"', metadata: {} },
				header: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
			}),
		).toThrow(/signature/i);
		expect(() =>
			assertCompletedObjectMatchesSession({
				expectedContentType: "image/png",
				expectedBytes: 100,
				head: { contentLength: 99, contentType: "image/png", etag: '"etag"', metadata: {} },
				header: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
			}),
		).toThrow(/size/i);
	});

	it("serializes BigInt fields without leaking an object key", () => {
		expect(
			toMediaAssetDto({
				id: "asset_1",
				status: "VERIFYING",
				mimeType: "image/png",
				byteSize: BigInt(123),
				objectKey: "users/user_1/assets/asset_1/original.png",
			}),
		).toEqual({ id: "asset_1", status: "VERIFYING", mimeType: "image/png", byteSize: "123" });
	});
});
