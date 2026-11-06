/** Private source execution contracts. Import browser choices from @repo/config instead. */
import type { SourceTemplateChoices, SourceTemplateKey } from "@repo/config/video-template-library";
import { z } from "zod";

import { readBulin47Template, resolveBulin47Input } from "./source/effects/bulin47-template.server";
import {
	floor58Body,
	readFloor58Template,
} from "./source/effects/fifty-eighth-floor-template.server";
import {
	readShortEffectTemplate,
	shortEffectBody,
} from "./source/effects/short-effects-template.server";
import { spinDanceBody } from "./source/effects/spin-dance-template.server";
import { floor58RequestSchema } from "./source/fifty-eighth-floor";
import { flyingCarBody, flyingCarTemplateIds } from "./source/flyingcar/request";
import { hotelLobbyRequestSchema } from "./source/hotel-lobby";
import { RAP_DEFAULT_DRAFT } from "./source/rap-draft";
import { rapGenerationSchema } from "./source/rap-generation";
import { hotelLobbyBody, seedanceBody } from "./source/seeapi-video";
import {
	SHORT_EFFECTS,
	shortEffectQuote,
	shortEffectRequestSchema,
	type ShortEffectId,
} from "./source/short-effects";
import { SPIN_DANCE_REVISION, spinDanceRequestSchema } from "./source/spin-dance";
import { getVideoTemplate } from "./source/video-templates";

export type { SourceTemplateChoices, SourceTemplateKey } from "@repo/config/video-template-library";
export type SourceTemplateRequestBody =
	| ReturnType<typeof seedanceBody>
	| ReturnType<typeof hotelLobbyBody>
	| ReturnType<typeof spinDanceBody>
	| ReturnType<typeof floor58Body>
	| ReturnType<typeof shortEffectBody>
	| ReturnType<typeof flyingCarBody>["body"];
export type ResolvedSourceTemplateRequest = {
	/** Omitted on historical snapshots; those retain the original prompt contract. */
	executionContract?: "prompt" | "provider-owned-template";
	provider: "seeapi" | "kie";
	modelId: string;
	endpoint: "text-to-video" | "image-to-video" | "reference-to-video" | "hotel-lobby-ai";
	body: SourceTemplateRequestBody;
	revision: string;
	prompt: string | null;
	/** Source identities only: target MUST bind approved private assets before dispatch. */
	requiredAssetUrls: string[];
	output: { durationSeconds: number | null; resolution: string; aspectRatio: string; sound: true };
};

const modelByTier = {
	standard: "seedance-2-mini",
	fast: "seedance-2-fast",
	pro: "seedance-2",
	ultra: "seedance-2-5",
} as const;
const shortIds = {
	"green-booth-freestyle": "green-booth-freestyle-ai",
	"kung-fu-cat": "kung-fu-cat-ai",
	"paws-at-you": "paws-at-you-ai",
} as const;
const stages = {
	"rap-orange-studio": "orange-studio",
	"rap-street-cypher": "street-cypher",
	"rap-neon-rap": "neon-rap",
	"rap-funny-rap": "funny-rap",
} as const;
const boundaryId = "00000000-0000-4000-8000-000000000001";
const imageSchema = z
	.url()
	.max(2048)
	.refine((value) => {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && !url.hash;
	});

function assertCount(images: readonly string[], min: number, max = min) {
	z.array(imageSchema).min(min).max(max).parse(images);
	if (new Set(images).size !== images.length) throw new Error("SOURCE_TEMPLATE_INPUT_INVALID");
}
function fixedChoice(value: unknown, expected: unknown) {
	if (value !== undefined && value !== expected) throw new Error("SOURCE_TEMPLATE_OPTIONS_INVALID");
}
function assertMaterial(values: string[]) {
	for (const raw of values) {
		let value = raw;
		try {
			for (let i = 0; i < 3; i++) {
				const next = decodeURIComponent(value);
				if (next === value) break;
				value = next;
			}
		} catch {
			throw new Error("EFFECT_NOT_READY");
		}
		if (
			/[{}<>]|__[^\s]*__|(?:^|[^a-z])(?:todo|tbd|placeholder|changeme)(?=$|[^a-z])|\b[a-z0-9.-]+\.invalid\b|(?:replace[\s_-]+(?:with|me)\b|your[_-]|your\s+(?:domain|url|asset|prompt))/i.test(
				value,
			)
		)
			throw new Error("EFFECT_NOT_READY");
	}
}

/** Build exactly the source request; this does not authorize, price, reserve or submit. */
export function resolveSourceTemplateRequest(args: {
	templateKey: SourceTemplateKey;
	options?: SourceTemplateChoices;
	userImageUrls: readonly string[];
	configs: Record<string, string>;
	callbackUrl?: string;
}): ResolvedSourceTemplateRequest {
	const { templateKey: key, userImageUrls: images, configs, callbackUrl } = args;
	const options = args.options ?? {};
	const portraits = {
		...(images[0] ? { imageUrl: images[0] } : {}),
		...(images[1] ? { secondImageUrl: images[1] } : {}),
		...(images[2] ? { thirdImageUrl: images[2] } : {}),
	};
	const common = { expectedCredits: 1, idempotencyKey: boundaryId };
	const settings = {
		modelId: modelByTier[options.tier ?? "standard"],
		resolution: options.resolution ?? "720p",
		duration: options.durationSeconds ?? 12,
		aspectRatio: options.aspectRatio ?? "9:16",
	};
	let body: SourceTemplateRequestBody;
	let revision: string;
	let requiredAssetUrls: string[] = [];
	let provider: "seeapi" | "kie" = "seeapi";
	if (key === "original-rap" || Object.prototype.hasOwnProperty.call(stages, key)) {
		assertCount(images, 0, 2);
		const { photos: _photos, ...defaults } = RAP_DEFAULT_DRAFT;
		const stageId =
			key === "original-rap"
				? (options.stageId ?? "orange-studio")
				: stages[key as keyof typeof stages];
		if (key !== "original-rap") fixedChoice(options.stageId, stageId);
		body = seedanceBody(
			rapGenerationSchema.parse({
				...defaults,
				...settings,
				...portraits,
				...common,
				mode: images.length ? "image" : "text",
				direction: options.direction ?? "",
				composition: {
					stageId,
					locale: options.locale ?? "en",
					...(options.customStage !== undefined ? { customStage: options.customStage } : {}),
					...(options.occasion !== undefined ? { occasion: options.occasion } : {}),
				},
			}),
			callbackUrl,
		);
		revision = "ezrapvideo-composition-v1";
	} else if (key === "bulin-47") {
		assertCount(images, 1);
		const template = readBulin47Template({ app_url: "https://ezairapvideo.com", ...configs });
		if (!template.enabled) throw new Error("EFFECT_NOT_READY");
		fixedChoice(options.durationSeconds, 15);
		fixedChoice(options.aspectRatio, "9:16");
		fixedChoice(options.preset, "freestyle");
		fixedChoice(options.resolution, template.resolution);
		if (options.tier !== undefined) fixedChoice(modelByTier[options.tier], template.modelId);
		const effect = resolveBulin47Input(template);
		requiredAssetUrls = [...effect.referenceImages, ...effect.referenceAudio];
		assertMaterial([effect.prompt, ...requiredAssetUrls]);
		body = seedanceBody(
			rapGenerationSchema.parse({
				mode: "image",
				modelId: template.modelId,
				resolution: template.resolution,
				duration: 15,
				aspectRatio: "9:16",
				performanceStyle: "studio",
				direction: "",
				...portraits,
				...common,
				effect: { id: "bulin-47", preset: "freestyle", revision: template.revision },
			}),
			callbackUrl,
			effect,
		);
		revision = template.revision;
	} else if (key === "spin-me-round") {
		const preset = options.preset ?? "solo";
		const checkedPreset = z.enum(["solo", "duo", "trio"]).parse(preset);
		assertCount(images, { solo: 1, duo: 2, trio: 3 }[checkedPreset]);
		const value = spinDanceRequestSchema.parse({
			templateId: "spin-me-round-dance-ai",
			preset,
			sceneId: options.sceneId ?? "empty-room",
			revision: SPIN_DANCE_REVISION,
			...settings,
			duration: options.durationSeconds ?? (preset === "trio" ? 15 : 12),
			...portraits,
			...common,
		});
		const spinBody = spinDanceBody(
			value,
			{ app_url: "https://ezairapvideo.com", ...configs },
			callbackUrl,
		);
		body = spinBody;
		requiredAssetUrls = [spinBody.input.reference_images[0]!];
		revision = SPIN_DANCE_REVISION;
	} else if (Object.prototype.hasOwnProperty.call(flyingCarTemplateIds, key)) {
		assertCount(images, 1);
		const templateId = flyingCarTemplateIds[key as keyof typeof flyingCarTemplateIds];
		const template = getVideoTemplate(templateId);
		fixedChoice(options.durationSeconds, template.duration);
		fixedChoice(options.aspectRatio, template.aspectRatio);
		if (
			options.tier !== undefined ||
			options.preset !== undefined ||
			options.sceneId !== undefined ||
			options.stageId !== undefined ||
			options.direction !== undefined ||
			options.customStage !== undefined ||
			options.occasion !== undefined ||
			options.locale !== undefined
		)
			throw new Error("SOURCE_TEMPLATE_OPTIONS_INVALID");
		const resolution = z.enum(["768P", "2K"]).parse(options.resolution ?? "768P");
		const resolved = flyingCarBody(
			{ templateId, imageUrl: images[0]!, resolution },
			{ app_url: "https://ezairapvideo.com", ...configs },
			callbackUrl,
		);
		body = resolved.body;
		revision = resolved.revision;
		requiredAssetUrls = resolved.requiredAssetUrls;
		provider = "kie";
	} else if (key === "source-hotel-lobby") {
		assertCount(images, 2);
		// The source endpoint does not accept a caller-defined duration or model.
		fixedChoice(options.preset, "duo");
		if (
			options.durationSeconds !== undefined ||
			options.tier !== undefined ||
			options.direction !== undefined ||
			options.customStage !== undefined ||
			options.occasion !== undefined ||
			options.locale !== undefined ||
			options.stageId !== undefined ||
			options.sceneId !== undefined
		)
			throw new Error("SOURCE_TEMPLATE_OPTIONS_INVALID");
		body = hotelLobbyBody(
			hotelLobbyRequestSchema.parse({
				templateId: "hotel-lobby-ai",
				...portraits,
				...common,
				resolution: options.resolution ?? "768P",
				aspectRatio: options.aspectRatio ?? "9:16",
			}),
			callbackUrl,
		);
		revision = "ezrapvideo-hotel-lobby-endpoint-v1";
	} else if (key === "58th-floor") {
		const template = readFloor58Template(configs);
		if (!template.enabled) throw new Error("EFFECT_NOT_READY");
		fixedChoice(options.durationSeconds, 15);
		fixedChoice(options.aspectRatio, "9:16");
		if (options.tier !== undefined) throw new Error("SOURCE_TEMPLATE_OPTIONS_INVALID");
		const value = floor58RequestSchema.parse({
			templateId: "58th-floor-ai",
			preset: options.preset ?? "duo",
			revision: template.revision,
			...portraits,
			...common,
			duration: 15,
			aspectRatio: "9:16",
			resolution: options.resolution ?? "768P",
		});
		body = floor58Body(value, configs, callbackUrl);
		requiredAssetUrls = [
			template.sceneImageUrl,
			template.poseImageUrl,
			template.closeupImageUrl,
			template.referenceAudioUrl,
		];
		assertMaterial([body.input.prompt, ...requiredAssetUrls]);
		provider = "kie";
		revision = template.revision;
	} else if (Object.prototype.hasOwnProperty.call(shortIds, key)) {
		const id: ShortEffectId = shortIds[key as keyof typeof shortIds];
		const effect = SHORT_EFFECTS[id];
		assertCount(images, effect.photoCount);
		fixedChoice(options.durationSeconds, effect.duration);
		fixedChoice(options.aspectRatio, effect.aspectRatio);
		fixedChoice(options.resolution, effect.resolution);
		fixedChoice(options.preset, effect.preset);
		if (options.tier !== undefined) throw new Error("SOURCE_TEMPLATE_OPTIONS_INVALID");
		const template = readShortEffectTemplate(id, configs);
		// Source quote exists only to satisfy its original request invariant. It never
		// leaves this module and must never become the target account's retail quote.
		const sourceCredits = shortEffectQuote(id, configs);
		const value = shortEffectRequestSchema.parse({
			templateId: id,
			preset: effect.preset,
			revision: template.revision,
			duration: effect.duration,
			resolution: effect.resolution,
			aspectRatio: effect.aspectRatio,
			...portraits,
			...common,
			expectedCredits: sourceCredits,
			consentVersion: "short-effects-v1",
		});
		body = shortEffectBody(value, configs, callbackUrl);
		requiredAssetUrls = [
			...body.input.reference_image_urls.slice(images.length),
			...body.input.reference_audio_urls,
		];
		provider = "kie";
		revision = template.revision;
	} else throw new Error("SOURCE_TEMPLATE_UNAVAILABLE");
	const input = body.input;
	return {
		executionContract: key === "source-hotel-lobby" ? "provider-owned-template" : "prompt",
		provider,
		modelId: "model" in body ? body.model : "hotel-lobby-ai",
		endpoint:
			"endpoint" in body
				? body.endpoint
				: provider === "kie"
					? "reference-to-video"
					: "hotel-lobby-ai",
		body,
		revision,
		prompt: "prompt" in input ? input.prompt : null,
		requiredAssetUrls,
		output: {
			durationSeconds:
				"duration_seconds" in input
					? input.duration_seconds
					: "duration" in input
						? input.duration
						: null,
			resolution: input.resolution,
			aspectRatio: input.aspect_ratio,
			sound: true,
		},
	};
}
