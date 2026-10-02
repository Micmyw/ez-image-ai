import {
	EZPIC_PRODUCT_KEYS,
	getImageProductSelectionContract,
	IMAGE_ASPECT_RATIOS,
	IMAGE_BACKGROUNDS,
	IMAGE_OUTPUT_FORMATS,
	IMAGE_SKU_KEYS,
} from "@repo/config/client";
import { z } from "zod";

import {
	EFFECT_CATEGORIES,
	EFFECT_TAGS,
	type Effect,
	type EffectCategoryId,
	type EffectExample,
	type EffectParameters,
	type EffectPreset,
} from "./types";

const idSchema = z
	.string()
	.min(1)
	.max(96)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const textSchema = z.string().refine((value) => value.trim().length > 0, "Text must not be blank.");
const dateSchema = z.string().refine((value) => {
	if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/.test(value)) return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value.slice(0, 10);
}, "Use a real ISO date or UTC timestamp.");

export const effectParametersSchema = z.strictObject({
	skuKey: z.enum(IMAGE_SKU_KEYS),
	aspectRatio: z.enum(IMAGE_ASPECT_RATIOS),
	outputFormat: z.enum(IMAGE_OUTPUT_FORMATS).optional(),
	background: z.enum(IMAGE_BACKGROUNDS).optional(),
});

const assetSchema = z.strictObject({
	src: z
		.string()
		.refine(isPublicEffectAssetPath, "Use a local public /images/effects/ asset path."),
	alt: textSchema,
	width: z.number().int().positive().max(16384),
	height: z.number().int().positive().max(16384),
	rights: z.strictObject({
		kind: z.enum(["owned", "licensed"]),
		holder: textSchema,
		evidence: textSchema,
		verifiedAt: dateSchema,
	}),
});

const testSchema = z.strictObject({
	exampleId: idSchema,
	version: z.number().int().positive(),
	prompt: textSchema.max(10000),
	productKey: z.enum(EZPIC_PRODUCT_KEYS),
	parameters: effectParametersSchema,
	testedAt: dateSchema,
	outcome: z.enum(["passed", "failed"]),
	evidence: textSchema,
});

const presetSchema = z.strictObject({
	id: idSchema,
	version: z.number().int().positive(),
	name: textSchema,
	prompt: textSchema.max(10000),
	inputRequirement: z.enum(["required", "optional"]),
	inputHint: textSchema,
	productKey: z.enum(EZPIC_PRODUCT_KEYS),
	parameters: effectParametersSchema,
	exampleIds: z.array(idSchema),
	tests: z.array(testSchema),
});

const exampleSchema = z.strictObject({
	id: idSchema,
	presetId: idSchema,
	presetVersion: z.number().int().positive(),
	caption: textSchema,
	input: assetSchema,
	output: assetSchema,
	productKey: z.enum(EZPIC_PRODUCT_KEYS),
	parameters: effectParametersSchema,
	testedAt: dateSchema,
	provenance: z.strictObject({
		kind: z.literal("product-generation"),
		evidence: textSchema,
	}),
});

export const effectSchema = z.strictObject({
	id: idSchema,
	slug: idSchema.refine(
		(value) => !["category", "page", "preview"].includes(value),
		"Reserved slug.",
	),
	title: textSchema,
	summary: textSchema,
	seoTitle: textSchema,
	seoDescription: textSchema,
	primaryQuery: textSchema,
	queryCluster: z.array(textSchema),
	primaryCategoryId: z.enum(
		EFFECT_CATEGORIES.map((category) => category.id) as [EffectCategoryId, ...EffectCategoryId[]],
	),
	tags: z.array(z.enum(EFFECT_TAGS)),
	status: z.enum(["draft", "published", "retired"]),
	trendStage: z.enum(["none", "rising", "trending", "cooling", "evergreen"]),
	trendReviewedAt: dateSchema.optional(),
	trendEvidence: textSchema.optional(),
	featuredOrder: z.number().int().nonnegative().optional(),
	cover: assetSchema.optional(),
	examples: z.array(exampleSchema),
	defaultPresetId: idSchema,
	presets: z.array(presetSchema).min(1),
	instructions: z.array(z.strictObject({ title: textSchema, body: textSchema })).min(1),
	limitations: z.array(textSchema).min(1),
	faq: z.array(z.strictObject({ question: textSchema, answer: textSchema })),
	relatedEffectIds: z.array(idSchema),
	publishedAt: dateSchema.optional(),
	updatedAt: dateSchema,
	lastTestedAt: dateSchema.optional(),
	retirement: z
		.strictObject({
			reason: textSchema,
			retiredAt: dateSchema,
			replacementEffectId: idSchema.optional(),
		})
		.optional(),
});

export interface EffectValidationIssue {
	effectId: string;
	path: string;
	message: string;
}

/** This is a static content check. It never polls provider availability or reads credentials. */
export function validateEffects(records: readonly unknown[]): EffectValidationIssue[] {
	const issues: EffectValidationIssue[] = [];
	const effects: Effect[] = [];
	for (const [index, record] of records.entries()) {
		const parsed = effectSchema.safeParse(record);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				issues.push({
					effectId: `record-${index}`,
					path: issue.path.join("."),
					message: issue.message,
				});
			}
		} else {
			effects.push(parsed.data);
		}
	}
	const byId = new Map(effects.map((effect) => [effect.id, effect]));
	const ids = new Set<string>();
	const slugs = new Set<string>();
	for (const effect of effects) {
		const add = (path: string, message: string) =>
			issues.push({ effectId: effect.id, path, message });
		if (ids.has(effect.id)) add("id", "Effect IDs must be unique.");
		if (slugs.has(effect.slug)) add("slug", "Effect slugs must be unique.");
		ids.add(effect.id);
		slugs.add(effect.slug);
		validateUnique(
			effect.presets.map((preset) => preset.id),
			"presets",
			add,
		);
		validateUnique(
			effect.examples.map((example) => example.id),
			"examples",
			add,
		);
		validateUnique(effect.relatedEffectIds, "relatedEffectIds", add);
		validateUnique(effect.tags, "tags", add);
		if (!effect.presets.some((preset) => preset.id === effect.defaultPresetId)) {
			add("defaultPresetId", "The default preset must exist on this effect.");
		}
		for (const id of effect.relatedEffectIds) {
			if (!byId.has(id)) add("relatedEffectIds", `Unknown related effect: ${id}.`);
			if (id === effect.id)
				add("relatedEffectIds", "Related effects must not point to themselves.");
		}
		if (effect.trendStage !== "none" && (!effect.trendReviewedAt || !effect.trendEvidence)) {
			add("trendStage", "Trend labels require a real review date and recorded evidence.");
		}
		if (effect.publishedAt && Date.parse(effect.updatedAt) < Date.parse(effect.publishedAt)) {
			add("updatedAt", "The update date must not precede publication.");
		}
		for (const preset of effect.presets) validatePreset(effect, preset, add);
		for (const example of effect.examples) {
			const preset = effect.presets.find((candidate) => candidate.id === example.presetId);
			if (!preset) add("examples", `Example ${example.id} references an unknown preset.`);
			else if (!preset.exampleIds.includes(example.id)) {
				add("examples", `Example ${example.id} must be referenced by its preset.`);
			}
		}
		if (effect.status === "published") {
			if (!effect.cover) add("cover", "Published effects require an authorized cover.");
			if (!effect.publishedAt)
				add("publishedAt", "Published effects require their real publication date.");
			if (!effect.lastTestedAt)
				add("lastTestedAt", "Published effects require their real last test date.");
			if (!effect.examples.length)
				add("examples", "Published effects require real product examples.");
			if (
				effect.cover &&
				!effect.examples.some((example) => example.output.src === effect.cover?.src)
			) {
				add("cover", "The cover must use a verified example output.");
			}
			for (const example of effect.examples) {
				const preset = effect.presets.find((candidate) => candidate.id === example.presetId);
				if (!preset || !isCurrentVerifiedExample(example, preset)) {
					add(
						"examples",
						`Example ${example.id} has no passing test for the exact current preset.`,
					);
				}
			}
			const latestTest = Math.max(
				...effect.examples.map((example) => Date.parse(example.testedAt)),
			);
			if (effect.lastTestedAt && Date.parse(effect.lastTestedAt) !== latestTest) {
				add("lastTestedAt", "The last test date must match the most recent published example.");
			}
		}
		if (effect.status === "retired") {
			if (!effect.retirement)
				add("retirement", "Retired effects require an explicit retirement record.");
			const replacementId = effect.retirement?.replacementEffectId;
			if (
				replacementId &&
				(replacementId === effect.id || byId.get(replacementId)?.status !== "published")
			) {
				add(
					"retirement.replacementEffectId",
					"A replacement must be a different published effect.",
				);
			}
		} else if (effect.retirement) {
			add("retirement", "Only explicitly retired effects may have a retirement record.");
		}
	}
	return issues;
}

/** Invalid content stops publication instead of leaking a partial or unverified public record. */
export function assertValidEffects(
	records: readonly unknown[],
): asserts records is readonly Effect[] {
	const issues = validateEffects(records);
	if (issues.length) {
		throw new Error(
			`Invalid Effects content:\n${issues.map((issue) => `${issue.effectId}.${issue.path}: ${issue.message}`).join("\n")}`,
		);
	}
}

export function isPublicEffectAssetPath(value: string): boolean {
	return (
		/^\/images\/effects\/[a-zA-Z0-9][a-zA-Z0-9/_.-]*\.(?:png|jpe?g|webp|avif)$/.test(value) &&
		!value.split("/").some((segment) => segment === "." || segment === "..") &&
		!value.includes("//")
	);
}

function validatePreset(
	effect: Effect,
	preset: EffectPreset,
	add: (path: string, message: string) => void,
): void {
	const path = `presets.${preset.id}`;
	const contract = getImageProductSelectionContract(preset.productKey);
	const cell = contract?.cells.find((candidate) => candidate.skuKey === preset.parameters.skuKey);
	if (!cell) add(path, "Preset SKU must belong to its public product.");
	else {
		if (!cell.aspectRatios.includes(preset.parameters.aspectRatio)) {
			add(path, "The aspect ratio is not supported by this SKU.");
		}
		for (const key of ["outputFormat", "background"] as const) {
			const value = preset.parameters[key];
			if (
				value !== undefined &&
				!cell.controls.find((control) => control.key === key)?.options.includes(value)
			) {
				add(path, `The ${key} value is not supported by this SKU.`);
			}
		}
	}
	if (
		preset.prompt.length < (contract?.minimumPromptLength ?? 1) ||
		preset.prompt.length > (contract?.maximumPromptLength ?? 10000)
	) {
		add(path, "The preset prompt exceeds the public product's prompt limits.");
	}
	validateUnique(preset.exampleIds, `${path}.exampleIds`, add);
	for (const exampleId of preset.exampleIds) {
		const example = effect.examples.find((candidate) => candidate.id === exampleId);
		if (!example || example.presetId !== preset.id)
			add(path, `Unknown or mismatched example: ${exampleId}.`);
	}
	for (const test of preset.tests) {
		if (
			!effect.examples.some(
				(example) => example.id === test.exampleId && example.presetId === preset.id,
			)
		) {
			add(path, `Test references an unknown or mismatched example: ${test.exampleId}.`);
		}
	}
	if (
		effect.status === "published" &&
		!effect.examples.some(
			(example) =>
				preset.exampleIds.includes(example.id) && isCurrentVerifiedExample(example, preset),
		)
	) {
		add(
			path,
			"Every published preset needs an authorized input/output pair tested with its exact current prompt, version, model and parameters.",
		);
	}
}

function validateUnique(
	values: readonly string[],
	path: string,
	add: (path: string, message: string) => void,
): void {
	if (new Set(values).size !== values.length) add(path, "Values must be unique.");
}

function sameParameters(left: EffectParameters, right: EffectParameters): boolean {
	return (
		left.skuKey === right.skuKey &&
		left.aspectRatio === right.aspectRatio &&
		left.outputFormat === right.outputFormat &&
		left.background === right.background
	);
}

function isCurrentVerifiedExample(example: EffectExample, preset: EffectPreset): boolean {
	return (
		example.presetId === preset.id &&
		example.presetVersion === preset.version &&
		example.productKey === preset.productKey &&
		sameParameters(example.parameters, preset.parameters) &&
		preset.tests.some(
			(test) =>
				test.exampleId === example.id &&
				test.outcome === "passed" &&
				test.version === preset.version &&
				test.prompt === preset.prompt &&
				test.productKey === preset.productKey &&
				sameParameters(test.parameters, preset.parameters) &&
				test.testedAt === example.testedAt,
		)
	);
}
