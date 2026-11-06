import { GREEN_BOOTH_PRIVATE_CONFIG_KEY, greenBoothTemplateSchema } from "../green-booth-template";
import { KIE_H3_REFERENCE_MODEL } from "../kie-constants";
import { PET_EFFECT_TEMPLATE_KEYS, petEffectTemplateSchema } from "../pet-effect-template";
import {
	isShortEffectId,
	SHORT_EFFECTS,
	shortEffectQuote,
	shortEffectRequestSchema,
	type ShortEffectId,
	type ShortEffectInput,
} from "../short-effects";

function hasPlaceholder(value: string): boolean {
	let decoded = value;
	try {
		for (let i = 0; i < 3; i++) {
			const next = decodeURIComponent(decoded);
			if (next === decoded) break;
			decoded = next;
		}
	} catch {
		return true;
	}
	return /[{}<>]|__[^\s]*__|(?:^|[^a-z])(?:todo|tbd|placeholder|changeme)(?=$|[^a-z])|\b[a-z0-9.-]+\.invalid\b|(?:replace[\s_-]*(?:with|me)|your[_-]|your\s+(?:domain|url|asset|prompt))/i.test(
		decoded,
	);
}

export function readGreenBoothTemplate(configs: Record<string, string>) {
	const saved = configs[GREEN_BOOTH_PRIVATE_CONFIG_KEY];
	if (!saved) throw new Error("EFFECT_TEMPLATE_NOT_CONFIGURED");
	return greenBoothTemplateSchema.parse(JSON.parse(saved));
}

export function readShortEffectTemplate(id: ShortEffectId, configs: Record<string, string>) {
	if (id === "green-booth-freestyle-ai") return readGreenBoothTemplate(configs);
	if (!isShortEffectId(id)) throw new Error("EFFECT_NOT_READY");
	const saved = configs[PET_EFFECT_TEMPLATE_KEYS[id]];
	if (!saved) throw new Error("EFFECT_TEMPLATE_NOT_CONFIGURED");
	return petEffectTemplateSchema.parse(JSON.parse(saved));
}

function resolveTemplate(id: ShortEffectId, configs: Record<string, string>) {
	if (!isShortEffectId(id)) throw new Error("EFFECT_NOT_READY");
	const effect = SHORT_EFFECTS[id];
	if (configs[effect.enabledKey] !== "true" || shortEffectQuote(id, configs) === null)
		throw new Error("EFFECT_NOT_READY");
	const saved = readShortEffectTemplate(id, configs);
	const referenceImages = [
		saved.sceneImageUrl,
		saved.poseImageUrl,
		...(id === "green-booth-freestyle-ai" ? [saved.endPoseImageUrl] : []),
	];
	if (
		!saved.enabled ||
		!saved.assetsVerified ||
		[saved.prompt, saved.rightsManifest, ...referenceImages, saved.referenceAudioUrl].some(
			hasPlaceholder,
		)
	)
		throw new Error("EFFECT_NOT_READY");
	return {
		template: saved,
		referenceImages,
		referenceAudio: saved.referenceAudioUrl,
	};
}

export function shortEffectTemplateReady(
	id: ShortEffectId,
	configs: Record<string, string>,
): boolean {
	try {
		resolveTemplate(id, configs);
		return true;
	} catch {
		return false;
	}
}

export function shortEffectBody(
	input: ShortEffectInput,
	configs: Record<string, string>,
	callbackUrl?: string,
) {
	const value = shortEffectRequestSchema.parse(input);
	let resolved: ReturnType<typeof resolveTemplate>;
	try {
		resolved = resolveTemplate(value.templateId, configs);
	} catch {
		throw new Error("EFFECT_NOT_READY");
	}
	if (value.revision !== resolved.template.revision) throw new Error("EFFECT_REVISION_CHANGED");
	const effect = SHORT_EFFECTS[value.templateId];
	if (value.duration !== effect.duration || value.aspectRatio !== effect.aspectRatio)
		throw new Error("EFFECT_REVISION_CHANGED");
	if (value.expectedCredits !== shortEffectQuote(value.templateId, configs))
		throw new Error("EFFECT_QUOTE_CHANGED");
	return {
		model: KIE_H3_REFERENCE_MODEL,
		...(callbackUrl ? { callBackUrl: callbackUrl } : {}),
		input: {
			prompt: resolved.template.prompt,
			reference_image_urls: [
				value.imageUrl,
				...(value.secondImageUrl ? [value.secondImageUrl] : []),
				...resolved.referenceImages,
			],
			reference_audio_urls: [resolved.referenceAudio],
			duration: value.duration,
			aspect_ratio: value.aspectRatio,
			resolution: value.resolution,
		},
	};
}

export type ShortEffectBody = ReturnType<typeof shortEffectBody>;
