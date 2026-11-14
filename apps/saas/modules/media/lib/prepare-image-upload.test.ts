import { createHash } from "node:crypto";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	uploadGuestDraft,
	type GuestDraftUploadCheckpoint,
} from "../../landing/lib/guest-draft-client";
import { prepareImageUpload } from "./prepare-image-upload";

let completePng: Buffer;
let damagedFile: File;
let decode: ReturnType<typeof vi.fn>;
let encode: ReturnType<typeof vi.fn>;
let revokeObjectUrl: ReturnType<typeof vi.spyOn>;
let createObjectUrl: ReturnType<typeof vi.spyOn>;
let transform: ReturnType<typeof vi.fn>;
let decodedWidth = 64;
let decodedHeight = 64;

beforeEach(async () => {
	completePng = await sharp({
		create: { width: 64, height: 64, channels: 4, background: "#7c3aed" },
	})
		.png()
		.toBuffer();
	damagedFile = new File([new Uint8Array(completePng.subarray(0, -20))], "photo.png", {
		type: "image/png",
		lastModified: 123,
	});
	decode = vi.fn().mockResolvedValue(undefined);
	transform = vi.fn();
	decodedWidth = 64;
	decodedHeight = 64;
	encode = vi.fn((callback: (blob: Blob) => void) =>
		callback(new Blob([new Uint8Array(completePng)], { type: "image/png" })),
	);
	vi.stubGlobal(
		"Image",
		class {
			naturalWidth = decodedWidth;
			naturalHeight = decodedHeight;
			decode = decode;
		},
	);
	vi.stubGlobal("document", {
		createElement: () => ({
			width: 0,
			height: 0,
			getContext: () => ({ drawImage: vi.fn(), setTransform: transform }),
			toBlob: encode,
		}),
	});
	createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:source");
	revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("truncated PNG upload preparation", () => {
	it("re-encodes a truncated PNG once and retains identical upload bytes on retry", async () => {
		await expect(
			sharp(await damagedFile.arrayBuffer())
				.raw()
				.toBuffer(),
		).rejects.toThrow();
		const [first, concurrent] = await Promise.all([
			prepareImageUpload(damagedFile),
			prepareImageUpload(damagedFile),
		]);
		expect(first).toBe(concurrent);
		expect(await prepareImageUpload(damagedFile)).toBe(first);
		expect(await prepareImageUpload(first)).toBe(first);
		expect(first.name).toBe(damagedFile.name);
		expect(first.lastModified).toBe(123);
		expect(decode).toHaveBeenCalledOnce();
		expect(encode).toHaveBeenCalledOnce();
		expect(revokeObjectUrl).toHaveBeenCalledWith("blob:source");
		await expect(
			sharp(await first.arrayBuffer())
				.raw()
				.toBuffer(),
		).resolves.toHaveLength(64 * 64 * 4);
	});
	it("retains a complete PNG without decoding or re-encoding", async () => {
		const file = new File([new Uint8Array(completePng)], "complete.png", { type: "image/png" });
		expect(await prepareImageUpload(file)).toBe(file);
		expect(decode).not.toHaveBeenCalled();
	});
	it("rejects a repair that exceeds the caller's byte limit", async () => {
		await expect(prepareImageUpload(damagedFile, damagedFile.size)).rejects.toThrow(
			"SOURCE_IMAGE_TOO_LARGE",
		);
	});
	it("releases the preview and permits another local preparation after a decoding failure", async () => {
		decode.mockRejectedValueOnce(new Error("decode failed"));
		await expect(prepareImageUpload(damagedFile)).rejects.toThrow("SOURCE_IMAGE_UNREADABLE");
		expect(revokeObjectUrl).toHaveBeenCalledOnce();
		expect(encode).not.toHaveBeenCalled();
		await prepareImageUpload(damagedFile);
		expect(decode).toHaveBeenCalledTimes(2);
	});
	it("hashes and uploads the repaired file before freezing a guest checkpoint", async () => {
		let checkpoint: GuestDraftUploadCheckpoint | null = null;
		let completionCalls = 0;
		const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
			if (typeof url === "string" && url.endsWith("upload-intents"))
				return Response.json({
					sessionId: "session",
					assetId: "asset",
					uploadUrl: "https://storage.test/upload",
					completionToken: "b".repeat(43),
					expiresAt: "2035-01-01T00:00:00.000Z",
				});
			if (typeof url === "string" && url.endsWith("upload-preparations"))
				return Response.json({ status: "SEALED" });
			if (++completionCalls === 1) return new Response("unknown", { status: 503 });
			return Response.json({
				status: "READY",
				claimToken: "c".repeat(43),
				continueUrl: "/draft/continue",
				productKey: "image-nano-banana-2-lite",
				skuKey: "nano-banana-2-lite-1k",
				accessHint: "guest-trial",
			});
		});
		const uploadFile = vi.fn().mockResolvedValue(undefined);
		const input = {
			capabilityVersion: "v1",
			productKey: "image-nano-banana-2-lite" as const,
			skuKey: "nano-banana-2-lite-1k" as const,
			file: damagedFile,
			prompt: "Keep the subject",
			aspectRatio: "auto" as const,
			turnstileToken: "challenge",
			onCheckpoint: (value: GuestDraftUploadCheckpoint) => {
				checkpoint = value;
			},
		};
		await expect(uploadGuestDraft(input, { fetcher, uploadFile })).rejects.toThrow(
			"GUEST_UPLOAD_COMPLETION_FAILED",
		);
		expect(checkpoint).toMatchObject({ uploaded: true, sealed: true });
		await uploadGuestDraft({ ...input, checkpoint }, { fetcher, uploadFile });
		const intent = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
		expect(intent.bytes).toBe(completePng.length);
		expect(intent.sha256).toBe(createHash("sha256").update(completePng).digest("hex"));
		expect(uploadFile).toHaveBeenCalledOnce();
		expect(await uploadFile.mock.calls[0]![1].arrayBuffer()).toEqual(
			await (await prepareImageUpload(damagedFile)).arrayBuffer(),
		);
		expect(
			fetcher.mock.calls.filter(
				([url]) => typeof url === "string" && url.endsWith("upload-intents"),
			),
		).toHaveLength(1);
		expect(
			fetcher.mock.calls.filter(
				([url]) => typeof url === "string" && url.endsWith("upload-preparations"),
			),
		).toHaveLength(1);
		expect(completionCalls).toBe(2);
	});
});

function heicHeader(width = 64, height = 64): File {
	const box = (name: string, payload: Buffer) => {
		const header = Buffer.alloc(8);
		header.writeUInt32BE(8 + payload.length);
		header.write(name, 4, "ascii");
		return Buffer.concat([header, payload]);
	};
	const size = Buffer.alloc(12);
	size.writeUInt32BE(width, 4);
	size.writeUInt32BE(height, 8);
	return new File(
		[
			new Uint8Array(
				Buffer.concat([
					box("ftyp", Buffer.from("heic\0\0\0\0mif1", "ascii")),
					box(
						"meta",
						Buffer.concat([Buffer.alloc(4), box("iprp", box("ipco", box("ispe", size)))]),
					),
				]),
			),
		],
		"phone.heic",
		{ type: "image/heic", lastModified: 123 },
	);
}

describe("mobile image normalization", () => {
	it.each([
		[2, [-1, 0, 0, 1, 80, 0]],
		[3, [-1, 0, 0, -1, 80, 40]],
		[4, [1, 0, 0, -1, 0, 40]],
		[5, [0, 1, 1, 0, 0, 0]],
		[6, [0, 1, -1, 0, 40, 0]],
		[7, [0, -1, -1, 0, 40, 80]],
		[8, [0, -1, 1, 0, 0, 80]],
	])(
		"normalizes EXIF orientation %i once before the upload identity exists",
		async (orientation, expected) => {
			decodedWidth = 80;
			decodedHeight = 40;
			const jpeg = await sharp({
				create: { width: 80, height: 40, channels: 3, background: "#aa3344" },
			})
				.withMetadata({ orientation: orientation as number })
				.jpeg()
				.toBuffer();
			const upright = await sharp(jpeg).rotate().jpeg().toBuffer();
			encode.mockImplementation((callback: (blob: Blob) => void) =>
				callback(new Blob([new Uint8Array(upright)], { type: "image/jpeg" })),
			);
			const original = new File([new Uint8Array(jpeg)], "camera.jpg", { type: "image/jpeg" });
			const result = await prepareImageUpload(original);
			expect(transform).toHaveBeenCalledWith(...(expected as number[]));
			const decoderBlob = createObjectUrl.mock.calls[0]![0] as Blob;
			expect((await sharp(await decoderBlob.arrayBuffer()).metadata()).orientation).toBe(1);
			expect(result.type).toBe("image/jpeg");
			expect(await prepareImageUpload(original)).toBe(result);
			expect(await prepareImageUpload(result)).toBe(result);
			expect(encode).toHaveBeenCalledOnce();
		},
	);
	it("preserves original transparent PNG/WebP bytes", async () => {
		for (const format of ["png", "webp"] as const) {
			const bytes = await sharp({
				create: {
					width: 64,
					height: 64,
					channels: 4,
					background: { r: 5, g: 10, b: 20, alpha: 0 },
				},
			})
				[format]()
				.toBuffer();
			const file = new File([new Uint8Array(bytes)], `transparent.${format}`, {
				type: `image/${format}`,
			});
			expect(await prepareImageUpload(file)).toBe(file);
			expect((await sharp(await file.arrayBuffer()).metadata()).hasAlpha).toBe(true);
		}
		expect(decode).not.toHaveBeenCalled();
		expect(encode).not.toHaveBeenCalled();
	});
	it("converts HEIC only after a successful native decode, retaining stable PNG bytes", async () => {
		const file = heicHeader();
		const result = await prepareImageUpload(file);
		expect(result.name).toBe("phone.png");
		expect(result.type).toBe("image/png");
		expect(result.lastModified).toBe(123);
		expect(await prepareImageUpload(file)).toBe(result);
		expect(await prepareImageUpload(result)).toBe(result);
		expect(encode).toHaveBeenCalledOnce();
	});
	it("explains unsupported HEIC instead of attempting a server upload with HEIC MIME", async () => {
		decode.mockRejectedValue(new Error("unsupported codec"));
		await expect(prepareImageUpload(heicHeader())).rejects.toThrow("SOURCE_IMAGE_HEIC_UNSUPPORTED");
		expect(encode).not.toHaveBeenCalled();
		expect(revokeObjectUrl).toHaveBeenCalledOnce();
	});
	it("bounds HEIC dimensions before native decoding and PNG dimensions before preview", async () => {
		await expect(prepareImageUpload(heicHeader(10_000, 10_000))).rejects.toThrow(
			"SOURCE_IMAGE_DIMENSIONS_TOO_LARGE",
		);
		const png = new Uint8Array(completePng);
		new DataView(png.buffer).setUint32(16, 10_000);
		new DataView(png.buffer).setUint32(20, 10_000);
		await expect(
			prepareImageUpload(new File([png], "huge.png", { type: "image/png" })),
		).rejects.toThrow("SOURCE_IMAGE_DIMENSIONS_TOO_LARGE");
		expect(decode).not.toHaveBeenCalled();
	});
	it.each(["image/jpeg", "image/webp", "image/heic"])(
		"checks %s byte limits before reading or decoding",
		async (type) => {
			const file = new File([new Uint8Array(10)], "large", { type });
			const read = vi.spyOn(file, "arrayBuffer");
			await expect(prepareImageUpload(file, 5)).rejects.toThrow("SOURCE_IMAGE_TOO_LARGE");
			expect(read).not.toHaveBeenCalled();
			expect(decode).not.toHaveBeenCalled();
		},
	);
});
