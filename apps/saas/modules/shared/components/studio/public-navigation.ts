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
