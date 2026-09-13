import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	process.env.S3_ENDPOINT = "https://storage.test";
	process.env.S3_REGION = "auto";
	process.env.S3_ACCESS_KEY_ID = "test-access";
	process.env.S3_SECRET_ACCESS_KEY = "test-secret";
});

import { getSignedUploadUrl } from "./index";

describe("bounded avatar signing", () => {
	it.each([undefined, 0, -1, 1.5, NaN, Infinity, 2_000_001])(
		"refuses an invalid byte count %s",
		async (contentLength) => {
			await expect(
				getSignedUploadUrl("owner.png", {
					bucket: "avatars",
					contentType: "image/png",
					contentLength,
				} as never),
			).rejects.toThrow();
		},
	);

	it("cryptographically binds the declared size and MIME type", async () => {
		const url = new URL(
			await getSignedUploadUrl("owner.png", {
				bucket: "avatars",
				contentType: "image/png",
				contentLength: 1024,
			}),
		);
		expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(
			expect.arrayContaining(["content-length", "content-type"]),
		);
		expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
	});
});
