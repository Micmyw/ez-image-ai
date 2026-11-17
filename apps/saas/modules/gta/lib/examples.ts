import type { GtaIntent, GtaSceneId, GtaSettings } from "./config";

export type GtaExample = {
	id: string;
	intent: GtaIntent;
	sceneId: GtaSceneId;
	format: "phone" | "desktop";
	src: string;
	downloadSrc: string;
	width: number;
	height: number;
	alt: string;
	sourceSrc?: string;
	sourceWidth?: number;
	sourceHeight?: number;
	position?: "left" | "right";
};

/** Never substitute another task, shape or portrait composition for the selected draft. */
export function findGtaExample(intent: GtaIntent, settings: GtaSettings) {
	return GTA_EXAMPLES.find(
		(item) =>
			item.intent === intent &&
			item.sceneId === settings.sceneId &&
			item.format === settings.format &&
			Boolean(item.sourceSrc) === (settings.sourceMode === "photo") &&
			(intent !== "loading-art" || item.position === settings.position),
	);
}

/** Owner-commissioned AI style previews. Full prompts and provenance are in the evidence manifest. */
export const GTA_EXAMPLES: readonly GtaExample[] = [
	{
		id: "beach-sunset-phone",
		intent: "wallpaper",
		sceneId: "beach-sunset",
		format: "phone",
		src: "/images/gta/beach-sunset-phone.webp",
		downloadSrc: "/images/gta/beach-sunset-phone.jpg",
		width: 941,
		height: 1672,
		alt: "Coral sunset above a turquoise beach and palm-lined boardwalk.",
	},
	{
		id: "neon-boulevard-phone",
		intent: "wallpaper",
		sceneId: "neon-boulevard",
		format: "phone",
		src: "/images/gta/neon-boulevard-phone.webp",
		downloadSrc: "/images/gta/neon-boulevard-phone.jpg",
		width: 941,
		height: 1672,
		alt: "Empty art-deco boulevard with cyan neon and wet-road reflections.",
	},
	{
		id: "sports-car-phone",
		intent: "wallpaper",
		sceneId: "sports-car",
		format: "phone",
		src: "/images/gta/sports-car-phone.webp",
		downloadSrc: "/images/gta/sports-car-phone.jpg",
		width: 941,
		height: 1672,
		alt: "Coral sports coupe on a palm-lined coastal road at golden hour.",
	},
	{
		id: "rooftop-phone",
		intent: "wallpaper",
		sceneId: "rooftop",
		format: "phone",
		src: "/images/gta/rooftop-phone.webp",
		downloadSrc: "/images/gta/rooftop-phone.jpg",
		width: 941,
		height: 1672,
		alt: "Rooftop terrace overlooking a coastal city beneath a coral evening sky.",
	},
	{
		id: "marina-phone",
		intent: "wallpaper",
		sceneId: "marina",
		format: "phone",
		src: "/images/gta/marina-phone.webp",
		downloadSrc: "/images/gta/marina-phone.jpg",
		width: 941,
		height: 1672,
		alt: "Small yachts beside a lantern-lit tropical dock at blue hour.",
	},
	{
		id: "palm-road-phone",
		intent: "wallpaper",
		sceneId: "palm-road",
		format: "phone",
		src: "/images/gta/palm-road-phone.webp",
		downloadSrc: "/images/gta/palm-road-phone.jpg",
		width: 941,
		height: 1672,
		alt: "Empty palm-lined road beside a turquoise bay in afternoon light.",
	},
	{
		id: "beach-sunset-desktop",
		intent: "wallpaper",
		sceneId: "beach-sunset",
		format: "desktop",
		src: "/images/gta/beach-sunset-desktop.webp",
		downloadSrc: "/images/gta/beach-sunset-desktop.jpg",
		width: 1672,
		height: 941,
		alt: "Wide tropical sunset beach with open ocean and a boardwalk on the right.",
	},
	{
		id: "palm-road-desktop",
		intent: "wallpaper",
		sceneId: "palm-road",
		format: "desktop",
		src: "/images/gta/palm-road-desktop.webp",
		downloadSrc: "/images/gta/palm-road-desktop.jpg",
		width: 1672,
		height: 941,
		alt: "Wide coastal road and palms on the right with calm turquoise sea on the left.",
	},
	{
		id: "wallpaper-beach-photo",
		intent: "wallpaper",
		sceneId: "beach-sunset",
		format: "phone",
		src: "/images/gta/wallpaper-beach-photo.webp",
		downloadSrc: "/images/gta/wallpaper-beach-photo.jpg",
		width: 941,
		height: 1672,
		alt: "Woman with amber glasses and a rust shirt on a sunset beach boardwalk.",
		sourceSrc: "/images/gta/source-a.webp",
		sourceWidth: 1086,
		sourceHeight: 1448,
		position: "right",
	},
	{
		id: "wallpaper-car-photo",
		intent: "wallpaper",
		sceneId: "sports-car",
		format: "phone",
		src: "/images/gta/wallpaper-car-photo.webp",
		downloadSrc: "/images/gta/wallpaper-car-photo.jpg",
		width: 941,
		height: 1672,
		alt: "Bearded man in a cream shirt beside a teal sports car on a coastal road.",
		sourceSrc: "/images/gta/source-b.webp",
		sourceWidth: 1086,
		sourceHeight: 1448,
		position: "right",
	},
	{
		id: "loading-neon-right",
		intent: "loading-art",
		sceneId: "neon-boulevard",
		format: "desktop",
		src: "/images/gta/loading-neon-right.webp",
		downloadSrc: "/images/gta/loading-neon-right.jpg",
		width: 1672,
		height: 941,
		alt: "Illustrated woman with amber glasses on the right of a neon coastal boulevard.",
		sourceSrc: "/images/gta/source-a.webp",
		sourceWidth: 1086,
		sourceHeight: 1448,
		position: "right",
	},
	{
		id: "loading-marina-left",
		intent: "loading-art",
		sceneId: "marina",
		format: "desktop",
		src: "/images/gta/loading-marina-left.webp",
		downloadSrc: "/images/gta/loading-marina-left.jpg",
		width: 1672,
		height: 941,
		alt: "Illustrated bearded man on the left of a blue-hour marina with open water on the right.",
		sourceSrc: "/images/gta/source-b.webp",
		sourceWidth: 1086,
		sourceHeight: 1448,
		position: "left",
	},
	{
		id: "loading-palm-right-phone",
		intent: "loading-art",
		sceneId: "palm-road",
		format: "phone",
		src: "/images/gta/loading-palm-right-phone.webp",
		downloadSrc: "/images/gta/loading-palm-right-phone.jpg",
		width: 892,
		height: 1586,
		alt: "Illustrated woman with a short bob and green shirt above a quiet teal name area.",
		sourceSrc: "/images/gta/source-c.webp",
		sourceWidth: 1086,
		sourceHeight: 1448,
		position: "right",
	},
];
