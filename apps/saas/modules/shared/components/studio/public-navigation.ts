/** Public categories are shared by the editor, editorial pages, Docs, and footer. */
export const PUBLIC_NAVIGATION_GROUPS = [
	{
		id: "image",
		labelKey: "studio.tools.images",
		links: [
			{
				href: "/create",
				labelKey: "studio.tools.imageToImage",
				descriptionKey: "studio.tools.imageToImageDescription",
				icon: "image",
			},
			{
				href: "/image-to-image",
				labelKey: "imageToImage.name",
				descriptionKey: "imageToImage.navigationDescription",
				icon: "image",
			},
		],
	},
	{
		id: "video",
		labelKey: "studio.tools.videos",
		links: [
			{
				href: "/video-templates",
				labelKey: "studio.tools.videoTemplates",
				descriptionKey: "studio.tools.videoTemplatesDescription",
				icon: "examples",
			},
			{
				href: "/create?mode=video",
				labelKey: "studio.tools.videoGenerator",
				descriptionKey: "studio.tools.videoGeneratorDescription",
				icon: "video",
			},
			{
				href: "/video-effects/hotel-lobby-ai",
				labelKey: "videoEffects.name",
				descriptionKey: "videoEffects.navigationDescription",
				icon: "examples",
			},
			{
				href: "/blog/raindance-ai-trend",
				labelKey: "videoEffects.raindanceName",
				descriptionKey: "videoEffects.raindanceNavigationDescription",
				icon: "examples",
			},
			{
				href: "/docs/video-beta",
				labelKey: "studio.tools.videoGuide",
				icon: "book",
			},
		],
	},
	{
		id: "tools",
		labelKey: "studio.tools.imageTools",
		links: [
			{
				href: "/ai-svg-generator",
				labelKey: "studio.tools.svgGenerator",
				descriptionKey: "studio.tools.svgGeneratorDescription",
				icon: "image",
			},
			{
				href: "/ai-gif-generator",
				labelKey: "studio.tools.gifGenerator",
				descriptionKey: "studio.tools.gifGeneratorDescription",
				icon: "image",
			},
			{
				href: "/christmas-wallpaper",
				labelKey: "christmas.name",
				descriptionKey: "christmas.navigationDescription",
				icon: "image",
			},
			{
				href: "/photo-to-coloring-page",
				labelKey: "coloring.name",
				descriptionKey: "coloring.navigationDescription",
				icon: "image",
			},
		],
	},
	{
		id: "models",
		labelKey: "studio.tools.models",
		links: [
			{
				href: "/seedream-5-5",
				labelKey: "studio.tools.seedream55",
				descriptionKey: "studio.tools.seedream55Description",
				icon: "models",
			},
			{
				href: "/minimax-h3-image",
				labelKey: "studio.tools.minimaxH3Image",
				descriptionKey: "studio.tools.minimaxH3ImageDescription",
				icon: "models",
			},
			{
				href: "/gpt-image-2-6-flare",
				labelKey: "media.create.products.image-gpt-image-2-6-flare.label",
				descriptionKey: "media.create.products.image-gpt-image-2-6-flare.description",
				icon: "models",
			},
			{
				href: "/gpt-image-2-6-sunburst",
				labelKey: "media.create.products.image-gpt-image-2-6-sunburst.label",
				descriptionKey: "media.create.products.image-gpt-image-2-6-sunburst.description",
				icon: "models",
			},
			{
				href: "/models",
				labelKey: "studio.tools.allModels",
				icon: "models",
			},
		],
	},
	{
		id: "resources",
		labelKey: "common.menu.resources",
		links: [
			{
				href: "/blog",
				labelKey: "common.menu.blog",
				descriptionKey: "studio.tools.blogDescription",
				icon: "book",
			},
			{
				href: "/examples",
				labelKey: "studio.tools.examples",
				descriptionKey: "studio.tools.examplesDescription",
				icon: "examples",
			},
			{
				href: "/docs",
				labelKey: "common.menu.docs",
				descriptionKey: "studio.tools.docsDescription",
				icon: "book",
			},
		],
	},
] as const;

export type PublicNavigationGroup = (typeof PUBLIC_NAVIGATION_GROUPS)[number];
export type PublicNavigationLink = PublicNavigationGroup["links"][number];

export const PUBLIC_FOOTER_GROUPS = PUBLIC_NAVIGATION_GROUPS.map((group) => ({
	...group,
	links:
		group.id === "resources"
			? [
					...group.links,
					{ href: "/changelog", labelKey: "common.menu.changelog" as const },
					{ href: "/contact", labelKey: "common.menu.contact" as const },
				]
			: group.links,
}));
