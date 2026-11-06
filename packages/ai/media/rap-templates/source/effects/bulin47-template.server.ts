import { z } from "zod";

import { envConfigs } from "../boundary-config";
import {
	BULIN47_EFFECT_ID,
	BULIN47_PUBLIC_EXAMPLE,
	EFFECT_PRIVATE_CONFIG_KEY,
	effectTemplateSchema,
	type EffectTemplate,
	type PublicEffectTemplate,
} from "../effects";
import { rapCreditQuote, type RapGenerationConfig } from "../rap-generation";
import source from "./templates/bulin-h3-v1.json";

// The user-selected shipany-video-agent H3 prompt/assets, adapted only at the
// provider request boundary to this site's Seedance engine. Server imports only.
function assetBase(configs: Record<string, string>) {
	for (const candidate of [
		configs.app_url || envConfigs.app_url,
		configs.site_url || envConfigs.site_url,
	]) {
		if (effectTemplateSchema.shape.sceneImageUrl.safeParse(candidate).success) {
			return new URL("/effects/bulin-47/freestyle-v1/", candidate);
		}
	}
	throw new Error("EFFECT_ASSET_ORIGIN_INVALID");
}

export function defaultBulin47Template(configs: Record<string, string> = {}): EffectTemplate {
	const base = assetBase(configs);
	return {
		revision: "bulin47-freestyle-v1",
		enabled: true,
		modelId: "seedance-2-mini",
		resolution: "720p",
		prompt: source.input.prompt,
		sceneImageUrl: new URL("scene_clean.png", base).href,
		poseImageUrl: new URL("pose_left_arm_optional.png", base).href,
		referenceAudioUrl: new URL("reference_00-15s.wav", base).href,
		...BULIN47_PUBLIC_EXAMPLE,
	};
}

// Decode only the exact previous config shape. Never reuse the retired prompts
// or perform a database write while reading. Invalid saved config fails closed.
const legacyTemplateSchema = z
	.object({
		revision: effectTemplateSchema.shape.revision,
		enabled: effectTemplateSchema.shape.enabled,
		modelId: effectTemplateSchema.shape.modelId,
		resolution: effectTemplateSchema.shape.resolution,
		soloPrompt: effectTemplateSchema.shape.prompt,
		duoPrompt: effectTemplateSchema.shape.prompt,
		referenceImages: z.array(effectTemplateSchema.shape.sceneImageUrl).max(7),
		referenceAudio: z.array(effectTemplateSchema.shape.referenceAudioUrl).max(3),
		posterUrl: effectTemplateSchema.shape.posterUrl,
		previewUrl: effectTemplateSchema.shape.previewUrl,
		exampleSourceUrl: effectTemplateSchema.shape.exampleSourceUrl,
	})
	.strict()
	.refine(
		(value) =>
			![...value.referenceImages, ...value.referenceAudio].some((url) =>
				[value.posterUrl, value.previewUrl, value.exampleSourceUrl].includes(url),
			),
	);

export function readBulin47Template(configs: Record<string, string>) {
	const saved = configs[EFFECT_PRIVATE_CONFIG_KEY];
	if (!saved) return defaultBulin47Template(configs);
	const value: unknown = JSON.parse(saved);
	const current = effectTemplateSchema.safeParse(value);
	if (current.success) return current.data;
	const legacy = legacyTemplateSchema.parse(value);
	const defaults = defaultBulin47Template(configs);
	return effectTemplateSchema.parse({
		...defaults,
		revision: `${defaults.revision}:${legacy.revision}`.slice(0, 80),
		enabled: legacy.enabled,
		modelId: legacy.modelId,
		resolution: legacy.resolution,
		posterUrl: legacy.posterUrl,
		previewUrl: legacy.previewUrl,
		exampleSourceUrl: legacy.exampleSourceUrl,
	});
}

/** Explicit public projection, never spread the private configuration. */
export function publicBulin47Template(
	template: EffectTemplate,
	config: RapGenerationConfig,
): PublicEffectTemplate {
	const costCredits = rapCreditQuote(
		config,
		template.modelId,
		template.resolution,
		15,
		BULIN47_EFFECT_ID,
	);
	return {
		id: "bulin-47",
		revision: template.revision,
		enabled: template.enabled,
		ready: template.enabled && config.ready && config.imageReady && costCredits !== null,
		modelId: template.modelId,
		resolution: template.resolution,
		duration: 15,
		aspectRatio: "9:16",
		costCredits,
		posterUrl: template.posterUrl,
		previewUrl: template.previewUrl,
		exampleSourceUrl: template.exampleSourceUrl,
	};
}

export function resolveBulin47Input(template: EffectTemplate) {
	return {
		prompt: template.prompt,
		// Image 1 is added by seedanceBody from the owned, approved user portrait.
		// Image 2 supplies scene/supporting cast. Image 3 is optional pose guidance.
		referenceImages: [template.sceneImageUrl, template.poseImageUrl].filter(Boolean),
		referenceAudio: [template.referenceAudioUrl],
	};
}
