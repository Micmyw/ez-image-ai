import type { ImageAspectRatio } from "@repo/config/client";

export const GTA_THEME = "gta-coastal";
export const GTA_PROMPT_VERSION = "gta-coastal-v1";
export type GtaIntent = "wallpaper" | "loading-art";

export const GTA_PAGES = {
	wallpaper: {
		path: "/gta-6-wallpaper",
		title: "GTA 6 Wallpaper Generator — Your Photo, Your Scene | EzImageAI",
		h1: "GTA 6 Wallpaper Generator",
		description:
			"Create an original GTA-inspired wallpaper from your photo or a new scene. Choose beach, neon or sports-car looks, preview the fit and download.",
	},
	"loading-art": {
		path: "/gta-loading-screen-generator",
		title: "GTA Loading Screen Generator — Make Your Own Art | EzImageAI",
		h1: "GTA Loading Screen Generator",
		description:
			"Turn your photo into GTA-inspired loading-screen art. Pick a scene, place your portrait, add your name and download your image.",
	},
} as const;

export const GTA_SCENES = [
	{
		id: "beach-sunset",
		name: "Beach Sunset",
		detail: "Coral skies, turquoise water and a palm-lined boardwalk.",
		prompt:
			"A tropical beach boardwalk at sunset, gently leaning palm trees, turquoise water and distant pastel buildings. Warm coral sunlight, a broad clean sky and subtle ocean reflections. Keep the foreground uncluttered.",
	},
	{
		id: "neon-boulevard",
		name: "Neon Boulevard",
		detail: "Art-deco streets reflected in cyan and magenta light.",
		prompt:
			"A fictional tropical art-deco boulevard after light rain, cyan and magenta neon accents, palm silhouettes and clean wet-road reflections. Signs are abstract shapes without readable lettering. Keep natural facial color and enough soft frontal light to recognize a referenced subject.",
	},
	{
		id: "sports-car",
		name: "Sports Car",
		detail: "A coastal boulevard, golden light and an unbranded sports car.",
		prompt:
			"An unbranded modern sports car parked beside a coastal boulevard at golden hour. Show a coherent car body, believable wheels and restrained reflections. When a person is referenced, place them naturally beside the car with relaxed hands and no complex driving action.",
	},
	{
		id: "rooftop",
		name: "Rooftop Skyline",
		detail: "Evening air above a layered coastal-city skyline.",
		prompt:
			"A quiet rooftop overlooking a coastal city, layered low-rise buildings, distant high-rises and palm trees under a warm evening sky. Strong depth, a clean silhouette and simple foreground geometry.",
	},
	{
		id: "marina",
		name: "Marina Blue Hour",
		detail: "Harbor lights, pale twilight and calm turquoise water.",
		prompt:
			"A calm marina at blue hour, small yachts, turquoise water, soft harbor lights and a pale twilight sky. Keep masts and railings clear of a referenced person's face and maintain a clear silhouette.",
	},
	{
		id: "palm-road",
		name: "Palm Road",
		detail: "An open road framed by palms and long afternoon shadows.",
		prompt:
			"A broad palm-lined coastal road with long late-afternoon shadows, low pastel architecture and warm atmospheric distance. Use the road and palms as leading lines and keep the upper sky calm and open.",
	},
] as const;

export type GtaSceneId = (typeof GTA_SCENES)[number]["id"];
export type GtaSettings = {
	sceneId: GtaSceneId;
	sourceMode: "photo" | "scene";
	format: "phone" | "desktop";
	position: "left" | "right";
};

export function defaultGtaSettings(intent: GtaIntent): GtaSettings {
	return {
		sceneId: intent === "wallpaper" ? "beach-sunset" : "neon-boulevard",
		sourceMode: "photo",
		format: intent === "wallpaper" ? "phone" : "desktop",
		position: "right",
	};
}

export function gtaAspectRatio(format: GtaSettings["format"]): ImageAspectRatio {
	return format === "phone" ? "9:16" : "16:9";
}

export const GTA_ILLUSTRATION_STYLE =
	"Render as polished illustrated key art for a fictional modern coastal action game. Use confident contour lines, simplified painted planes, clean edges, expressive believable anatomy, rich warm highlights and cool shadows. Use a controlled coral, turquoise and muted magenta palette. Preserve readable facial features and strong depth in a finished illustrated poster.";

export const GTA_DETAILS_LIMIT = 1500;
const DETAILS_SEPARATOR = "\n\nAdditional preferences (keep the selected style and composition):\n";

export function gtaPromptDetails(
	prompt: string,
	intent: GtaIntent,
	settings: GtaSettings,
): string | null {
	const base = buildGtaPrompt(intent, settings);
	if (prompt === base) return "";
	return prompt.startsWith(base + DETAILS_SEPARATOR)
		? prompt.slice(base.length + DETAILS_SEPARATOR.length)
		: null;
}

export function buildGtaPrompt(intent: GtaIntent, settings: GtaSettings, details = ""): string {
	const scene = GTA_SCENES.find((item) => item.id === settings.sceneId);
	if (
		!scene ||
		!["wallpaper", "loading-art"].includes(intent) ||
		!["photo", "scene"].includes(settings.sourceMode) ||
		!["phone", "desktop"].includes(settings.format) ||
		!["left", "right"].includes(settings.position) ||
		(intent === "loading-art" && settings.sourceMode !== "photo")
	) {
		throw new Error("Unsupported coastal artwork settings");
	}
	const composition =
		intent === "loading-art"
			? `Compose a single-panel ${gtaAspectRatio(settings.format)} illustrated loading-screen portrait. Place one recognizable waist-up or three-quarter figure on the ${settings.position}, with layered scenery and a clear silhouette. Reserve a clean contrasting area on the ${settings.position === "right" ? "left" : "right"} for lettering added later. ${settings.format === "phone" ? "Keep the face above the lower quarter and reserve that lower area for the optional name." : "Keep the face large and clear of the opposite-side name area."} Do not render lettering.`
			: settings.format === "phone"
				? "Compose for a vertical 9:16 phone wallpaper. Place the person or focal object in the lower middle. Keep approximately the upper quarter to third visually quiet for a lock-screen clock. Keep facial details away from the edges."
				: "Compose for a wide 16:9 desktop wallpaper. Place the person or focal object in the right third and keep the left third comparatively quiet for desktop icons. Extend the environment deliberately.";
	const base = [
		// Persisted in the existing quote's complete prompt fingerprint and task snapshot.
		`Coastal artwork preset ${GTA_PROMPT_VERSION}. Task ${intent}. Scene ${settings.sceneId}. Input ${settings.sourceMode}. Format ${settings.format}. Portrait ${settings.position}.`,
		settings.sourceMode === "photo"
			? "Use the uploaded photo as the identity reference for exactly one main person. Preserve recognizable facial structure, skin tone, apparent age, hairstyle, glasses or facial hair when present, and the visible outfit. Reinterpret the environment and lighting while keeping that person recognizable. Use a simple natural pose and anatomically coherent hands."
			: "Create an original environment wallpaper without people or a main human character. Build a clear focal point from the location, light and objects. Keep the composition spacious.",
		GTA_ILLUSTRATION_STYLE,
		scene.prompt,
		composition,
		"Produce original artwork. Avoid official game logos, existing game characters, readable signage, decorative lettering, interface, device frames, clocks, icons, collage panels, duplicated people, extra limbs and distorted vehicle geometry. Deliver one continuous image.",
	].join("\n\n");
	return details ? base + DETAILS_SEPARATOR + details.slice(0, GTA_DETAILS_LIMIT) : base;
}

/** Public fragments contain only preset choices. Private editor drafts have their own store. */
export function parseGtaHash(intent: GtaIntent, hash: string): GtaSettings {
	const result = defaultGtaSettings(intent);
	if (hash.length > 256) return result;
	const values = new URLSearchParams(hash.replace(/^#/, ""));
	const scene = GTA_SCENES.find((item) => item.id === values.get("scene"));
	if (scene) result.sceneId = scene.id;
	if (values.get("format") === "phone" || values.get("format") === "desktop")
		result.format = values.get("format") as GtaSettings["format"];
	if (values.get("position") === "left") result.position = "left";
	if (intent === "wallpaper" && values.get("mode") === "scene") result.sourceMode = "scene";
	return result;
}

export function gtaHash(settings: GtaSettings): string {
	return `#${new URLSearchParams({
		scene: settings.sceneId,
		format: settings.format,
		position: settings.position,
		mode: settings.sourceMode,
	})}`;
}

/** Read only our fixed, public header. Never infer result settings from the current draft. */
export function gtaSettingsFromPrompt(
	prompt: string,
): { intent: GtaIntent; settings: GtaSettings } | null {
	const match =
		/^Coastal artwork preset gta-coastal-v1\. Task (wallpaper|loading-art)\. Scene ([a-z-]+)\. Input (photo|scene)\. Format (phone|desktop)\. Portrait (left|right)\./.exec(
			prompt,
		);
	if (!match) return null;
	const [, intent, sceneId, sourceMode, format, position] = match;
	const scene = GTA_SCENES.find((item) => item.id === sceneId);
	if (!scene || (intent === "loading-art" && sourceMode !== "photo")) return null;
	return {
		intent: intent as GtaIntent,
		settings: {
			sceneId: scene.id,
			sourceMode: sourceMode as GtaSettings["sourceMode"],
			format: format as GtaSettings["format"],
			position: position as GtaSettings["position"],
		},
	};
}
