import { describe, expect, it } from "vitest";

import {
	constrainImageSpecMatrixToOutputFormat,
	resolveImageSpecControlValues,
	selectImageSkuForDimension,
} from "./image-sku-selection";

const matrix = {
	defaultSkuKey: "seedream-basic",
	dimensions: [
		{
			key: "resolution",
			label: "Resolution",
			options: [
				{ key: "1k", label: "1K" },
				{ key: "2k", label: "2K" },
			],
		},
		{
			key: "quality",
			label: "Quality",
			options: [
				{ key: "basic", label: "Basic" },
				{ key: "high", label: "High" },
			],
		},
	],
	cells: [
		{
			skuKey: "seedream-basic",
			label: "1K Basic",
			parameterValues: { resolution: "1k", quality: "basic" },
			credits: 8,
			aspectRatios: ["1:1"],
			controls: [],
		},
		{
			skuKey: "seedream-high",
			label: "2K High",
			parameterValues: { resolution: "2k", quality: "high" },
			credits: 15,
			aspectRatios: ["1:1"],
			controls: [],
		},
	],
} as const;

describe("image SKU selection", () => {
	it.each(["gif", "svg"] as const)(
		"keeps the dedicated %s tool within supported format and size cells",
		(outputFormat) => {
			const toolMatrix = {
				...matrix,
				defaultSkuKey: "gpt-image-2-6-flare-2k",
				cells: matrix.cells.map((cell, index) => ({
					...cell,
					skuKey: `gpt-image-2-6-flare-${index === 0 ? "1k" : "2k"}`,
					controls: [
						{
							key: "outputFormat" as const,
							label: "Format",
							defaultValue: "png",
							options: (index === 0 ? ["png", "jpeg", "svg", "gif"] : ["png", "jpeg"]).map(
								(key) => ({ key, label: key }),
							),
						},
					],
				})),
			};
			const constrained = constrainImageSpecMatrixToOutputFormat(toolMatrix, outputFormat);
			expect(constrained.defaultSkuKey).toBe("gpt-image-2-6-flare-1k");
			expect(constrained.cells).toHaveLength(1);
			expect(constrained.dimensions[0].options).toEqual([{ key: "1k", label: "1K" }]);
			expect(
				resolveImageSpecControlValues(constrained.cells[0], { outputFormat: "png" }).outputFormat,
			).toBe(outputFormat);
			expect(
				selectImageSkuForDimension(constrained, constrained.defaultSkuKey, "resolution", "2k"),
			).toBeNull();
			expect(constrainImageSpecMatrixToOutputFormat(matrix, outputFormat).cells).toEqual([]);
			expect(toolMatrix.cells).toHaveLength(2);
		},
	);
	it("keeps GIF timing while selected and removes it when switching to static output", () => {
		const cell = {
			...matrix.cells[0],
			skuKey: "gpt-image-2-6-flare-1k",
			controls: [
				{
					key: "outputFormat" as const,
					label: "Format",
					defaultValue: "png",
					options: ["png", "jpeg", "svg", "gif"].map((key) => ({ key, label: key })),
				},
				{
					key: "background" as const,
					label: "Background",
					defaultValue: "opaque",
					options: ["opaque", "transparent"].map((key) => ({ key, label: key })),
				},
			],
		};
		const gif = resolveImageSpecControlValues(cell, {
			outputFormat: "gif",
			frameCount: 16,
			frameDurationMs: 120,
			background: "transparent",
		});
		expect(gif).toEqual({
			outputFormat: "gif",
			background: "opaque",
			frameCount: 16,
			frameDurationMs: 120,
		});
		expect(resolveImageSpecControlValues(cell, { ...gif, outputFormat: "svg" })).toEqual({
			outputFormat: "svg",
			background: "opaque",
		});
		expect(resolveImageSpecControlValues(matrix.cells[0], gif)).toEqual({});
	});
	it("selects the exact legal cell when one exists", () => {
		expect(selectImageSkuForDimension(matrix, "seedream-basic", "resolution", "1k")?.skuKey).toBe(
			"seedream-basic",
		);
	});

	it("snaps coupled dimensions to another legal cell instead of inventing a cross-combination", () => {
		expect(selectImageSkuForDimension(matrix, "seedream-basic", "resolution", "2k")).toMatchObject({
			skuKey: "seedream-high",
			parameterValues: { resolution: "2k", quality: "high" },
			credits: 15,
		});
	});

	it("returns no selection for an option absent from that model's own matrix", () => {
		expect(selectImageSkuForDimension(matrix, "seedream-basic", "resolution", "4k")).toBeNull();
	});

	it("drops controls unsupported by the next SKU and applies only that cell's defaults", () => {
		const oneKilopixel = {
			skuKey: "gpt-image-2-1k",
			label: "1K",
			parameterValues: { resolution: "1k" },
			credits: 7,
			aspectRatios: ["1:1"],
			controls: [
				{
					key: "background" as const,
					label: "Background",
					defaultValue: "opaque",
					options: [
						{ key: "auto", label: "Automatic" },
						{ key: "opaque", label: "Opaque" },
						{ key: "transparent", label: "Transparent" },
					],
				},
			],
		};
		const twoKilopixel = {
			...oneKilopixel,
			skuKey: "gpt-image-2-2k",
			label: "2K",
			parameterValues: { resolution: "2k" },
			credits: 11,
			controls: [],
		};
		const nanoBananaTwo = {
			...oneKilopixel,
			skuKey: "nano-banana-2-1k",
			label: "Nano Banana 2 · 1K",
			credits: 9,
			controls: [
				{
					key: "outputFormat" as const,
					label: "Output format",
					defaultValue: "jpeg",
					options: [
						{ key: "png", label: "PNG" },
						{ key: "jpeg", label: "JPEG" },
					],
				},
			],
		};

		expect(
			resolveImageSpecControlValues(oneKilopixel, {
				background: "transparent",
				outputFormat: "png",
			}),
		).toEqual({ background: "transparent" });
		expect(
			resolveImageSpecControlValues(twoKilopixel, {
				background: "transparent",
			}),
		).toEqual({});
		expect(resolveImageSpecControlValues(nanoBananaTwo, {})).toEqual({
			outputFormat: "jpeg",
		});
		expect(nanoBananaTwo).toMatchObject({ skuKey: "nano-banana-2-1k", credits: 9 });
	});
});
