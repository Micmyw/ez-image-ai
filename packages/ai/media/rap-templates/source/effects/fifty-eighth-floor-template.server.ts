import { floor58RequestSchema, type Floor58Input } from "../fifty-eighth-floor";
import { FLOOR58_PRIVATE_CONFIG_KEY, floor58TemplateSchema } from "../floor58-template";
import { KIE_H3_REFERENCE_MODEL } from "../kie-constants";

export function readFloor58Template(configs: Record<string, string>) {
	const saved = configs[FLOOR58_PRIVATE_CONFIG_KEY];
	if (!saved) throw new Error("EFFECT_TEMPLATE_NOT_CONFIGURED");
	return floor58TemplateSchema.parse(JSON.parse(saved));
}

export function floor58Body(
	input: Floor58Input,
	configs: Record<string, string>,
	callbackUrl?: string,
) {
	const value = floor58RequestSchema.parse(input);
	const template = readFloor58Template(configs);
	return {
		model: KIE_H3_REFERENCE_MODEL,
		...(callbackUrl ? { callBackUrl: callbackUrl } : {}),
		input: {
			prompt: template.prompts[value.preset],
			reference_image_urls: [
				value.imageUrl,
				...(value.secondImageUrl ? [value.secondImageUrl] : []),
				template.sceneImageUrl,
				template.poseImageUrl,
				template.closeupImageUrl,
			],
			reference_audio_urls: [template.referenceAudioUrl],
			duration: value.duration,
			aspect_ratio: value.aspectRatio,
			resolution: value.resolution,
		},
	};
}

export type Floor58Body = ReturnType<typeof floor58Body>;
