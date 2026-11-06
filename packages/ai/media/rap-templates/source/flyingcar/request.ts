import { z } from "zod";

import { KIE_H3_REFERENCE_MODEL, KIE_H3_RESOLUTIONS } from "../kie-constants";
import { getVideoTemplate, type VideoTemplateId } from "../video-templates";
import { getH3ReferenceAssets, getVideoPrompt, getVideoPromptVersion } from "./video-prompt";

/** Public keys map to the exact source template identities, including V5 vs V6. */
export const flyingCarTemplateIds = {
	"flying-car-curved-ramp-showcase": "curved-ramp-showcase",
	"flying-car-curved-ramp": "curved-ramp",
	"flying-car-fleet-side": "fleet-side",
	"flying-car-fleet-front": "fleet-front",
} as const satisfies Record<string, VideoTemplateId>;

/** Exact request assembly from source video.ts:395-405,438-452 and kie.ts:379-405. */
export function flyingCarBody(
	input: {
		templateId: VideoTemplateId;
		imageUrl: string;
		resolution: "768P" | "2K";
	},
	configs: Record<string, string>,
	callbackUrl?: string,
) {
	const template = getVideoTemplate(input.templateId);
	const imageUrl = z
		.url()
		.max(2048)
		.refine((value) => {
			const url = new URL(value);
			return url.protocol === "https:" && !url.username && !url.password && !url.hash;
		})
		.parse(input.imageUrl);
	const resolution = z.enum(KIE_H3_RESOLUTIONS).parse(input.resolution);
	const assets = getH3ReferenceAssets(configs, template.id);
	if (!assets) throw new Error("EFFECT_NOT_READY");
	return {
		body: {
			model: KIE_H3_REFERENCE_MODEL,
			...(callbackUrl ? { callBackUrl: callbackUrl } : {}),
			input: {
				prompt: getVideoPrompt(template.id),
				reference_image_urls: [imageUrl, ...assets.images],
				reference_audio_urls: [assets.audio],
				duration: template.duration,
				aspect_ratio: template.aspectRatio,
				resolution,
			},
		},
		revision: getVideoPromptVersion(template.id),
		requiredAssetUrls: [...assets.images, assets.audio],
	};
}
