import "server-only";
import { effectRecords } from "../../../content/effects";
import {
	effectPath,
	type Effect,
	type EffectAsset,
	type EffectPageContent,
	type PublicEffect,
	type PublicEffectAsset,
	type RetiredEffect,
} from "./types";
import { assertValidEffects } from "./validation";

export { effectPath, resolveEffectPreset } from "./types";

/**
 * The factory keeps publication rules testable without a second catalog or mock public pages.
 * Runtime provider availability is deliberately absent from this content read boundary.
 */
export function createEffectContentReader(records: readonly Effect[]) {
	assertValidEffects(records);
	const publishedRecords = records.filter((effect) => effect.status === "published");
	const publishedIds = new Set(publishedRecords.map((effect) => effect.id));
	const published = publishedRecords
		.map((effect) => toPageContent(effect, publishedIds) as PublicEffect)
		.sort(
			(left, right) =>
				Date.parse(right.publishedAt) - Date.parse(left.publishedAt) ||
				left.slug.localeCompare(right.slug),
		);

	function getPublishedEffects(): PublicEffect[] {
		return [...published];
	}

	function getPublishedEffectBySlug(slug: string): PublicEffect | null {
		return published.find((effect) => effect.slug === slug) ?? null;
	}

	function getPublishedEffectById(id: string): PublicEffect | null {
		return published.find((effect) => effect.id === id) ?? null;
	}

	/** The route must authorize its administrator before calling this raw server-only reader. */
	function getEffectBySlugForPreview(slug: string): Effect | null {
		return records.find((effect) => effect.slug === slug && effect.status !== "retired") ?? null;
	}

	/** Protected preview only. Even the authorized browser receives no internal evidence references. */
	function getEffectPreviewContent(slug: string): EffectPageContent | null {
		const effect = getEffectBySlugForPreview(slug);
		return effect ? toPageContent(effect, publishedIds) : null;
	}

	function getRetiredEffectBySlug(slug: string): RetiredEffect | null {
		const effect = records.find(
			(candidate) => candidate.slug === slug && candidate.status === "retired",
		);
		if (!effect?.retirement) return null;
		const replacement = effect.retirement.replacementEffectId
			? getPublishedEffectById(effect.retirement.replacementEffectId)
			: null;
		return {
			id: effect.id,
			slug: effect.slug,
			status: "retired",
			retirement: { ...effect.retirement },
			...(replacement ? { redirectTo: effectPath(replacement) } : {}),
		};
	}

	/** Only for server-side relation checks; includes draft identities but never draft copy or assets. */
	function getEffectRecordsForValidation(): readonly {
		id: string;
		presets: readonly { id: string }[];
		examples: readonly { id: string }[];
	}[] {
		return records.map((effect) => ({
			id: effect.id,
			presets: effect.presets.map((preset) => ({ id: preset.id })),
			examples: effect.examples.map((example) => ({ id: example.id })),
		}));
	}

	return {
		getPublishedEffects,
		getPublishedEffectBySlug,
		getPublishedEffectById,
		getEffectBySlugForPreview,
		getEffectPreviewContent,
		getRetiredEffectBySlug,
		getEffectRecordsForValidation,
	};
}

function publicAsset(asset: EffectAsset): PublicEffectAsset {
	return {
		src: asset.src,
		alt: asset.alt,
		width: asset.width,
		height: asset.height,
		credit: asset.rights.holder,
	};
}

function toPageContent(effect: Effect, publishedIds: ReadonlySet<string>): EffectPageContent {
	if (effect.status === "retired") throw new Error("Retired content is not an effect page.");
	const {
		primaryQuery: _primaryQuery,
		queryCluster: _queryCluster,
		trendEvidence: _trendEvidence,
		cover,
		presets,
		examples,
		retirement: _retirement,
		...content
	} = effect;
	return {
		...content,
		status: effect.status,
		...(cover ? { cover: publicAsset(cover) } : {}),
		relatedEffectIds: effect.relatedEffectIds.filter((id) => publishedIds.has(id)),
		presets: presets.map(({ tests: _tests, ...preset }) => preset),
		examples: examples.map(({ provenance: _provenance, input, output, ...example }) => ({
			...example,
			input: publicAsset(input),
			output: publicAsset(output),
		})),
	};
}

export const {
	getPublishedEffects,
	getPublishedEffectBySlug,
	getPublishedEffectById,
	getEffectBySlugForPreview,
	getEffectPreviewContent,
	getRetiredEffectBySlug,
	getEffectRecordsForValidation,
} = createEffectContentReader(effectRecords);
