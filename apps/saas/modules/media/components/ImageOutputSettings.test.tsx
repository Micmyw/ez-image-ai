import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/ui/components/popover", () => ({
	Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	PopoverTrigger: ({ render }: { render: React.ReactNode }) => render,
}));

import { ImageOutputSettings } from "./ImageOutputSettings";

describe("ImageOutputSettings", () => {
	it("renders the selected model's rectangular matrix with browser-owned labels", () => {
		const markup = renderToStaticMarkup(
			<ImageOutputSettings
				idPrefix="test"
				aspectRatios={["1:1", "9:16"]}
				value="1:1"
				onChange={vi.fn()}
				modeLabel="Seedream 5 Pro"
				skuMatrix={{
					defaultSkuKey: "seedream-5-pro-basic-1k",
					dimensions: [
						{
							key: "resolution",
							label: "Catalog resolution",
							options: [
								{ key: "1k", label: "Catalog 1K" },
								{ key: "2k", label: "Catalog 2K" },
							],
						},
						{
							key: "quality",
							label: "Catalog quality",
							options: [
								{ key: "basic", label: "Catalog Basic" },
								{ key: "high", label: "Catalog High" },
							],
						},
					],
					cells: [
						{
							skuKey: "seedream-5-pro-basic-1k",
							label: "1K · Basic",
							parameterValues: { resolution: "1k", quality: "basic" },
							credits: 8,
							aspectRatios: ["1:1", "9:16"],
							controls: [],
						},
						{
							skuKey: "seedream-5-pro-high-2k",
							label: "2K · High",
							parameterValues: { resolution: "2k", quality: "high" },
							credits: 15,
							aspectRatios: ["1:1", "9:16"],
							controls: [],
						},
					],
				}}
				skuKey="seedream-5-pro-basic-1k"
				onSkuChange={vi.fn()}
				labels={{
					title: "Localized output settings",
					trigger: "Localized trigger",
					aspectRatio: "Localized aspect ratio",
					automatic: "Localized automatic",
					outputNumber: "Localized output number",
					oneOutput: "Localized one output",
					resolution: "Localized resolution",
					quality: "Localized quality",
					outputFormat: "Localized output format",
					background: "Localized background",
					modeControlsQuality: "Localized model setting hint",
					credits: "EzPic Credits",
					optionLabels: {
						"1k": "Localized 1K",
						"2k": "Localized 2K",
						basic: "Localized Basic",
						high: "Localized High",
					},
				}}
			/>,
		);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		for (const label of [
			"Localized resolution",
			"Localized quality",
			"Localized 1K",
			"Localized 2K",
			"Localized Basic",
			"Localized High",
		]) {
			expect(visibleText).toContain(label);
		}
		expect(visibleText).toContain("1K · Basic · 8 EzPic Credits");
		expect(visibleText).not.toContain("Catalog");
	});

	it("renders only the selected cell's non-billing controls without changing its credits", () => {
		const markup = renderToStaticMarkup(
			<ImageOutputSettings
				idPrefix="gpt"
				aspectRatios={["1:1"]}
				value="1:1"
				onChange={vi.fn()}
				modeLabel="GPT Image 2"
				skuMatrix={{
					defaultSkuKey: "gpt-image-2-1k",
					dimensions: [
						{
							key: "resolution",
							label: "Resolution",
							options: [
								{ key: "1k", label: "1K" },
								{ key: "2k", label: "2K" },
							],
						},
					],
					cells: [
						{
							skuKey: "gpt-image-2-1k",
							label: "1K",
							parameterValues: { resolution: "1k" },
							credits: 7,
							aspectRatios: ["1:1"],
							controls: [
								{
									key: "background",
									label: "Catalog background",
									defaultValue: "opaque",
									options: [
										{ key: "auto", label: "Catalog automatic" },
										{ key: "opaque", label: "Catalog opaque" },
										{ key: "transparent", label: "Catalog transparent" },
									],
								},
							],
						},
						{
							skuKey: "gpt-image-2-2k",
							label: "2K",
							parameterValues: { resolution: "2k" },
							credits: 11,
							aspectRatios: ["1:1"],
							controls: [],
						},
					],
				}}
				skuKey="gpt-image-2-1k"
				onSkuChange={vi.fn()}
				controlValues={{ background: "transparent" }}
				onControlChange={vi.fn()}
				labels={{
					title: "Output settings",
					trigger: "Open output settings",
					aspectRatio: "Aspect ratio",
					automatic: "Automatic",
					outputNumber: "Output number",
					oneOutput: "One image",
					resolution: "Resolution",
					quality: "Quality",
					outputFormat: "Localized output format",
					background: "Localized background",
					modeControlsQuality: "Model-specific",
					credits: "EzPic Credits",
					optionLabels: {
						"1k": "1K",
						"2k": "2K",
						auto: "Localized automatic",
						opaque: "Localized opaque",
						transparent: "Localized transparent",
					},
				}}
			/>,
		);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(visibleText).toContain("Localized background");
		expect(visibleText).toContain("Localized transparent");
		expect(visibleText).toContain("1K · 7 EzPic Credits");
		expect(visibleText).not.toContain("Localized output format");
		expect(visibleText).not.toContain("Catalog background");
	});
});
