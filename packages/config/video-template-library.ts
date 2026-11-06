/** Browser-safe source choices. Source prompts, provider IDs and references stay server-only. */
export const SOURCE_TEMPLATE_KEYS = [
	"original-rap",
	"rap-orange-studio",
	"rap-street-cypher",
	"rap-neon-rap",
	"rap-funny-rap",
	"bulin-47",
	"source-hotel-lobby",
	"58th-floor",
	"green-booth-freestyle",
	"spin-me-round",
	"kung-fu-cat",
	"paws-at-you",
	"flying-car-curved-ramp-showcase",
	"flying-car-curved-ramp",
	"flying-car-fleet-side",
	"flying-car-fleet-front",
] as const;
export type SourceTemplateKey = (typeof SOURCE_TEMPLATE_KEYS)[number];
export type SourceTemplateRole = "performer-1" | "performer-2" | "performer-3" | "pet" | "subject";
export type SourceTemplateChoices = {
	tier?: "standard" | "fast" | "pro" | "ultra";
	preset?: "text" | "solo" | "duo" | "trio" | "person-pet" | "freestyle" | "pet";
	sceneId?: "empty-room" | "retro-neon";
	stageId?: "orange-studio" | "street-cypher" | "neon-rap" | "funny-rap";
	durationSeconds?: 5 | 6 | 7 | 8 | 9 | 10 | 12 | 15;
	resolution?: "480p" | "720p" | "1080p" | "768P" | "2K";
	aspectRatio?: "9:16" | "16:9" | "1:1" | "4:3" | "3:4" | "21:9" | "adaptive";
	direction?: string;
	locale?: "en" | "zh";
	customStage?: string;
	occasion?: string;
};
export const RAP_TEMPLATE_STYLES = [
	"orange-studio",
	"street-cypher",
	"neon-rap",
	"funny-rap",
] as const;
export const VIDEO_TEMPLATE_DIRECTORY_PATH = "/video-templates";
export function isSourceTemplateKey(key: unknown): key is SourceTemplateKey {
	return typeof key === "string" && SOURCE_TEMPLATE_KEYS.some((item) => item === key);
}
export function isRapTemplate(key: SourceTemplateKey) {
	return key === "original-rap" || key.startsWith("rap-");
}
export const FLYING_CAR_TEMPLATE_KEYS = [
	"flying-car-curved-ramp-showcase",
	"flying-car-curved-ramp",
	"flying-car-fleet-side",
	"flying-car-fleet-front",
] as const;
export const FLYING_CAR_DEFAULT_TEMPLATE_KEY = "flying-car-curved-ramp-showcase";
export function isFlyingCarTemplate(key: string): key is (typeof FLYING_CAR_TEMPLATE_KEYS)[number] {
	return FLYING_CAR_TEMPLATE_KEYS.some((templateKey) => templateKey === key);
}
export function sourceTemplateDefaults(key: SourceTemplateKey): SourceTemplateChoices {
	if (isFlyingCarTemplate(key))
		return {
			resolution: "768P",
			aspectRatio: "16:9",
			durationSeconds: key.includes("curved-ramp") ? 15 : 7,
		};
	if (isRapTemplate(key))
		return {
			tier: "standard",
			preset: key === "rap-neon-rap" ? "solo" : "duo",
			resolution: "720p",
			durationSeconds: 12,
			aspectRatio: "9:16",
			stageId:
				key === "original-rap"
					? "orange-studio"
					: (key.slice(4) as SourceTemplateChoices["stageId"]),
			locale: "en",
			direction: "",
			customStage: "",
			occasion: "",
		};
	if (key === "spin-me-round")
		return {
			tier: "standard",
			preset: "solo",
			sceneId: "empty-room",
			resolution: "720p",
			durationSeconds: 12,
			aspectRatio: "9:16",
		};
	if (key === "bulin-47") return { preset: "freestyle", durationSeconds: 15, aspectRatio: "9:16" };
	if (key === "source-hotel-lobby")
		return { preset: "duo", resolution: "768P", aspectRatio: "9:16" };
	if (key === "58th-floor")
		return { preset: "duo", resolution: "768P", durationSeconds: 15, aspectRatio: "9:16" };
	if (key === "green-booth-freestyle")
		return { preset: "duo", resolution: "768P", durationSeconds: 10, aspectRatio: "16:9" };
	return {
		preset: "pet",
		resolution: "768P",
		durationSeconds: key === "kung-fu-cat" ? 9 : 6,
		aspectRatio: "9:16",
	};
}
/** Reference order matches the source builders; pets are never silently converted to people. */
export function sourceTemplateRoles(
	key: SourceTemplateKey,
	choices: SourceTemplateChoices,
): SourceTemplateRole[] {
	if (isFlyingCarTemplate(key)) return ["subject"];
	if (isRapTemplate(key) && choices.preset === "text") return [];
	if (key === "kung-fu-cat" || key === "paws-at-you") return ["pet"];
	if (choices.preset === "person-pet") return ["performer-1", "pet"];
	if (key === "bulin-47" || choices.preset === "solo") return ["performer-1"];
	if (key === "spin-me-round" && choices.preset === "trio")
		return ["performer-1", "performer-2", "performer-3"];
	return ["performer-1", "performer-2"];
}
export function sourceTemplateOptionSets(key: SourceTemplateKey, choices: SourceTemplateChoices) {
	const flexible = isRapTemplate(key) || key === "spin-me-round";
	return {
		presets: (isFlyingCarTemplate(key)
			? []
			: isRapTemplate(key)
				? ["solo", "duo", "text"]
				: key === "spin-me-round"
					? ["solo", "duo", "trio"]
					: key === "58th-floor"
						? ["duo", "solo", "person-pet"]
						: [sourceTemplateDefaults(key).preset!]) as NonNullable<
			SourceTemplateChoices["preset"]
		>[],
		tiers: (flexible ? ["standard", "fast", "pro", "ultra"] : []) as NonNullable<
			SourceTemplateChoices["tier"]
		>[],
		durations: (flexible
			? [5, 8, 10, 12, 15]
			: sourceTemplateDefaults(key).durationSeconds
				? [sourceTemplateDefaults(key).durationSeconds!]
				: []) as NonNullable<SourceTemplateChoices["durationSeconds"]>[],
		resolutions: (flexible
			? choices.tier === "pro" || choices.tier === "ultra"
				? ["480p", "720p", "1080p"]
				: ["480p", "720p"]
			: key === "58th-floor" || key === "source-hotel-lobby" || isFlyingCarTemplate(key)
				? ["768P", "2K"]
				: sourceTemplateDefaults(key).resolution
					? [sourceTemplateDefaults(key).resolution!]
					: []) as NonNullable<SourceTemplateChoices["resolution"]>[],
		ratios: (flexible
			? choices.tier === "ultra" && choices.preset !== "text"
				? ["adaptive"]
				: ["9:16", "1:1", "16:9"]
			: key === "source-hotel-lobby"
				? ["9:16", "16:9", "1:1", "4:3", "3:4", "21:9", "adaptive"]
				: [sourceTemplateDefaults(key).aspectRatio!]) as NonNullable<
			SourceTemplateChoices["aspectRatio"]
		>[],
	};
}
export type PublicVideoTemplate = {
	key: SourceTemplateKey | "hotel-lobby" | "raindance" | "rumpelstiltskin" | "flying-car";
	name: string;
	category: "rap" | "dance" | "pets" | "cinematic";
	canonicalPath: string;
	inputLabel: "one" | "two" | "oneOrTwo" | "oneToThree" | "pet" | "optional" | "subject";
	audio: "source" | "silent" | "unknown";
	availability: "existing" | "pending" | "inventory";
	/** No invented acceptance/publication evidence. Source samples are labelled as source samples. */
	sample?: { poster: string; video: string; source: "ezrapvideo"; shared?: boolean };
};
const sourcePath = (key: SourceTemplateKey) => `${VIDEO_TEMPLATE_DIRECTORY_PATH}/${key}`;
/** Execution variants belong to one public Flying Car experience. Keep historical keys intact. */
export const FLYING_CAR_VARIANTS: readonly PublicVideoTemplate[] = FLYING_CAR_TEMPLATE_KEYS.map(
	(key) => {
		const pack = key.includes("curved-ramp")
			? "curved-ramp"
			: key === "flying-car-fleet-side"
				? "fleet-side"
				: "fleet-front";
		const names = {
			"flying-car-curved-ramp-showcase": "Curved Ramp · Featured",
			"flying-car-curved-ramp": "Curved Ramp",
			"flying-car-fleet-side": "Jump Over Fleet · Side",
			"flying-car-fleet-front": "Jump Over Fleet · Front",
		};
		return {
			key,
			name: names[key],
			category: "cinematic",
			canonicalPath: sourcePath(key),
			inputLabel: "subject",
			audio: "source",
			availability: "pending",
			sample: {
				poster: `https://ezairapvideo.com/flyingcar/templates/v1/${pack}/reference-04.jpg`,
				video: `https://ezairapvideo.com/flyingcar/templates/v1/${pack}/preview.mp4`,
				source: "ezrapvideo",
				shared: pack === "curved-ramp",
			},
		};
	},
);
export const VIDEO_TEMPLATE_LIBRARY: readonly PublicVideoTemplate[] = [
	{
		key: "original-rap",
		name: "Original Rap",
		category: "rap",
		canonicalPath: sourcePath("original-rap"),
		inputLabel: "optional",
		audio: "source",
		availability: "pending",
		sample: {
			poster: "https://ezairapvideo.com/rap/styles/orange-studio-hd.webp",
			video: "https://media.ezairapvideo.com/rap/styles/previews/orange-studio.mp4",
			source: "ezrapvideo",
		},
	},
	{
		key: "bulin-47",
		name: "Bulin 47",
		category: "rap",
		canonicalPath: sourcePath("bulin-47"),
		inputLabel: "one",
		audio: "source",
		availability: "pending",
		sample: {
			poster: "https://media.ezairapvideo.com/effects/bulin-47/bulin-47.jpg",
			video: "https://media.ezairapvideo.com/effects/bulin-47/bulin-47.mp4",
			source: "ezrapvideo",
		},
	},
	{
		key: "spin-me-round",
		name: "Spin Me Round",
		category: "dance",
		canonicalPath: sourcePath("spin-me-round"),
		inputLabel: "oneToThree",
		audio: "source",
		availability: "pending",
		sample: {
			poster: "https://ezairapvideo.com/effects/spin-me-round/trio-15s-v1.webp",
			video: "https://media.ezairapvideo.com/effects/spin-me-round/trio-15s-v1.mp4",
			source: "ezrapvideo",
		},
	},
	{
		key: "58th-floor",
		name: "58th Floor",
		category: "rap",
		canonicalPath: sourcePath("58th-floor"),
		inputLabel: "oneOrTwo",
		audio: "source",
		availability: "pending",
		sample: {
			poster:
				"https://media.ezairapvideo.com/effects/58th-floor/v1/0a2591616c40be6fabb2a293f5e478d153e0efaa12636a41a0e0b8e3e44134f8-duo-example.webp",
			video:
				"https://media.ezairapvideo.com/effects/58th-floor/v1/e7ef28c4269d6aa3526092dc4d16e9691838365ecec1cfd145b2fb72be32ff1c-duo-example.mp4",
			source: "ezrapvideo",
		},
	},
	{
		key: "green-booth-freestyle",
		name: "Green Booth Freestyle",
		category: "rap",
		canonicalPath: sourcePath("green-booth-freestyle"),
		inputLabel: "two",
		audio: "source",
		availability: "pending",
		sample: {
			poster:
				"https://media.ezairapvideo.com/effects/green-booth-freestyle-ai/green-booth-h3-v3/5197cf1a43da73b2d0407de13f6a8c1015ce654f2b6377dde2fc939aca51eae1-example-poster.webp",
			video:
				"https://media.ezairapvideo.com/effects/green-booth-freestyle-ai/green-booth-h3-v3/b6ed3c7d6ba7506be3a6be32ebed727b7c88c01e7aca684582ad9cad9e385250-green.mp4",
			source: "ezrapvideo",
		},
	},
	{
		key: "kung-fu-cat",
		name: "Kung Fu Cat",
		category: "pets",
		canonicalPath: sourcePath("kung-fu-cat"),
		inputLabel: "pet",
		audio: "source",
		availability: "pending",
		sample: {
			poster:
				"https://media.ezairapvideo.com/effects/kung-fu-cat-ai/kung-fu-cat-h3-v2/b050627d030550ff97e40d0bf0ac5ae3f168cb553cf85862d26f5274749c7e79-poster.webp",
			video:
				"https://media.ezairapvideo.com/effects/kung-fu-cat-ai/kung-fu-cat-h3-v2/bad4e5afda0bc69bffa8944e5ca5152b545fb52a6451217f2eca45f1ad5fc2cd-example-original-sfx.mp4",
			source: "ezrapvideo",
		},
	},
	{
		key: "paws-at-you",
		name: "Paws at You",
		category: "pets",
		canonicalPath: sourcePath("paws-at-you"),
		inputLabel: "pet",
		audio: "source",
		availability: "pending",
		sample: {
			poster:
				"https://media.ezairapvideo.com/effects/paws-at-you-ai/paws-at-you-h3-v2/fa8b042c598a493a187dd67a82b4752de307126b48536c66308101bd8dba9e4e-poster.webp",
			video:
				"https://media.ezairapvideo.com/effects/paws-at-you-ai/paws-at-you-h3-v2/3557c694d23741f9ea375d7a12c38f2fdcc9cb2329636d13ac578393decabe41-example-original-sfx.mp4",
			source: "ezrapvideo",
		},
	},
	{
		key: "source-hotel-lobby",
		name: "Hotel Lobby · Original",
		category: "rap",
		canonicalPath: sourcePath("source-hotel-lobby"),
		inputLabel: "two",
		audio: "source",
		availability: "pending",
		sample: {
			poster: "https://ezairapvideo.com/effects/hotel-lobby/example-2.jpg",
			video: "https://ezairapvideo.com/effects/hotel-lobby/example-2.mp4",
			source: "ezrapvideo",
		},
	},
	{
		key: "hotel-lobby",
		name: "Hotel Lobby · EzPic",
		category: "dance",
		canonicalPath: "/video-effects/hotel-lobby-ai",
		inputLabel: "two",
		audio: "silent",
		availability: "existing",
	},
	{
		key: "raindance",
		name: "Raindance",
		category: "dance",
		canonicalPath: "/blog/raindance-ai-trend",
		inputLabel: "oneOrTwo",
		audio: "silent",
		availability: "existing",
	},
	{
		key: "rumpelstiltskin",
		name: "Rumpelstiltskin",
		category: "dance",
		canonicalPath: "/video/effects/rumpelstiltskin",
		inputLabel: "one",
		audio: "silent",
		availability: "existing",
	},
	{
		...FLYING_CAR_VARIANTS[0]!,
		name: "Flying Car",
		canonicalPath: `${VIDEO_TEMPLATE_DIRECTORY_PATH}/flying-car`,
	},
];
export function getVideoTemplate(key: string): PublicVideoTemplate | undefined {
	if (key === "flying-car")
		return VIDEO_TEMPLATE_LIBRARY.find((item) => item.key === FLYING_CAR_DEFAULT_TEMPLATE_KEY);
	if (isFlyingCarTemplate(key)) return FLYING_CAR_VARIANTS.find((item) => item.key === key);
	const direct = VIDEO_TEMPLATE_LIBRARY.find((item) => item.key === key);
	if (direct) return direct;
	if (isSourceTemplateKey(key) && key.startsWith("rap-")) {
		const stage = key.slice(4) as (typeof RAP_TEMPLATE_STYLES)[number];
		const names = {
			"orange-studio": "Orange Studio",
			"street-cypher": "Street Cypher",
			"neon-rap": "Neon Rap",
			"funny-rap": "Funny Rap",
		};
		return {
			...VIDEO_TEMPLATE_LIBRARY[0]!,
			key,
			name: `Original Rap · ${names[stage]}`,
			canonicalPath: sourcePath(key),
			sample: {
				poster: `https://ezairapvideo.com/rap/styles/${stage}-hd.webp`,
				video: `https://media.ezairapvideo.com/rap/styles/previews/${stage}.mp4`,
				source: "ezrapvideo",
			},
		};
	}
}
export function videoTemplateDescriptionKey(
	template: PublicVideoTemplate,
): Exclude<PublicVideoTemplate["key"], `rap-${string}` | `flying-car-${string}`> {
	if (isFlyingCarTemplate(template.key)) return "flying-car";
	return template.key.startsWith("rap-")
		? "original-rap"
		: (template.key as Exclude<
				PublicVideoTemplate["key"],
				`rap-${string}` | `flying-car-${string}`
			>);
}
