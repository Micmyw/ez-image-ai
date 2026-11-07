import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prepareTemplatePhoto, TEMPLATE_PHOTO_SOURCE_LIMIT } from "./prepare-template-photo";

const decode = vi.fn();
const draw = vi.fn();
const encode = vi.fn();
const revoke = vi.fn();
let canvas: { width: number; height: number; getContext: () => unknown; toBlob: typeof encode };
beforeEach(() => {
	decode.mockResolvedValue(undefined);
	encode.mockImplementation((done: (blob: Blob) => void) =>
		done(new Blob([new Uint8Array(80)], { type: "image/webp" })),
	);
	vi.stubGlobal(
		"Image",
		class {
			naturalWidth = 6000;
			naturalHeight = 4000;
			decode = decode;
		},
	);
	canvas = { width: 0, height: 0, getContext: () => ({ drawImage: draw }), toBlob: encode };
	vi.stubGlobal("document", { createElement: () => canvas });
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:prepared-photo");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.resetAllMocks();
});

const photo = (bytes = 200, type = "image/png") =>
	new File([new Uint8Array(bytes)], "portrait.png", { type, lastModified: 123 });

describe("template photo upload preparation", () => {
	it.each(["image/jpeg", "image/png", "image/webp"])(
		"keeps acceptable %s bytes and identity unchanged",
		async (type) => {
			const original = photo(100, type);
			expect(await prepareTemplatePhoto(original, 100)).toBe(original);
			expect(decode).not.toHaveBeenCalled();
		},
	);
	it("compresses an oversized photo to the server limit without cropping, before upload", async () => {
		const prepared = await prepareTemplatePhoto(photo(), 100);
		expect(prepared.size).toBe(80);
		expect(prepared.type).toBe("image/webp");
		expect(prepared.name).toBe("portrait.webp");
		expect(prepared.lastModified).toBe(123);
		expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 0, 2560, 1707);
		expect(encode).toHaveBeenCalledWith(expect.any(Function), "image/webp", 0.9);
		expect(revoke).toHaveBeenCalledWith("blob:prepared-photo");
		expect(canvas.width).toBe(0);
		expect(canvas.height).toBe(0);
	});
	it("reduces quality when the first encoding is too large", async () => {
		encode.mockImplementationOnce((done: (blob: Blob) => void) =>
			done(new Blob([new Uint8Array(150)], { type: "image/webp" })),
		);
		expect((await prepareTemplatePhoto(photo(), 100)).size).toBe(80);
		expect(encode).toHaveBeenLastCalledWith(expect.any(Function), "image/webp", 0.8);
	});
	it("rejects unsupported, empty and excessive source files before decoding", async () => {
		await expect(prepareTemplatePhoto(photo(1, "image/gif"), 100)).rejects.toThrow(
			"PHOTO_FORMAT_UNSUPPORTED",
		);
		await expect(prepareTemplatePhoto(photo(0), 100)).rejects.toThrow("PHOTO_FORMAT_UNSUPPORTED");
		const excessive = photo();
		Object.defineProperty(excessive, "size", { value: TEMPLATE_PHOTO_SOURCE_LIMIT + 1 });
		await expect(prepareTemplatePhoto(excessive, 100)).rejects.toThrow("PHOTO_SOURCE_TOO_LARGE");
		expect(decode).not.toHaveBeenCalled();
	});
	it("fails closed and releases local resources when decoding or encoding fails", async () => {
		decode.mockRejectedValueOnce(new Error("bad image"));
		await expect(prepareTemplatePhoto(photo(), 100)).rejects.toThrow("PHOTO_PREPARATION_FAILED");
		expect(encode).not.toHaveBeenCalled();
		encode.mockImplementationOnce((done: (blob: null) => void) => done(null));
		await expect(prepareTemplatePhoto(photo(), 100)).rejects.toThrow("PHOTO_PREPARATION_FAILED");
		expect(revoke).toHaveBeenCalledTimes(2);
		expect(canvas.width).toBe(0);
	});
	it("bounds retries when no encoding fits the server limit", async () => {
		encode.mockImplementation((done: (blob: Blob) => void) =>
			done(new Blob([new Uint8Array(150)], { type: "image/webp" })),
		);
		await expect(prepareTemplatePhoto(photo(), 100)).rejects.toThrow("PHOTO_PREPARATION_FAILED");
		expect(encode).toHaveBeenCalledTimes(9);
		expect(canvas.width).toBe(0);
	});
});
