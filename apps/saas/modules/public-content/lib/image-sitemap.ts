import landingVariants from "../../landing/lib/landing-artwork-variants.json";
import type { InspirationKey } from "../../models/lib/model-artwork";
import modelVariants from "../../models/lib/model-artwork-variants.json";
import { MODEL_PAGES, modelPath, modelRecommendations } from "../../models/lib/model-pages";
import { getAllPublishedBlogPosts, getPublishedPhotoIdeaBySlug } from "./content";

function modelImage(artwork: InspirationKey) {
	return modelVariants[artwork].variants.at(-1)!.src;
}

export function getPublicImageSitemapEntries(baseUrl: string) {
	// Use the same full-size responsive variants as the public img elements.
	// The landing manifest contains the twelve recipes and three featured examples.
	const pages = [
		{
			path: "/",
			images: Object.values(landingVariants).map((image) => image.variants.at(-1)!.src),
		},
		{ path: "/models", images: MODEL_PAGES.map((model) => modelImage(model.artwork)) },
		...MODEL_PAGES.map((model) => ({
			path: modelPath(model.key),
			images: [
				modelImage(model.artwork),
				modelImage(model.exampleArtwork),
				...(model.beforeArtwork ? [modelImage(model.beforeArtwork)] : []),
				...modelRecommendations(model).map(({ artwork }) => modelImage(artwork)),
			],
		})),
		...getAllPublishedBlogPosts("en").flatMap((post) => {
			const idea = post.recipeId ? getPublishedPhotoIdeaBySlug(post.slug) : null;
			return idea
				? [
						{
							path: `/blog/${post.slug}`,
							images: idea.recipe.examples.flatMap((example) => [
								example.input.src,
								example.output.src,
							]),
						},
					]
				: [];
		}),
	];
	return pages.map(({ path, images }) => ({
		url: new URL(path, baseUrl).href,
		images: [...new Set(images)].map((src) => new URL(src, baseUrl).href),
	}));
}
