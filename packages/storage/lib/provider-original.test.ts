import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn(), archived: vi.fn() }));
vi.mock("./stream-copy", async () => ({
	...(await vi.importActual<typeof import("./stream-copy")>("./stream-copy")),
	openInspectedRemoteMedia: mocks.open,
}));
vi.mock("../provider/s3", async () => ({
	...(await vi.importActual<typeof import("../provider/s3")>("../provider/s3")),
	readArchivedMediaStream: mocks.archived,
}));
import { runWithImageProcessor } from "../image-processing/context";
import { createSharpImageProcessor } from "../image-processing/sharp";
import { prepareProviderImageModeration } from "./image-moderation-input";
import { readProviderOriginalBytes, readProviderCandidateBytes } from "./provider-original-bytes";
const input = {
	url: "https://cdn.test/image.png",
	mimeType: "image/png",
	allowedHosts: ["cdn.test"],
};
async function fixture() {
	const bytes = await sharp({
		create: { width: 160, height: 160, channels: 3, background: "#abcdef" },
	})
		.png()
		.toBuffer();
	mocks.open.mockImplementation(async () => ({
		contentType: "image/png",
		stream: Readable.from([bytes]),
		headers: { "content-length": String(bytes.length) },
	}));
	return bytes;
}
describe("provider original identity and review preparation", () => {
	it("can re-review a matching archived original after the provider URL expires", async () => {
		const body = await fixture();
		const checksum = createHash("sha256").update(body).digest("hex");
		mocks.open.mockClear();
		mocks.open.mockRejectedValue(new Error("expired provider URL"));
		mocks.archived.mockResolvedValue({
			body: new Blob([body]).stream(),
			contentLength: body.length,
			contentType: "image/png",
			etag: '"archive"',
		});
		const prepared = await prepareProviderImageModeration({
			...input,
			checksum,
			archiveKey: "provider-original-v1/users/owner/assets/asset/original.png",
		});
		expect(prepared).toMatchObject({ checksum, bytes: body.length });
		expect(mocks.open).not.toHaveBeenCalled();
	});
	it("prepares SeeAPI from the provider bytes and serves the exact full image without storage", async () => {
		const body = await fixture();
		const prepared = await prepareProviderImageModeration(input);
		expect(prepared.checksum).toBe(createHash("sha256").update(body).digest("hex"));
		expect(prepared.bytes).toBe(body.length);
		const jpeg = Buffer.from(prepared.assetUrl.split(",")[1]!, "base64");
		expect(await sharp(jpeg).metadata()).toMatchObject({
			width: 1568,
			height: 1568,
			format: "jpeg",
		});
		expect(Buffer.from(await readProviderOriginalBytes({ ...input, ...prepared }))).toEqual(body);
		await expect(
			readProviderOriginalBytes({ ...input, ...prepared, checksum: "f".repeat(64) }),
		).rejects.toThrow("ORIGINAL_IDENTITY_CHANGED");
		await expect(
			readProviderOriginalBytes({ ...input, ...prepared, bytes: body.length - 1 }),
		).rejects.toThrow("ORIGINAL_IDENTITY_CHANGED");
	});
	it("reviews and delivers the same deterministic watermarked guest derivative without a clean staging object", async () => {
		const body = await fixture();
		await runWithImageProcessor(createSharpImageProcessor(), async () => {
			const prepared = await prepareProviderImageModeration({ ...input, watermark: true });
			expect(prepared.checksum).not.toBe(createHash("sha256").update(body).digest("hex"));
			const rendered = await readProviderOriginalBytes({ ...input, ...prepared, watermark: true });
			const archived = await readProviderCandidateBytes({ ...input, watermark: true });
			expect(rendered).toEqual(archived);
			expect(createHash("sha256").update(archived).digest("hex")).toBe(prepared.checksum);
		});
	});
	it("rejects incomplete downloads before moderation or exposure", async () => {
		const body = await fixture();
		mocks.open.mockImplementation(async () => ({
			contentType: "image/png",
			stream: Readable.from([body.subarray(0, body.length - 1)]),
			headers: { "content-length": String(body.length) },
		}));
		await expect(prepareProviderImageModeration(input)).rejects.toThrow();
		await expect(readProviderCandidateBytes({ ...input, watermark: true })).rejects.toThrow(
			"ORIGINAL_IDENTITY_CHANGED",
		);
	});
});
