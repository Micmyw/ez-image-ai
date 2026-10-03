import { describe, expect, it } from "vitest";

import type { GenerationFormValues } from "../../media/lib/form-schema";
import {
	applyEffectPresetToValues,
	hasEffectPresetChanges,
	effectWorkspacePath,
	isEffectSelectionAvailable,
	needsEffectPresetConfirmation,
	sanitizeEffectEditorReturnPath,
} from "./editor-selection";
import type { PublicEffectPreset } from "./types";

const preset: PublicEffectPreset = {
	id: "studio-portrait",
	version: 1,
	name: "Studio portrait",
	prompt: "Keep the face and create a 1980s studio portrait.",
	inputRequirement: "required",
	inputHint: "One clear portrait",
	productKey: "image-nano-banana-2-lite",
	parameters: { skuKey: "nano-banana-2-lite-1k", aspectRatio: "4:5" },
	exampleIds: [],
};
const current: GenerationFormValues = {
	productKey: "image-gpt-image-2",
	skuKey: "gpt-image-2-4k",
	prompt: "My custom portrait prompt",
	sourceAssetId: "private-owned-asset",
	aspectRatio: "16:9",
	outputFormat: "png",
	background: "transparent",
};

describe("effect editor selection", () => {
	it("replaces only preset controls, retains the owned reference and drops the old model's controls", () => {
		expect(applyEffectPresetToValues(current, preset)).toEqual({
			productKey: preset.productKey,
			prompt: preset.prompt,
			sourceAssetId: current.sourceAssetId,
			...preset.parameters,
		});
		expect(current.prompt).toBe("My custom portrait prompt");
	});
	it("protects changed prompt text while allowing an untouched or empty prompt", () => {
		expect(needsEffectPresetConfirmation(current.prompt, preset)).toBe(true);
		expect(needsEffectPresetConfirmation(preset.prompt, preset)).toBe(false);
		expect(needsEffectPresetConfirmation("", preset)).toBe(false);
	});
	it("requires the exact model, SKU and ratio without falling back to an available alternative", () => {
		const values = applyEffectPresetToValues(current, preset);
		const products = [
			{
				key: preset.productKey,
				skuMatrix: {
					defaultSkuKey: preset.parameters.skuKey,
					dimensions: [],
					cells: [
						{
							skuKey: preset.parameters.skuKey,
							label: "1K",
							parameterValues: {},
							credits: 4,
							aspectRatios: ["4:5"],
							controls: [],
						},
					],
				},
			},
		];
		expect(isEffectSelectionAvailable(values, products)).toBe(true);
		expect(isEffectSelectionAvailable(values, [{ ...products[0], key: "image-gpt-image-2" }])).toBe(
			false,
		);
		expect(isEffectSelectionAvailable({ ...values, aspectRatio: "16:9" }, products)).toBe(false);
		expect(isEffectSelectionAvailable({ ...values, background: "transparent" }, products)).toBe(
			false,
		);
	});
	it("also protects model and output edits when the prompt is unchanged", () => {
		const unchanged = applyEffectPresetToValues(current, preset);
		expect(hasEffectPresetChanges(unchanged, preset)).toBe(false);
		expect(hasEffectPresetChanges({ ...unchanged, aspectRatio: "16:9" }, preset)).toBe(true);
		expect(hasEffectPresetChanges({ ...unchanged, outputFormat: "png" }, preset)).toBe(true);
	});
	it("scopes restored registered drafts to the same effect and selected preset", () => {
		expect(effectWorkspacePath("/effects/1980s-ai-photo", "studio-portrait")).not.toBe(
			effectWorkspacePath("/effects/1980s-ai-photo", "family-snapshot"),
		);
	});
	it.each([
		"/blog/1980s-ai-photo?preset=studio-portrait",
		"/blog/1980s-ai-photo?preset=studio-portrait&resume=text",
		"/effects/1980s-ai-photo?preset=studio-portrait",
		"/effects/1980s-ai-photo?preset=studio-portrait&upgrade=complete",
		"/effects/1980s-ai-photo?preset=studio-portrait&resume=text",
	])("accepts a bounded effect recovery path %s", (path) =>
		expect(sanitizeEffectEditorReturnPath(path)).toBe(path.replace("/effects/", "/blog/")),
	);
	it.each([
		"/blog/private-image-editing-workflow?preset=studio-portrait",
		"/blog/unregistered?preset=studio-portrait",
		"/blog/1980s-ai-photo?preset=studio-portrait&private=secret",
		"/blog/1980s-ai-photo?preset=studio-portrait#private",
		"//evil.test/effects/test?preset=studio-portrait",
		"/effects/category?preset=studio-portrait",
		"/effects/1980s-ai-photo?preset=studio-portrait&prompt=private",
		"/effects/1980s-ai-photo?preset=studio-portrait&asset=private",
		"/effects/1980s-ai-photo?preset=studio-portrait&preset=family-snapshot",
		"/effects/1980s-ai-photo?preset=studio-portrait#secret",
		"/effects/1980s-ai-photo?preset=studio-portrait&upgrade=complete&resume=text",
		"/effects/1980s-ai-photo",
	])("rejects unsafe or ambiguous effect recovery state %s", (path) =>
		expect(sanitizeEffectEditorReturnPath(path)).toBeNull(),
	);
});
