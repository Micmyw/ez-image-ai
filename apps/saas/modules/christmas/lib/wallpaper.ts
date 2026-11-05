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
			"A cozy Christmas living room with a glowing fireplace and a pine tree with warm fairy lights, soft amber light, natural photographic textures and a peaceful atmosphere. Use restrained evergreen and burgundy accents. Keep the fire and fairy lights softly exposed, with visible detail in the wood, fabric and room shadows.",
		photoDirection:
			"When a reference is supplied, place the subject naturally in front of the hearth, clear of the flames. Let the fireplace cast gentle warm side light with soft fill on the face and clothing. Keep skin tones balanced and the subject at a believable scale within the room.",
	},
	{
		id: "street",
		name: "Snowy Christmas street",
		detail: "Blue-hour snow and golden windows.",
		photo: true,
		scene:
			"A snowy Christmas street at blue hour, historic buildings with warm golden windows, restrained pine garlands and gentle snowfall. Use coherent street perspective, textured snow underfoot and a few flakes at different depths. Keep distant decorations softly focused and the main focal area clear. Natural cinematic photography.",
		photoDirection:
			"When a reference is supplied, place the subject naturally on the snowy street. Match cool ambient light with gentle warm light from nearby windows. Keep visible feet or paws grounded in the snow and keep flakes away from the eyes and facial features.",
	},
	{
		id: "globe",
		name: "Inside a snow globe",
		detail: "Your own tiny winter world.",
		photo: true,
		scene:
			"A clear glass snow globe on a walnut base containing a tiny Christmas cottage and decorated pine tree. Show the complete round globe and its base together as the main focal arrangement. Keep fine falling snow inside the globe, with realistic edge reflections, warm interior light and a deep evergreen background.",
		photoDirection:
			"When a reference is supplied, place the same subject fully inside the globe, standing or sitting on its snowy interior ground at a consistent miniature scale. Preserve recognizable features and natural anatomy. Keep glass highlights and snow clear of the face, with the body contained within the glass sphere.",
	},
	{
		id: "pet",
		name: "Pet under the tree",
		detail: "Their favorite spot, dressed for Christmas.",
		photo: true,
		scene:
			"A cozy Christmas living room with a decorated pine tree, cream rug, kraft-paper gifts and warm fairy lights. Leave an inviting open spot on the rug beside the tree. Place gifts and ornaments around that spot with gentle background separation, natural textures and soft shadows.",
		photoDirection:
			"When a reference is supplied, place the original subject naturally on the rug beside the tree. For a pet, use an eye-level view and a relaxed pose with believable limbs and supported paws. Preserve its species, coat markings, ears and muzzle, and keep ornaments and branches clear of its face.",
	},
	{
		id: "pink",
		name: "Pink Christmas",
		detail: "Soft pink. Pearls. A quieter kind of festive.",
		photo: false,
		scene:
			"A minimal blush-pink Christmas tree with pearl-white and brushed-gold ornaments on a pale rose surface, soft studio light, matte tactile materials and a calm powder-pink background. Group the tree and a few ornaments into one balanced focal arrangement. Use restrained pastel color, gentle shadows and clear separation between pale objects and the background.",
		photoDirection:
			"When a reference is supplied, integrate the subject beside the tree in the same pastel studio setting. Use soft neutral light on the face and fur, preserving natural skin tones and coat colors while keeping the pink palette in the surrounding decor.",
	},
	{
		id: "dark",
		name: "Dark Christmas lights",
		detail: "Evergreen shadows and little golden lights.",
		photo: false,
		scene:
			"A natural evergreen Christmas tree with sparse warm golden pin lights and small deep-red ornaments in a nearly black forest-green room. Restrained chiaroscuro, rich blacks and a subtle floor reflection. Retain visible detail in the pine needles and ornaments, with small controlled light halos and broad areas of calm dark background.",
		photoDirection:
			"When a reference is supplied, use gentle warm edge lighting and soft frontal fill to keep the face, eyes and silhouette readable. Retain detail in dark hair, fur and clothing while preserving the surrounding night atmosphere.",
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
		settings.screen === "phone"
			? "Use a tall 9:16 composition. Reframe the scene for a phone lock screen. Leave the upper third as simple, softly lit background with no faces, focal objects or bright decorations. Place the main subject or decorative arrangement in the lower middle. For a person or pet, keep the top of the head below this clear area. Keep the complete focal arrangement within the frame, with breathing room at both sides and the bottom. Adjust the camera distance and extend the background to achieve this layout."
			: "Use a wide 16:9 composition, deliberately extending the environment. Place the main subject in the right half, keeping its focal arrangement together, with calm negative space on the left for desktop icons. Keep heads and key details away from the edges. Preserve natural proportions when reframing a portrait.",
		settings.mode === "photo"
			? `Use the uploaded photo as the identity reference. Preserve the recognizable face, expression, apparent age, hair and natural body proportions, or the pet's species, distinctive fur and markings. Keep the same number of subjects and do not add or merge people. Replace the original background completely with the Christmas setting. Recompose the framing to fit the wallpaper layout. If no photo is supplied, create the Christmas setting without people.${settings.style === "pet" ? " With no reference photo, include one natural-looking golden retriever beside the tree." : ""}`
			: `Create the scene without people. Do not reproduce a person from a reference.${settings.style === "pet" ? " Include one natural-looking golden retriever." : ""}`,
		style.scene,
		settings.mode === "photo" ? style.photoDirection : "",
		settings.mode === "photo"
			? settings.festiveOutfit
				? "For a person, add a simple festive knit sweater while preserving their identity. For a pet, add only a small festive bandana, leaving its face clear."
				: "Keep any reference subject's original clothing. Do not add a hat or cover the face."
			: "",
		"Render one continuous, coherent scene. Match the subject and setting in light direction, color temperature, perspective and scale. Add natural contact shadows at visible surfaces where they meet. Use natural edges and consistent photographic detail throughout.",
		"No text, lettering, watermark, logos, device frame, clock, interface or collage. Produce the artwork only.",
	]
		.filter(Boolean)
		.join(" ");
}

export const WALLPAPER_TARGETS = {
	phone: { width: 1080, height: 1920 },
	tall: { width: 1170, height: 2532 },
	desktop: { width: 1920, height: 1080 },
} as const;
export type WallpaperTarget = keyof typeof WALLPAPER_TARGETS | "original";

export type WallpaperCropSettings = {
	target: WallpaperTarget;
	x: number;
	y: number;
	zoom: number;
	overlay: boolean;
	darkClock: boolean;
};

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
	const output = target === "original" ? { width, height } : WALLPAPER_TARGETS[target];
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
