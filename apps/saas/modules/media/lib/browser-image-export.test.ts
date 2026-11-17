import { guestWatermarkGeometry } from "@repo/storage/image-processing/geometry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drawBrowserGuestWatermark, loadBrowserExportImage } from "./browser-image-export";

beforeEach(() => {
	vi.stubGlobal("window", { location: { origin: "https://app.test" } });
	vi.stubGlobal(
		"Image",
		class {
			src = "";
			naturalWidth = 1024;
			naturalHeight = 576;
			decode = async () => {};
		},
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("browser image export bytes", () => {
	it("decodes a bounded blob rather than drawing a private cross-origin URL", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }),
			);
		vi.stubGlobal("fetch", fetcher);
		const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:private-export");
		const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const loaded = await loadBrowserExportImage("https://signed.test/image");
		expect(fetcher).toHaveBeenCalledWith(
			"https://signed.test/image",
			expect.objectContaining({
				cache: "no-store",
				credentials: "omit",
				referrerPolicy: "no-referrer",
			}),
		);
		expect(createUrl).toHaveBeenCalledWith(expect.any(Blob));
		expect(loaded.image.src).toBe("blob:private-export");
		loaded.dispose();
		expect(revoke).toHaveBeenCalledWith("blob:private-export");
	});
	it.each(["text/html", "image/svg+xml", "image/gif"])(
		"rejects %s before creating a canvas image",
		async (mime) => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(new Response("bytes", { headers: { "content-type": mime } })),
			);
			const createUrl = vi.spyOn(URL, "createObjectURL");
			await expect(loadBrowserExportImage("/private-image")).rejects.toThrow("Image unavailable");
			expect(createUrl).not.toHaveBeenCalled();
		},
	);
	it("bounds the actual streamed bytes", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(new Uint8Array(25 * 1024 * 1024 + 1), {
					headers: { "content-type": "image/png" },
				}),
			),
		);
		await expect(loadBrowserExportImage("/private-image")).rejects.toThrow("Image too large");
	});
	it("rejects unsupported URL protocols before fetching", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		await expect(loadBrowserExportImage("data:image/png;base64,AA")).rejects.toThrow(
			"Invalid image URL",
		);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("redraws the existing guest plate geometry after crop or name layers", () => {
		const context = {
			save: vi.fn(),
			scale: vi.fn(),
			beginPath: vi.fn(),
			roundRect: vi.fn(),
			fill: vi.fn(),
			fillText: vi.fn(),
			restore: vi.fn(),
		};
		const geometry = guestWatermarkGeometry(1024, 576);
		drawBrowserGuestWatermark(context as unknown as CanvasRenderingContext2D, 1024, 576);
		expect(context.roundRect).toHaveBeenCalledWith(
			geometry.left,
			geometry.top,
			geometry.plateWidth,
			geometry.plateHeight,
			geometry.radius,
		);
		expect(context.fillText).toHaveBeenCalledWith(
			"EzImageAI",
			expect.any(Number),
			expect.any(Number),
			geometry.plateWidth * 0.9,
		);
	});
});
