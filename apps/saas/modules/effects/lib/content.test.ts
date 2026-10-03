import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { eightiesPhotoEffect } from "../../../content/effects/1980s-ai-photo";
import {
	createEffectContentReader,
	getEffectPreviewContent,
	getPublishedEffectById,
	getPublishedEffectBySlug,
	getPublishedEffects,
} from "./content";
import {
	effectPath,
	resolveEffectPreset,
	type Effect,
	type EffectAsset,
	type EffectPreset,
} from "./types";
import { isPublicEffectAssetPath, validateEffects } from "./validation";

// Synthetic unit fixtures exercise publication policy. They are never registered in public content.
function authorizedAsset(name: string): EffectAsset {
	return {
		src: `/images/effects/test-fixtures/${name}.webp`,
		alt: `Synthetic fixture ${name}`,
		width: 800,
		height: 1000,
		rights: {
			kind: "owned",
			holder: "Test fixture author",
			evidence: "__PRIVATE_EVIDENCE__: rights fixture",
			verifiedAt: "2026-09-28",
		},
	};
}

function publishedEffect(overrides: Partial<Effect> = {}): Effect {
	const parameters = { skuKey: "nano-banana-2-lite-1k", aspectRatio: "4:5" } as const;
	const version = eightiesPhotoEffect.presets[0].version;
	const preset: EffectPreset = {
		...eightiesPhotoEffect.presets[0],
		parameters,
		exampleIds: ["studio-test"],
		tests: [
			{
				exampleId: "studio-test",
				version,
				prompt: eightiesPhotoEffect.presets[0].prompt,
				productKey: "image-nano-banana-2-lite",
				parameters,
				testedAt: "2026-09-28",
				outcome: "passed",
				evidence: "__PRIVATE_EVIDENCE__: test fixture",
			},
		],
	};
	const output = authorizedAsset("output");
	return {
		...eightiesPhotoEffect,
		status: "published",
		presets: [preset],
		cover: output,
		examples: [
			{
				id: "studio-test",
				presetId: "studio-portrait",
				presetVersion: version,
				caption: "Synthetic policy fixture, not a product result.",
				input: authorizedAsset("input"),
				output,
				productKey: "image-nano-banana-2-lite",
				parameters,
				testedAt: "2026-09-28",
				provenance: {
					kind: "product-generation",
					evidence: "__PRIVATE_EVIDENCE__: generation fixture",
				},
			},
		],
		publishedAt: "2026-09-29",
		lastTestedAt: "2026-09-28",
		...overrides,
	};
}

describe("Effects publication boundary", () => {
	it("keeps an untested draft out of all public lookups", () => {
		const draft: Effect = {
			...eightiesPhotoEffect,
			status: "draft",
			cover: undefined,
			examples: [],
			lastTestedAt: undefined,
			presets: eightiesPhotoEffect.presets.map((preset) => ({
				...preset,
				exampleIds: [],
				tests: [],
			})),
		};
		const reader = createEffectContentReader([draft]);
		expect(validateEffects([draft])).toEqual([]);
		expect(reader.getPublishedEffects()).toEqual([]);
		expect(reader.getPublishedEffectById("1980s-ai-photo")).toBeNull();
		expect(reader.getPublishedEffectBySlug("1980s-ai-photo")).toBeNull();
		const preview = reader.getEffectPreviewContent("1980s-ai-photo");
		expect(preview?.status).toBe("draft");
		expect(preview?.presets).toHaveLength(3);
		expect(new Set(preview?.presets.map((preset) => preset.prompt)).size).toBe(3);
		expect(preview?.examples).toEqual([]);
		expect(preview?.lastTestedAt).toBeUndefined();
		expect(preview?.cover).toBeUndefined();
	});

	it("validates the actual 1980s record and publishes only its reviewed status", () => {
		const authored: Effect = eightiesPhotoEffect;
		expect(validateEffects([authored])).toEqual([]);
		const publicEffect = getPublishedEffectById(authored.id);
		expect(getPublishedEffectBySlug(authored.slug)).toEqual(publicEffect);
		if (authored.status === "published") {
			expect(publicEffect?.status).toBe("published");
			expect(getPublishedEffects()).toContainEqual(publicEffect);
			expect(publicEffect?.presets).toHaveLength(3);
		} else {
			expect(publicEffect).toBeNull();
			expect(getPublishedEffects().some((effect) => effect.id === authored.id)).toBe(false);
			expect(getEffectPreviewContent(authored.slug)?.status).toBe(authored.status);
		}
	});

	it("fails closed if a draft is marked published without real matching examples", () => {
		expect(() =>
			createEffectContentReader([{ ...eightiesPhotoEffect, status: "published", examples: [] }]),
		).toThrow("Every published preset needs an authorized input/output pair");
	});

	it("publishes tested content while stripping private evidence and draft relations", () => {
		const draft: Effect = {
			...eightiesPhotoEffect,
			status: "draft",
			id: "unreleased-style",
			slug: "unreleased-style",
		};
		const reader = createEffectContentReader([
			publishedEffect({ relatedEffectIds: [draft.id] }),
			draft,
		]);
		const effect = reader.getPublishedEffectById("1980s-ai-photo");
		expect(effect?.relatedEffectIds).toEqual([]);
		expect(effect?.cover.credit).toBe("Test fixture author");
		expect(effect?.presets[0]?.prompt).toBe(eightiesPhotoEffect.presets[0].prompt);
		const publicJson = JSON.stringify(effect);
		for (const excluded of [
			"__PRIVATE_EVIDENCE__",
			"primaryQuery",
			"queryCluster",
			"provenance",
			"verifiedAt",
			'"tests"',
			draft.id,
		]) {
			expect(publicJson).not.toContain(excluded);
		}
		expect(JSON.stringify(reader.getEffectPreviewContent(draft.slug))).not.toContain('"tests"');
	});

	it.each([
		["prompt", (preset: EffectPreset) => ({ ...preset, prompt: `${preset.prompt} New lighting.` })],
		["version", (preset: EffectPreset) => ({ ...preset, version: preset.version + 1 })],
		[
			"parameters",
			(preset: EffectPreset) => ({
				...preset,
				parameters: { ...preset.parameters, aspectRatio: "4:3" as const },
			}),
		],
		[
			"product",
			(preset: EffectPreset) => ({
				...preset,
				productKey: "image-gpt-image-2" as const,
				parameters: { skuKey: "gpt-image-2-1k" as const, aspectRatio: "4:5" as const },
			}),
		],
	])("rejects a stale example after the preset %s changes", (_label, change) => {
		const effect = publishedEffect();
		const preset = effect.presets[0]!;
		expect(() => createEffectContentReader([{ ...effect, presets: [change(preset)] }])).toThrow(
			"exact current",
		);
	});

	it("does not accept standalone illustrations as product generation provenance", () => {
		const effect = publishedEffect();
		const example = effect.examples[0]!;
		const issues = validateEffects([
			{
				...effect,
				examples: [{ ...example, provenance: { kind: "illustration", evidence: "mock" } }],
			},
		]);
		expect(issues.some((issue) => issue.path === "examples.0.provenance.kind")).toBe(true);
	});

	it("requires rights evidence, a passing test, and a truthful latest test date", () => {
		const effect = publishedEffect();
		const example = effect.examples[0]!;
		const missingRights = { ...example, input: { ...example.input, rights: undefined } };
		expect(validateEffects([{ ...effect, examples: [missingRights] }]).length).toBeGreaterThan(0);
		expect(() => createEffectContentReader([{ ...effect, lastTestedAt: "2026-09-29" }])).toThrow(
			"most recent",
		);
		const preset = effect.presets[0]!;
		expect(() =>
			createEffectContentReader([
				{
					...effect,
					presets: [
						{ ...preset, tests: preset.tests.map((test) => ({ ...test, outcome: "failed" })) },
					],
				},
			]),
		).toThrow("passing test");
	});
});

describe("Effects configuration and relationships", () => {
	it("adds a second effect through configuration and derives its directory and product links", () => {
		const first = publishedEffect({ featuredOrder: 2 });
		const second = publishedEffect({
			id: "watercolor-photo",
			slug: "watercolor-photo",
			title: "Watercolor Photo",
			primaryCategoryId: "artistic-styles",
			tags: ["illustration"],
			featuredOrder: 1,
			relatedEffectIds: [first.id],
		});
		const reader = createEffectContentReader([
			first,
			second,
			{
				...eightiesPhotoEffect,
				status: "draft",
				id: "draft-style",
				slug: "draft-style",
				featuredOrder: 0,
			},
		]);
		expect(reader.getPublishedEffects().map((effect) => effect.id)).toEqual([first.id, second.id]);
		expect(effectPath(reader.getPublishedEffectBySlug(second.slug)!)).toBe(
			"/blog/watercolor-photo",
		);
	});

	it.each([
		["duplicate ID", [publishedEffect(), publishedEffect({ slug: "another-url" })]],
		["duplicate slug", [publishedEffect(), publishedEffect({ id: "another-id" })]],
		["reserved category slug", [publishedEffect({ slug: "category" })]],
		["missing default", [publishedEffect({ defaultPresetId: "missing-preset" })]],
		["unknown relation", [publishedEffect({ relatedEffectIds: ["unknown-effect"] })]],
		["self relation", [publishedEffect({ relatedEffectIds: ["1980s-ai-photo"] })]],
		["unsubstantiated trend", [publishedEffect({ trendStage: "trending" })]],
	])("rejects %s", (_label, records) => {
		expect(() => createEffectContentReader(records)).toThrow("Invalid Effects content");
	});

	it("rejects cross-product SKUs and unsupported controls without polling live services", () => {
		const draft: Effect = eightiesPhotoEffect;
		const preset = draft.presets[0]!;
		expect(() =>
			createEffectContentReader([
				{
					...draft,
					presets: [{ ...preset, parameters: { ...preset.parameters, skuKey: "gpt-image-2-1k" } }],
				},
			]),
		).toThrow("SKU must belong");
		expect(() =>
			createEffectContentReader([
				{
					...draft,
					presets: [{ ...preset, parameters: { ...preset.parameters, outputFormat: "jpeg" } }],
				},
			]),
		).toThrow("outputFormat value");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Provider outage"));
		try {
			expect(createEffectContentReader([publishedEffect()]).getPublishedEffects()).toHaveLength(1);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("returns unknown IDs as missing and invalid preset query values to the safe default", () => {
		const effect = publishedEffect();
		const reader = createEffectContentReader([effect]);
		expect(reader.getPublishedEffectById("unknown")).toBeNull();
		expect(reader.getPublishedEffectBySlug("unknown")).toBeNull();
		expect(reader.getEffectPreviewContent("unknown")).toBeNull();
		expect(resolveEffectPreset(effect, "../../private-model").id).toBe(effect.defaultPresetId);
		expect(effectPath(effect, "unknown", "https://untrusted.example/?prompt=private")).toBe(
			"/blog/1980s-ai-photo",
		);
		expect(effectPath(effect, "studio-portrait", "ai-image-editing-prompts")).toBe(
			"/blog/1980s-ai-photo?preset=studio-portrait&source=ai-image-editing-prompts",
		);
	});
});

describe("Effects retirement and asset boundaries", () => {
	it("keeps cooling effects public after removing their featured position", () => {
		const reader = createEffectContentReader([
			publishedEffect({
				trendStage: "cooling",
				trendReviewedAt: "2026-09-29",
				trendEvidence: "Recorded editorial review",
				featuredOrder: undefined,
			}),
		]);
		expect(reader.getPublishedEffectBySlug("1980s-ai-photo")).not.toBeNull();
		expect(reader.getRetiredEffectBySlug("1980s-ai-photo")).toBeNull();
	});

	it("returns an explicit gone record or a validated published replacement", () => {
		const retired: Effect = {
			...eightiesPhotoEffect,
			status: "retired",
			retirement: { reason: "The effect has been explicitly withdrawn.", retiredAt: "2026-09-29" },
		};
		const reader = createEffectContentReader([retired]);
		expect(reader.getPublishedEffects()).toEqual([]);
		expect(reader.getEffectPreviewContent(retired.slug)).toBeNull();
		expect(reader.getRetiredEffectBySlug(retired.slug)?.redirectTo).toBeUndefined();
		const replacement = publishedEffect({ id: "equivalent-photo", slug: "equivalent-photo" });
		const redirected = createEffectContentReader([
			{ ...retired, retirement: { ...retired.retirement!, replacementEffectId: replacement.id } },
			replacement,
		]);
		expect(redirected.getRetiredEffectBySlug(retired.slug)?.redirectTo).toBe(
			"/blog/equivalent-photo",
		);
		expect(() =>
			createEffectContentReader([
				{ ...retired, retirement: { ...retired.retirement!, replacementEffectId: "unknown" } },
			]),
		).toThrow("different published effect");
	});

	it.each([
		"https://competitor.example/result.jpg",
		"https://storage.example/image.jpg?signature=secret",
		"/images/effects/../private.jpg",
		"/images/effects/%2e%2e/private.jpg",
		"/images/effects/result.webp?token=secret",
		"/images/effects//result.webp",
		"data:image/png;base64,private",
	])("rejects external, private, or noncanonical asset path %s", (path) => {
		expect(isPublicEffectAssetPath(path)).toBe(false);
	});
});
