import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { gifReviewPng, inspectGeneratedGif } from "./generated-gif";
import { svgReviewPng } from "./generated-image-review";
import { validateStaticSvg } from "./static-svg";

const svg = (body: string, attributes = "") =>
	Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" ${attributes}>${body}</svg>`,
	);

async function twoFrameGif() {
	return sharp(Buffer.from([255, 0, 0, 0, 0, 255]), {
		raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
	})
		.gif({ loop: 0, delay: [200, 200] })
		.toBuffer();
}

describe("generated vector and animation review", () => {
	it("renders the whole static vector within the moderation bounds", async () => {
		const bytes = svg('<rect width="400" height="200" fill="#ff0000"/>');
		expect(validateStaticSvg(bytes)).toMatchObject({ width: 400, height: 200 });
		const output = await svgReviewPng(bytes);
		const rendered = await sharp(output).raw().toBuffer({ resolveWithObject: true });
		expect(rendered.info).toMatchObject({ width: 1568, height: 784 });
		expect([...rendered.data.subarray(0, 3)]).toEqual([255, 0, 0]);
	});
	it.each([
		"<script>alert(1)</script>",
		'<image href="https://attacker.test/image.png"/>',
		"<foreignObject><div>unreviewed</div></foreignObject>",
		'<animate attributeName="opacity" values="0;1"/>',
		'<style>@import "https://attacker.test/css";</style>',
		'<rect style="fill: url(https://attacker.test/fill)"/>',
		'<rect fill="url(&#x68;ttps://attacker.test/fill)"/>',
		'<rect onload="alert(1)"/>',
		'<g xmlns="https://attacker.test"><rect/></g>',
		"<g>".repeat(65) + "</g>".repeat(65),
		"<text>不能隐藏未审核文字</text>",
		'<text font-family="Wingdings">ABC</text>',
		"<text>Plain ASCII</text>",
		"<tspan>Fallback</tspan>",
	])("rejects active, external, or unbounded SVG content: %s", (body) => {
		expect(() => validateStaticSvg(svg(body))).toThrow("static, self-contained");
	});
	it("retains accessibility metadata and outlined lettering without font dependencies", () => {
		expect(() =>
			validateStaticSvg(
				svg('<title>标题</title><desc>Vector letters</desc><path d="M0 10 L5 0 L10 10 Z"/>'),
			),
		).not.toThrow();
	});
	it("rejects XML declarations with entities and processing instructions", () => {
		expect(() =>
			validateStaticSvg(
				Buffer.from(
					`<!DOCTYPE svg [<!ENTITY x "evil">]>${svg("<text>&x;</text>").toString("utf8")}`,
				),
			),
		).toThrow();
		expect(() =>
			validateStaticSvg(
				Buffer.from(
					`<?xml-stylesheet href="https://attacker.test/style"?>${svg("").toString("utf8")}`,
				),
			),
		).toThrow();
	});
	it("retains same-document gradients without permitting external URL forms", () => {
		expect(() =>
			validateStaticSvg(
				svg(
					'<defs><linearGradient id="paint"><stop offset="0" stop-color="red"/></linearGradient></defs><rect fill="url(#paint)"/>',
				),
			),
		).not.toThrow();
	});
	it("includes a distinct later GIF frame in the review instead of only its first frame", async () => {
		const bytes = await twoFrameGif();
		expect(inspectGeneratedGif(bytes)).toEqual({ width: 1, height: 1, frames: 2 });
		const output = await sharp(gifReviewPng(bytes)).raw().toBuffer({ resolveWithObject: true });
		expect(output.info).toMatchObject({ width: 1568, height: 1568, channels: 4 });
		const pixel = (x: number, y: number) => [
			...output.data.subarray((y * 1568 + x) * 4, (y * 1568 + x) * 4 + 3),
		];
		expect(pixel(392, 784)).toEqual([255, 0, 0]);
		expect(pixel(1176, 784)).toEqual([0, 0, 255]);
	});
	it("rejects oversized, truncated, single-frame and trailing-payload animations before decoding", async () => {
		const bytes = await twoFrameGif();
		const oversized = Buffer.from(bytes);
		oversized.writeUInt16LE(2000, 6);
		for (const malformed of [
			oversized,
			bytes.subarray(0, -1),
			Buffer.concat([bytes, Buffer.from("<script>")]),
		])
			expect(() => inspectGeneratedGif(malformed)).toThrow();
		const still = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
			.gif()
			.toBuffer();
		expect(() => inspectGeneratedGif(still)).toThrow();
	});
	it("preserves a nonwhite logical background when disposal 2 clears the previous rectangle", async () => {
		const frame = (left: number, paletteIndex: number, disposal: number) =>
			Buffer.from([
				0x21,
				0xf9,
				4,
				disposal << 2,
				20,
				0,
				0,
				0,
				0x2c,
				left,
				0,
				0,
				0,
				1,
				0,
				1,
				0,
				0,
				2,
				2,
				4 + (paletteIndex << 3) + 64,
				1,
				0,
			]);
		const animation = Buffer.concat([
			Buffer.from("GIF89a"),
			Buffer.from([2, 0, 1, 0, 0x81, 0, 0]),
			Buffer.from([0, 0, 255, 255, 0, 0, 0, 255, 0, 255, 255, 255]),
			Buffer.from([
				0x21, 0xf9, 4, 8, 20, 0, 0, 0, 0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2, 2, 0x4c, 0x0a, 0,
			]),
			frame(1, 2, 1),
			Buffer.from([0x3b]),
		]);
		const actual = await sharp(animation, { animated: true }).ensureAlpha().raw().toBuffer();
		expect([...actual]).toEqual([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255]);
		const sheet = await sharp(gifReviewPng(animation)).raw().toBuffer();
		for (const [x, color] of [
			[196, [255, 0, 0]],
			[588, [255, 0, 0]],
			[980, [0, 0, 255]],
			[1372, [0, 255, 0]],
		] as const) {
			const offset = (784 * 1568 + x) * 4;
			expect([...sheet.subarray(offset, offset + 3)]).toEqual(color);
		}
	});
	it("restores the previous canvas for disposal 3 and leaves transparent patch pixels unchanged", async () => {
		const frame = (left: number, paletteIndex: number, disposal: number, transparent = false) =>
			Buffer.from([
				0x21,
				0xf9,
				4,
				(disposal << 2) | Number(transparent),
				20,
				0,
				0,
				0,
				0x2c,
				left,
				0,
				0,
				0,
				1,
				0,
				1,
				0,
				0,
				2,
				2,
				4 + (paletteIndex << 3) + 64,
				1,
				0,
			]);
		const animation = Buffer.concat([
			Buffer.from("GIF89a"),
			Buffer.from([2, 0, 1, 0, 0x81, 0, 0]),
			Buffer.from([0, 0, 255, 255, 0, 0, 0, 255, 0, 255, 255, 255]),
			Buffer.from([
				0x21, 0xf9, 4, 4, 20, 0, 0, 0, 0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2, 2, 0x4c, 0x0a, 0,
			]),
			frame(0, 2, 3),
			frame(1, 0, 1, true),
			frame(1, 0, 1),
			Buffer.from([0x3b]),
		]);
		const actual = await sharp(animation, { animated: true }).ensureAlpha().raw().toBuffer();
		const expected = [
			[255, 0, 0],
			[255, 0, 0],
			[0, 255, 0],
			[255, 0, 0],
			[255, 0, 0],
			[255, 0, 0],
			[255, 0, 0],
			[0, 0, 255],
		];
		expect([...actual]).toEqual(expected.flatMap((rgb) => [...rgb, 255]));
		const sheet = await sharp(gifReviewPng(animation)).raw().toBuffer();
		for (let index = 0; index < 8; index++) {
			const x = (Math.floor(index / 2) % 2) * 784 + (index % 2 ? 588 : 196);
			const y = Math.floor(index / 4) * 784 + 392;
			const offset = (y * 1568 + x) * 4;
			expect([...sheet.subarray(offset, offset + 3)]).toEqual(expected[index]);
		}
	});
	it("rejects malformed graphics control blocks before decoder allocation", async () => {
		const bytes = await twoFrameGif();
		const control = bytes.indexOf(Buffer.from([0x21, 0xf9, 4]));
		expect(control).toBeGreaterThan(0);
		for (const [offset, value] of [
			[2, 5],
			[3, 28],
			[7, 1],
		]) {
			const malformed = Buffer.from(bytes);
			malformed[control + offset!] = value!;
			expect(() => inspectGeneratedGif(malformed)).toThrow();
		}
	});
});
