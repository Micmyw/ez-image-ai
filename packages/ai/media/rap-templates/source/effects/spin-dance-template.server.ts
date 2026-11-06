import { envConfigs } from "../boundary-config";
import { rapImageUrls } from "../rap-generation";
import {
	SPIN_DANCE_SCENE_IMAGES,
	spinDanceRequestSchema,
	type SpinDanceInput,
	type SpinDancePreset,
	type SpinDanceScene,
	type SpinDanceSettings,
} from "../spin-dance";
import source from "./templates/spin-me-round-v2.json";

// Source prompts remain verbatim. Adapt only the user-selected audio, lighting,
// duration and framing at the provider boundary; preserve choreography and identities.
export const SPIN_SOURCE_AUDIO =
	"No dialogue or lip-sync; the final original music will be added afterward.";
export const SPIN_GENERATED_AUDIO =
	"No dialogue, vocals or lip-sync. Generate an original sped-up synth-pop instrumental soundtrack with bright synths and a playful, energetic dance beat; do not reproduce any existing song, melody or recording. Users may replace the soundtrack afterward.";

const sourceLighting: Record<SpinDancePreset, string> = {
	solo: "Use the room from Image 1 with bright, even light and a casual phone-video look.",
	duo: "Use the room from Image 1 with bright, even phone-video lighting.",
	trio: "Use the room from Image 1 with bright, even light and a natural phone-video look.",
};
export const SPIN_NEON_LIGHTING =
	"Use the retro neon disco room from Image 1, preserving its colorful metallic streamers, overhead disco balls and tiled dance floor. Keep the neon lighting steady with soft neutral fill so faces stay clearly readable, and retain a natural phone-video look.";

export function spinDancePrompt(
	preset: SpinDancePreset,
	sceneId: SpinDanceScene = "empty-room",
	settings?: Pick<SpinDanceSettings, "duration" | "aspectRatio">,
) {
	let prompt = source[preset].replace(SPIN_SOURCE_AUDIO, SPIN_GENERATED_AUDIO);
	if (sceneId === "retro-neon") prompt = prompt.replace(sourceLighting[preset], SPIN_NEON_LIGHTING);
	if (settings) {
		const originalDuration = preset === "trio" ? 15 : 12;
		if (settings.duration !== originalDuration) {
			const scale = settings.duration / originalDuration;
			const time = (value: string) => String(Math.round(Number(value) * scale * 100) / 100);
			prompt = prompt
				.replace(`Create a ${originalDuration}-second`, `Create a ${settings.duration}-second`)
				.replace(
					/\b(\d+(?:\.\d+)?)–(\d+(?:\.\d+)?)s:/g,
					(_, start: string, end: string) => `${time(start)}–${time(end)}s:`,
				)
				.replace(
					/(?:final|last) half-second/g,
					(match) => `${match.startsWith("final") ? "final" : "last"} ${time("0.5")} seconds`,
				);
		}
		if (settings.aspectRatio !== "9:16") {
			const framing =
				settings.aspectRatio === "adaptive"
					? "automatically framed"
					: settings.aspectRatio === "16:9"
						? "horizontal 16:9"
						: "square 1:1";
			prompt = prompt.replace("vertical 9:16", framing);
		}
	}
	return prompt;
}

export function spinDanceSceneUrl(
	configs: Record<string, string>,
	sceneId: SpinDanceScene = "empty-room",
) {
	for (const candidate of [
		configs.app_url || envConfigs.app_url,
		configs.site_url || envConfigs.site_url,
	]) {
		try {
			const url = new URL(candidate);
			if (
				url.protocol === "https:" &&
				!url.username &&
				!url.password &&
				!url.hash &&
				/\.[a-z]{2,63}$/i.test(url.hostname) &&
				!/\.(localhost|local|internal)$/i.test(url.hostname)
			) {
				return new URL(SPIN_DANCE_SCENE_IMAGES[sceneId], url).href;
			}
		} catch {
			/* Try the configured canonical origin. */
		}
	}
	throw new Error("EFFECT_ASSET_ORIGIN_INVALID");
}

export function spinDanceBody(
	input: SpinDanceInput,
	configs: Record<string, string>,
	callbackUrl?: string,
) {
	const value = spinDanceRequestSchema.parse(input);
	return {
		model: value.modelId,
		endpoint: "reference-to-video" as const,
		provider: "seeapi" as const,
		...(callbackUrl ? { callback_url: callbackUrl } : {}),
		input: {
			prompt: spinDancePrompt(value.preset, value.sceneId, value),
			// Numbering is part of the user's prompt: room first, then A / B / C.
			reference_images: [spinDanceSceneUrl(configs, value.sceneId), ...rapImageUrls(value)],
			aspect_ratio: value.aspectRatio,
			duration_seconds: value.duration,
			resolution: value.resolution,
			generate_audio: true,
			nsfw_checker: true,
		},
	};
}
