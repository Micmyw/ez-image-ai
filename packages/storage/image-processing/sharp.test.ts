import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { createSharpImageProcessor } from "./sharp";

const processor = createSharpImageProcessor();

describe("Sharp image processor", () => {
	it.each(["jpeg", "png", "webp"] as const)(
		"preserves %s dimensions and adds a visible lower-right plate",
		async (format) => {
			const source = await sharp({
				create: { width: 640, height: 400, channels: 3, background: "#dbeafe" },
			})
				.toFormat(format)
				.toBuffer();
			const contentType = `image/${format}` as const;
			await expect(processor.inspect(new Blob([source]).stream(), contentType)).resolves.toEqual({
				width: 640,
				height: 400,
			});
			const result = await processor.watermark(new Blob([source]).stream(), {
				width: 640,
				height: 400,
				contentType,
			});
			const bytes = Buffer.from(await new Response(result).arrayBuffer());
			expect(await sharp(bytes).metadata()).toMatchObject({ format, width: 640, height: 400 });
			const background = await sharp(bytes)
				.extract({ left: 10, top: 10, width: 1, height: 1 })
				.raw()
				.toBuffer();
			const plate = await sharp(bytes)
				.extract({ left: 486, top: 375, width: 1, height: 1 })
				.raw()
				.toBuffer();
			expect(background[0]).toBeGreaterThan(200);
			expect(plate[0]).toBeLessThan(120);
			const text = await sharp(bytes)
				.extract({ left: 530, top: 355, width: 70, height: 25 })
				.raw()
				.toBuffer();
			expect([...text].some((channel) => channel >= 245)).toBe(true);
		},
	);

	it("propagates a source stream failure", async () => {
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error("source failed"));
			},
		});
		await expect(processor.inspect(source, "image/png")).rejects.toThrow("source failed");
	});

	it("rejects a format that differs from the private object metadata", async () => {
		const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "red" } })
			.png()
			.toBuffer();
		await expect(processor.inspect(new Blob([png]).stream(), "image/jpeg")).rejects.toMatchObject({
			code: "OUTPUT_MEDIA_TYPE_MISMATCH",
		});
	});
});
