import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ effects: [] as { id: string }[] }));
vi.mock("server-only", () => ({}));
vi.mock("../../effects/lib/content", () => ({
	getPublishedEffectById: (id: string) => state.effects.find((effect) => effect.id === id) ?? null,
}));

import { eightiesPhotoEffect } from "../../../content/effects/1980s-ai-photo";
import { promptEditingDocuments } from "../../../content/posts/ai-image-editing-prompts";
import { blogDocuments } from "../../../content/posts/private-image-editing-workflow";
import type { PublicEffect } from "../../effects/lib/types";
import {
	getBlogVisual,
	resolveBlogVisual,
	toVisualBlogCard,
	withBlogVisualCover,
} from "./BlogVisual.server";

// Synthetic selection fixture only: no images are stored or admitted to the content catalog.
function exampleEffect(): PublicEffect {
	const preset = {
		...eightiesPhotoEffect.presets[0]!,
		version: 2,
		exampleIds: ["studio-unit-example"],
	};
	const asset = (name: string) => ({
		src: `/images/effects/unit-fixtures/${name}.webp`,
		alt: `Unit fixture ${name}`,
		width: 800,
		height: 1000,
	});
	return {
		...eightiesPhotoEffect,
		status: "published",
		publishedAt: "2026-09-29",
		lastTestedAt: "2026-09-29",
		cover: asset("output"),
		presets: [preset],
		examples: [
			{
				id: "studio-unit-example",
				presetId: preset.id,
				presetVersion: 2,
				caption: "Synthetic resolver fixture, not a product result.",
				input: asset("input"),
				output: asset("output"),
				productKey: preset.productKey,
				parameters: preset.parameters,
				testedAt: "2026-09-29",
			},
		],
	};
}

beforeEach(() => {
	state.effects = [];
});

describe("published Blog visual projection", () => {
	it("does not expose a draft relationship or put portrait imagery on an unrelated privacy article", () => {
		expect(getBlogVisual(promptEditingDocuments[0])).toBeNull();
		expect(toVisualBlogCard(promptEditingDocuments[0], "en").cover).toBeUndefined();
		state.effects = [exampleEffect()];
		expect(getBlogVisual(blogDocuments[0])).toBeNull();
		expect(toVisualBlogCard(blogDocuments[0], "en").cover).toBeUndefined();
	});

	it("uses the referenced preset's current input and output without changing article identity or dates", () => {
		const effect = exampleEffect();
		state.effects = [effect];
		const post = promptEditingDocuments[0];
		const visual = getBlogVisual(post);
		expect(visual?.preset.id).toBe("studio-portrait");
		expect(visual?.preset.version).toBe(2);
		const card = toVisualBlogCard(post, "en");
		expect(card.comparisonInput?.src).toBe(effect.examples[0]!.input.src);
		expect(card.cover?.src).toBe(effect.examples[0]!.output.src);
		const article = withBlogVisualCover(post);
		expect(article.slug).toBe(post.slug);
		expect(article.title).toBe(post.title);
		expect(article.body).toBe(post.body);
		expect(article.publishedAt).toBe("2026-09-12");
		expect(article.updatedAt).toBeUndefined();
	});

	it("rejects stale examples and unrelated or nonpublished records", () => {
		const effect = exampleEffect();
		const post = promptEditingDocuments[0];
		expect(
			resolveBlogVisual(post, [
				{ ...effect, examples: [{ ...effect.examples[0]!, presetVersion: 1 }] },
			]),
		).toBeNull();
		expect(resolveBlogVisual(post, [{ ...effect, id: "unrelated" }])).toBeNull();
		expect(
			resolveBlogVisual(post, [{ ...effect, status: "draft" } as unknown as PublicEffect]),
		).toBeNull();
	});
});
