import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));
vi.mock("@aws-sdk/client-s3", async (original) => ({
	...(await original<typeof import("@aws-sdk/client-s3")>()),
	S3Client: class {
		send = mock.send;
		destroy = mock.destroy;
	},
}));
import { createSourceMaterialStorage } from "./source-template-material";
const body = Buffer.from(
	"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
	"hex",
);
const input = {
	ownerId: "admin",
	key: `users/admin/source-templates/${"a".repeat(64)}`,
	body,
	bytes: body.length,
	sha256: createHash("sha256").update(body).digest("hex"),
	contentType: "image/png" as const,
};
function stored(value = body) {
	return {
		ContentLength: value.length,
		ContentType: "image/png",
		ETag: "etag",
		VersionId: "v1",
		Body: {
			transformToWebStream: () =>
				new ReadableStream({
					start(controller) {
						controller.enqueue(value);
						controller.close();
					},
				}),
		},
	};
}
function storage() {
	return createSourceMaterialStorage({
		endpoint: "http://localhost:9000",
		bucket: "test-private",
		region: "auto",
		accessKeyId: "fixture",
		secretAccessKey: "fixture",
	});
}
beforeEach(() => vi.clearAllMocks());
describe("immutable source material storage", () => {
	it("uses a conditional private PUT and verifies every stored byte", async () => {
		mock.send
			.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce(stored());
		expect(await storage().write(input)).toEqual({
			bytes: input.bytes,
			sha256: input.sha256,
			etag: "etag",
			versionId: "v1",
		});
		expect(mock.send.mock.calls[1]![0].input).toMatchObject({
			IfNoneMatch: "*",
			ContentLength: input.bytes,
			Metadata: { sha256: input.sha256 },
		});
		expect(mock.send.mock.calls[1]![0].input.ACL).toBeUndefined();
	});
	it("reuses an existing identical object without another PUT", async () => {
		mock.send.mockResolvedValueOnce(stored());
		await storage().write(input);
		expect(mock.send).toHaveBeenCalledTimes(1);
	});
	it("rejects a changed object even when length and content type match", async () => {
		const changed = Buffer.from(body);
		changed[changed.length - 1] ^= 1;
		mock.send.mockResolvedValueOnce(stored(changed));
		await expect(storage().write(input)).rejects.toThrow(
			"SOURCE_TEMPLATE_STORAGE_IDENTITY_MISMATCH",
		);
		expect(mock.send).toHaveBeenCalledTimes(1);
	});
	it("does not retransmit or read after an unknown PUT result", async () => {
		mock.send
			.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
			.mockRejectedValueOnce(new Error("socket lost"));
		await expect(storage().write(input)).rejects.toThrow("socket lost");
		expect(mock.send).toHaveBeenCalledTimes(2);
	});
	it("retrieves after an explicit concurrent conditional-write conflict", async () => {
		mock.send
			.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
			.mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } })
			.mockResolvedValueOnce(stored());
		await storage().write(input);
		expect(mock.send).toHaveBeenCalledTimes(3);
	});
	it("rejects wrong owner keys or mismatched source bytes before storage", async () => {
		await expect(storage().write({ ...input, ownerId: "other" })).rejects.toThrow(
			"SOURCE_TEMPLATE_STORAGE_INPUT_INVALID",
		);
		await expect(storage().write({ ...input, sha256: "f".repeat(64) })).rejects.toThrow(
			"SOURCE_TEMPLATE_STORAGE_INPUT_INVALID",
		);
		expect(mock.send).not.toHaveBeenCalled();
	});
});
