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
	encode = vi.fn((callback: (blob: Blob) => void) =>
		callback(new Blob([new Uint8Array(completePng)], { type: "image/png" })),
	);
	vi.stubGlobal(
		"Image",
		class {
			naturalWidth = 64;
			naturalHeight = 64;
			decode = decode;
		},
	);
	vi.stubGlobal("document", {
		createElement: () => ({
			width: 0,
			height: 0,
			getContext: () => ({ drawImage: vi.fn() }),
			toBlob: encode,
		}),
	});
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:source");
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
	});
});
