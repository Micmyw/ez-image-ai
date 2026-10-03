import type {
	ImageAspectRatio,
	ImageBackground,
	ImageOutputFormat,
	ImageSkuKey,
} from "@repo/config/client";

import type { EditorProductKey } from "../../media/lib/editor-recovery";

export const EFFECT_CATEGORIES = [
	{ id: "retro-vintage", label: "Retro & Vintage" },
	{ id: "portraits", label: "Portraits" },
	{ id: "artistic-styles", label: "Artistic Styles" },
	{ id: "product-scenes", label: "Product Scenes" },
] as const;

export const EFFECT_TAGS = [
	"portrait",
	"family",
	"street",
	"couple",
	"product",
	"illustration",
	"retro",
] as const;

export type EffectCategoryId = (typeof EFFECT_CATEGORIES)[number]["id"];
export type EffectTag = (typeof EFFECT_TAGS)[number];
export type EffectStatus = "draft" | "published" | "retired";
export type EffectTrendStage = "none" | "rising" | "trending" | "cooling" | "evergreen";

export interface EffectParameters {
	skuKey: ImageSkuKey;
	aspectRatio: ImageAspectRatio;
	outputFormat?: ImageOutputFormat;
	background?: ImageBackground;
}

export interface EffectAsset {
	src: string;
	alt: string;
	width: number;
	height: number;
	rights: {
		kind: "owned" | "licensed";
		holder: string;
		evidence: string;
		verifiedAt: string;
	};
}

export interface EffectPresetTest {
	exampleId: string;
	version: number;
	prompt: string;
	productKey: EditorProductKey;
	parameters: EffectParameters;
	testedAt: string;
	outcome: "passed" | "failed";
	evidence: string;
}

export interface EffectPreset {
	id: string;
	version: number;
	name: string;
	prompt: string;
	inputRequirement: "required" | "optional";
	inputHint: string;
	productKey: EditorProductKey;
	parameters: EffectParameters;
	exampleIds: readonly string[];
	tests: readonly EffectPresetTest[];
}

export interface EffectExample {
	id: string;
	presetId: string;
	presetVersion: number;
	caption: string;
	input: EffectAsset;
	output: EffectAsset;
	productKey: EditorProductKey;
	parameters: EffectParameters;
	testedAt: string;
	provenance: {
		kind: "product-generation";
		evidence: string;
	};
}

export interface EffectRetirement {
	reason: string;
	retiredAt: string;
	replacementEffectId?: string;
}

export interface Effect {
	id: string;
	slug: string;
	title: string;
	summary: string;
	seoTitle: string;
	seoDescription: string;
	primaryQuery: string;
	queryCluster: readonly string[];
	primaryCategoryId: EffectCategoryId;
	tags: readonly EffectTag[];
	status: EffectStatus;
	trendStage: EffectTrendStage;
	trendReviewedAt?: string;
	trendEvidence?: string;
	featuredOrder?: number;
	cover?: EffectAsset;
	examples: readonly EffectExample[];
	defaultPresetId: string;
	presets: readonly EffectPreset[];
	instructions: readonly { title: string; body: string }[];
	limitations: readonly string[];
	faq: readonly { question: string; answer: string }[];
	relatedEffectIds: readonly string[];
	publishedAt?: string;
	updatedAt: string;
	lastTestedAt?: string;
	retirement?: EffectRetirement;
}

export type PublicEffectAsset = Omit<EffectAsset, "rights"> & { credit?: string };
export type PublicEffectPreset = Omit<EffectPreset, "tests">;
export type PublicEffectExample = Omit<EffectExample, "input" | "output" | "provenance"> & {
	input: PublicEffectAsset;
	output: PublicEffectAsset;
};

/** Safe to serialize only after the server has authorized preview or selected published content. */
export type EffectPageContent = Omit<
	Effect,
	| "status"
	| "primaryQuery"
	| "queryCluster"
	| "trendEvidence"
	| "cover"
	| "presets"
	| "examples"
	| "retirement"
> & {
	status: "draft" | "published";
	cover?: PublicEffectAsset;
	presets: readonly PublicEffectPreset[];
	examples: readonly PublicEffectExample[];
};

export type PublicEffect = EffectPageContent & {
	status: "published";
	cover: PublicEffectAsset;
	publishedAt: string;
	lastTestedAt: string;
};

export type RetiredEffect = Pick<Effect, "id" | "slug"> & {
	status: "retired";
	retirement: EffectRetirement;
	redirectTo?: string;
};

type PresetContainer = { defaultPresetId: string; presets: readonly PublicEffectPreset[] };

/** URL parameters select registered content only; unknown IDs return to the authored default. */
export function resolveEffectPreset<T extends PresetContainer>(
	effect: T,
	presetId?: string | null,
): T["presets"][number] {
	const preset =
		effect.presets.find((candidate) => candidate.id === presetId) ??
		effect.presets.find((candidate) => candidate.id === effect.defaultPresetId);
	if (!preset) throw new Error("Effect has no valid default preset.");
	return preset;
}

/** Pure URL helper: no content corpus, private prompt, asset reference, or arbitrary URL is accepted. */
export function effectPath(
	effect: { slug: string; presets: readonly { id: string }[] },
	presetId?: string,
	sourceBlogId?: string,
): string {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(effect.slug) || effect.slug === "category") {
		throw new Error("Invalid effect slug.");
	}
	const parameters = new URLSearchParams();
	if (presetId && effect.presets.some((preset) => preset.id === presetId)) {
		parameters.set("preset", presetId);
	}
	if (
		sourceBlogId &&
		/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sourceBlogId) &&
		sourceBlogId.length <= 96
	) {
		parameters.set("source", sourceBlogId);
	}
	const query = parameters.toString();
	return `/effects/${effect.slug}${query ? `?${query}` : ""}`;
}
