export const CHRISTMAS_PATH = "/christmas-wallpaper";
export const CHRISTMAS_TITLE = "Christmas Wallpaper Maker — Your Photo, Your Holiday";
export const CHRISTMAS_DESCRIPTION =
	"Create a Christmas wallpaper from your photo or a festive scene. Choose six styles, preview your phone or desktop, and crop your wallpaper before downloading.";

export const CHRISTMAS_STYLES = [
	{
		id: "fireplace",
		name: "Cozy fireplace",
		detail: "Golden light. A little closer to home.",
		photo: true,
		scene:
			"A cozy Christmas living room with a glowing fireplace, a pine tree with warm fairy lights, soft amber light, natural photographic textures and a peaceful atmosphere.",
	},
	{
		id: "street",
		name: "Snowy Christmas street",
		detail: "Blue-hour snow and golden windows.",
		photo: true,
		scene:
			"A snowy Christmas street at blue hour, historic buildings with warm golden windows, restrained pine garlands and gentle snowfall. Natural cinematic photography.",
	},
	{
		id: "globe",
		name: "Inside a snow globe",
		detail: "Your own tiny winter world.",
		photo: true,
		scene:
			"A clear glass snow globe on a walnut base containing a tiny Christmas cottage and decorated pine tree. Place the subject inside the globe when a reference is supplied. Falling snow, realistic glass reflections, warm interior light and a deep evergreen background.",
	},
	{
		id: "pet",
		name: "Pet under the tree",
		detail: "Their favorite spot, dressed for Christmas.",
		photo: true,
		scene:
			"A cozy Christmas living room with a decorated pine tree, cream rug, kraft-paper gifts and warm fairy lights. The main subject is a pet sitting naturally under the tree. Natural detailed fur and believable anatomy; no costume by default.",
	},
	{
		id: "pink",
		name: "Pink Christmas",
		detail: "Soft pink. Pearls. A quieter kind of festive.",
		photo: false,
		scene:
			"A minimal blush-pink Christmas tree with pearl-white and brushed-gold ornaments on a pale rose surface, soft studio light, matte tactile materials and a calm powder-pink background.",
	},
	{
		id: "dark",
		name: "Dark Christmas lights",
		detail: "Evergreen shadows and little golden lights.",
		photo: false,
		scene:
			"A natural evergreen Christmas tree with sparse warm golden pin lights and small deep-red ornaments in a nearly black forest-green room. Restrained chiaroscuro, rich blacks and a subtle floor reflection.",
	},
] as const;

export type ChristmasStyleId = (typeof CHRISTMAS_STYLES)[number]["id"];
export type WallpaperScreen = "phone" | "desktop";
export type WallpaperSettings = {
	style: ChristmasStyleId;
	screen: WallpaperScreen;
	mode: "photo" | "scene";
	festiveOutfit: boolean;
};
export const DEFAULT_WALLPAPER_SETTINGS: WallpaperSettings = {
	style: "fireplace",
	screen: "phone",
	mode: "photo",
	festiveOutfit: false,
};
export function wallpaperImage(id: ChristmasStyleId) {
	return `/images/christmas/${id}.webp`;
}
export function wallpaperAspectRatio(screen: WallpaperScreen) {
	return screen === "phone" ? ("9:16" as const) : ("16:9" as const);
}
export function buildChristmasPrompt(settings: WallpaperSettings): string {
	const style = CHRISTMAS_STYLES.find((item) => item.id === settings.style) ?? CHRISTMAS_STYLES[0];
	return [
		"Create one finished Christmas wallpaper.",
		style.scene,
		settings.mode === "photo"
			? "Use the uploaded photo as the reference. Preserve the recognizable face, expression, apparent age, hair and natural proportions, or the pet's distinctive fur and markings. Keep the same number of subjects; do not add or merge people. If no photo is supplied, create the Christmas scene without people."
			: `Create the scene without people. Do not reproduce a person from a reference.${settings.style === "pet" ? " Include one natural-looking golden retriever." : ""}`,
		settings.mode === "photo" && settings.festiveOutfit
			? "For a person, add a simple festive knit sweater while keeping the face and pose recognizable. For a pet, add only a small festive bandana, leaving its face clear."
			: "Keep any reference subject's original clothing. Do not add a hat or cover the face.",
		settings.screen === "phone"
			? "Use a tall 9:16 composition. Keep the subject in the lower middle with space around the head. Leave the upper third calm and uncluttered for a phone clock; keep key details away from the top and bottom edges."
			: "Use a wide 16:9 composition, deliberately extending the environment. Place the main subject in the right half, with calm negative space on the left for desktop icons. Keep heads and key details away from the edges; do not stretch a portrait.",
		"No text, lettering, watermark, logos, device frame, clock, interface or collage. Produce the artwork only.",
	].join(" ");
}

export const WALLPAPER_TARGETS = {
	phone: { width: 1080, height: 1920 },
	tall: { width: 1170, height: 2532 },
	desktop: { width: 1920, height: 1080 },
} as const;
export type WallpaperTarget = keyof typeof WALLPAPER_TARGETS;

/** Crop in source pixels. Never upscale or claim more detail than the source contains. */
export function wallpaperCrop(
	width: number,
	height: number,
	target: WallpaperTarget,
	x = 50,
	y = 50,
	zoom = 1,
) {
	if (![width, height, x, y, zoom].every(Number.isFinite) || width <= 0 || height <= 0)
		throw new Error("Invalid image dimensions");
	const output = WALLPAPER_TARGETS[target];
	const scale =
		Math.max(output.width / width, output.height / height) * Math.min(3, Math.max(1, zoom));
	const sw = output.width / scale;
	const sh = output.height / scale;
	const downscale = Math.min(1, scale);
	return {
		sx: ((width - sw) * Math.min(100, Math.max(0, x))) / 100,
		sy: ((height - sh) * Math.min(100, Math.max(0, y))) / 100,
		sw,
		sh,
		width: Math.max(1, Math.floor(sw * downscale + 1e-8)),
		height: Math.max(1, Math.floor(sh * downscale + 1e-8)),
	};
}
