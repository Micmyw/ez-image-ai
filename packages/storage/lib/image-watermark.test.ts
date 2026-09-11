import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { createGuestWatermarkTransform } from "../image-processing/sharp";
import { GUEST_WATERMARK_VERSION, createWatermarkStagedGuestImage } from "./image-watermark";

describe("guest image watermark", () => {
	it("passes only portable dimensions and storage identity to the selected transformer", async () => {
		let received: unknown;
		const watermark = createWatermarkStagedGuestImage({
			inspectImage: async () => ({ width: 640, height: 400 }),
			transformAndStore: async (input) => {
				received = input;
				return { bytes: 10, sha256: "a".repeat(64) };
			},
			deleteObject: async () => undefined,
		});
		const input = {
			staging: { bucket: "media" as const, key: "users/guest/staging/clean.png" },
			final: { bucket: "media" as const, key: "users/guest/assets/output/original.png" },
			contentType: "image/png" as const,
			deleteAfter: new Date("2026-08-29T00:00:00.000Z"),
		};
		await watermark({ ...input, now: () => new Date("2026-08-28T00:00:00.000Z") });
		expect(received).toEqual({ ...input, width: 640, height: 400 });
	});

	it("retains clean staging when transformation or final storage fails", async () => {
		const deleted: string[] = [];
		const watermark = createWatermarkStagedGuestImage({
			inspectImage: async () => ({ width: 640, height: 400 }),
			transformAndStore: async () => {
				throw new Error("Images unavailable");
			},
			deleteObject: async (location) => {
				deleted.push(location.key);
			},
		});
		await expect(
			watermark({
				staging: { bucket: "media", key: "users/guest/staging/clean.png" },
				final: { bucket: "media", key: "users/guest/assets/output/original.png" },
				contentType: "image/png",
				deleteAfter: new Date("2026-08-29T00:00:00.000Z"),
				now: () => new Date("2026-08-28T00:00:00.000Z"),
			}),
		).rejects.toThrow("Images unavailable");
		expect(deleted).toEqual([]);
	});

	it("renders deterministic transformed bytes with a proportional lower-right EzPic plate", async () => {
		const source = await sharp({
			create: { width: 640, height: 400, channels: 3, background: "#dbeafe" },
		})
			.png()
			.toBuffer();
		const first = await collect(
			Readable.from(source).pipe(
				createGuestWatermarkTransform({ width: 640, height: 400, contentType: "image/png" }),
			),
		);
		const second = await collect(
			Readable.from(source).pipe(
				createGuestWatermarkTransform({ width: 640, height: 400, contentType: "image/png" }),
			),
		);

		expect(first.equals(second)).toBe(true);
		expect(first.equals(source)).toBe(false);
		expect(await sharp(first).metadata()).toMatchObject({ width: 640, height: 400 });
		expect(createHash("sha256").update(first).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
	});

	it("deletes clean staging before reporting a transformed image as publishable", async () => {
		const transformed = Buffer.from("watermarked-image");
		const deleteObject = vi.fn(async () => undefined);
		const watermarkStagedGuestImage = createWatermarkStagedGuestImage({
			inspectImage: async () => ({ width: 640, height: 400 }),
			transformAndStore: async () => ({
				bytes: transformed.byteLength,
				sha256: createHash("sha256").update(transformed).digest("hex"),
				etag: "etag-1",
				versionId: "version-1",
			}),
			deleteObject,
		});

		const result = await watermarkStagedGuestImage({
			staging: { bucket: "media", key: "users/guest/staging/clean.png" },
			final: { bucket: "media", key: "users/guest/assets/output/original.png" },
			contentType: "image/png",
			deleteAfter: new Date("2026-08-29T00:00:00.000Z"),
			now: () => new Date("2026-08-28T00:00:00.000Z"),
		});

		expect(deleteObject).toHaveBeenCalledWith({
			bucket: "media",
			key: "users/guest/staging/clean.png",
		});
		expect(result).toEqual({
			bytes: transformed.byteLength,
			sha256: createHash("sha256").update(transformed).digest("hex"),
			etag: "etag-1",
			versionId: "version-1",
			cleanStagingDeletedAt: new Date("2026-08-28T00:00:00.000Z"),
		});
		expect(GUEST_WATERMARK_VERSION).toBe("ezpic-guest-v1");
	});

	it("fails closed when clean staging cannot be physically deleted", async () => {
		const watermarkStagedGuestImage = createWatermarkStagedGuestImage({
			inspectImage: async () => ({ width: 640, height: 400 }),
			transformAndStore: async () => ({ bytes: 10, sha256: "a".repeat(64) }),
			deleteObject: async () => {
				throw new Error("storage unavailable");
			},
		});

		await expect(
			watermarkStagedGuestImage({
				staging: { bucket: "media", key: "users/guest/staging/clean.png" },
				final: { bucket: "media", key: "users/guest/assets/output/original.png" },
				contentType: "image/png",
				deleteAfter: new Date("2026-08-29T00:00:00.000Z"),
				now: () => new Date("2026-08-28T00:00:00.000Z"),
			}),
		).rejects.toMatchObject({
			code: "GUEST_CLEAN_STAGE_DELETE_REQUIRED",
			stage: "TRANSFER",
			retryable: false,
		});
	});
});

async function collect(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}
