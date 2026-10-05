import { z } from "zod";

import { DEFAULT_PRODUCT_CONFIG } from "./product";
import {
	HOTEL_LOBBY_EFFECT_ID,
	videoEffectRequestSchema,
	type VideoEffectRequest,
} from "./video-effects";
import { isVideoModelOptionAllowed, readVideoModelAccess } from "./video-model-access";
import { createVideoAudioSafetyPolicy } from "./video-output";
import {
	calculateVideoRetailPrice,
	resolveVideoModelCostBasis,
	type VideoCostPolicy,
} from "./video-pricing.server";

export const HOTEL_LOBBY_TEMPLATE_VERSION = "hotel-lobby-duo-2026-10-05.1";
export const HOTEL_LOBBY_PRICE_VERSION = "hotel-lobby-duo-cost-2026-10-05.2";
export const HOTEL_LOBBY_SAFETY_POLICY_VERSION = "hotel-lobby-duo-safety-2026-10-05.1";
/** Revenue must cover three times complete budgeted cost, including payment fees. */
export const HOTEL_LOBBY_MINIMUM_MARKUP_BPS = 20_000n;
export const HOTEL_LOBBY_MINIMUM_PAYMENT_FEE_BPS = 750n;

// Prompts are internal and frozen in each accepted order. Do not import this module in clients.
const scenePrompt = `Create one original continuous portrait-oriented orange recording-studio scene.
Reference image 1 defines the LEFT performer. Reference image 2 defines the RIGHT performer.
Keep their facial features and visible identity differences distinct. Show exactly two adult
performers with clear space between them and one suspended microphone between them. Use a clean
seamless orange background and soft studio lighting. Keep faces, heads and hands within the frame
with room for movement. This is a single scene, not a collage or split-screen. Do not add a third
person, text, logos or captions. Do not imitate any named artist's identity. Do not swap identities.`;
const motionPrompt = `Animate this exact two-person scene as a short original performance. Keep the
left performer on the left and the right performer on the right. Maintain a fixed camera and
continuous framing. The left performer makes a brief rhythmic gesture while the right reacts,
then the right leads while the left reacts. Use restrained natural motion. Keep both faces visible.
No cuts, identity swaps, merging faces, extra people, mirrored synchronized gestures or large
overlapping gestures. Preserve the orange studio and the single hanging microphone. Silent video.`;

const version = z.string().min(1).max(120);
/** Add historical versions explicitly when introducing a new execution contract. Never re-resolve defaults. */
export const videoEffectTemplateSnapshotSchema = z
	.object({
		schemaVersion: z.literal(1),
		effectId: z.literal(HOTEL_LOBBY_EFFECT_ID),
		presetKey: z.literal("standard"),
		templateVersion: z.literal(HOTEL_LOBBY_TEMPLATE_VERSION),
		safetyPolicyVersion: z.literal(HOTEL_LOBBY_SAFETY_POLICY_VERSION),
		preprocessingVersion: z.literal("sealed-upload-2026-10-05.1"),
		scene: z
			.object({
				productKey: z.literal("nano-banana-2-lite-1k"),
				aspectRatio: z.literal("9:16"),
				outputCount: z.literal(1),
				prompt: z.string().min(1).max(10000),
				promptVersion: version,
				maxOutputBytes: z.literal(10_000_000),
			})
			.strict(),
		video: z
			.object({
				productKey: z.literal("video-seedance-1-5-pro"),
				mode: z.literal("image-to-video"),
				duration: z.literal(5),
				resolution: z.literal("720p"),
				aspectRatio: z.literal("9:16"),
				sound: z.literal(false),
				prompt: z.string().min(1).max(10000),
				promptVersion: version,
				fixedLens: z.literal(true),
			})
			.strict(),
		output: z
			.object({
				durationSeconds: z.literal(5),
				resolution: z.literal("720p"),
				width: z.literal(720),
				height: z.literal(1280),
				aspectRatio: z.literal("9:16"),
				sound: z.literal(false),
			})
			.strict(),
		storage: z
			.object({
				sceneMaximumBytes: z.literal(20_000_000),
				sceneRetentionSeconds: z.literal(2_592_000),
				videoMaximumBytes: z.literal(104_857_600),
			})
			.strict(),
	})
	.strict();
export type VideoEffectTemplateConfig = z.infer<typeof videoEffectTemplateSnapshotSchema>;

/** Pure construction only. Admission must separately enforce current readiness and cost approvals. */
export function createVideoEffectTemplateSnapshot(
	request: VideoEffectRequest,
): VideoEffectTemplateConfig {
	videoEffectRequestSchema.parse(request);
	return videoEffectTemplateSnapshotSchema.parse({
		schemaVersion: 1,
		effectId: HOTEL_LOBBY_EFFECT_ID,
		presetKey: "standard",
		templateVersion: HOTEL_LOBBY_TEMPLATE_VERSION,
		safetyPolicyVersion: HOTEL_LOBBY_SAFETY_POLICY_VERSION,
		preprocessingVersion: "sealed-upload-2026-10-05.1",
		scene: {
			productKey: "nano-banana-2-lite-1k",
			aspectRatio: "9:16",
			outputCount: 1,
			prompt: scenePrompt,
			promptVersion: "hotel-lobby-scene-2026-10-05.1",
			maxOutputBytes: 10_000_000,
		},
		video: {
			productKey: "video-seedance-1-5-pro",
			mode: "image-to-video",
			duration: 5,
			resolution: "720p",
			aspectRatio: "9:16",
			sound: false,
			prompt: motionPrompt,
			promptVersion: "hotel-lobby-motion-2026-10-05.1",
			fixedLens: true,
		},
		output: {
			durationSeconds: 5,
			resolution: "720p",
			width: 720,
			height: 1280,
			aspectRatio: "9:16",
			sound: false,
		},
		storage: {
			// Source and normalized private scene can coexist until physical cleanup.
			sceneMaximumBytes: 20_000_000,
			sceneRetentionSeconds: DEFAULT_PRODUCT_CONFIG.retention.inputDays * 86_400,
			videoMaximumBytes: 104_857_600,
		},
	});
}

export function parseVideoEffectTemplateSnapshot(value: unknown): VideoEffectTemplateConfig {
	const parsed = videoEffectTemplateSnapshotSchema.safeParse(value);
	if (!parsed.success) throw new Error("VIDEO_EFFECT_TEMPLATE_SNAPSHOT_INVALID");
	return parsed.data;
}

export function resolveVideoEffectTemplate(
	request: VideoEffectRequest,
	env: Record<string, string | undefined>,
): VideoEffectTemplateConfig {
	const template = createVideoEffectTemplateSnapshot(request);
	if (env.HOTEL_LOBBY_DUO_ENABLED !== "true") throw new Error("VIDEO_EFFECT_DISABLED");
	if (env.HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION !== template.templateVersion)
		throw new Error("VIDEO_EFFECT_TEMPLATE_NOT_CONFIRMED");
	const access = readVideoModelAccess(env);
	if (!isVideoModelOptionAllowed(access, template.video))
		throw new Error(access.reason ?? "VIDEO_MODEL_OPTION_NOT_ENABLED");
	return template;
}

function costSetting(
	env: Record<string, string | undefined>,
	key: string,
	allowZero = false,
): bigint {
	const value = env[key];
	if (!value || !/^\d{1,14}$/.test(value) || (!allowZero && BigInt(value) === 0n))
		throw new Error("VIDEO_EFFECT_COST_POLICY_NOT_CONFIGURED");
	return BigInt(value);
}

/** One full-cost calculation, one payment allocation and one failure budget for both paid stages. */
export function resolveVideoEffectPrice(
	request: VideoEffectRequest,
	env: Record<string, string | undefined>,
) {
	const template = resolveVideoEffectTemplate(request, env);
	if (
		env.HOTEL_LOBBY_DUO_PRICE_VERSION !== HOTEL_LOBBY_PRICE_VERSION ||
		!env.HOTEL_LOBBY_DUO_PRICE_BASIS?.trim()
	)
		throw new Error("VIDEO_EFFECT_PRICE_NOT_APPROVED");
	if (env.HOTEL_LOBBY_DUO_COST_POLICY_VERSION !== template.safetyPolicyVersion)
		throw new Error("VIDEO_EFFECT_COST_POLICY_NOT_CONFIRMED");
	const approvedValidUntil = Date.parse(env.HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL ?? "");
	if (!Number.isFinite(approvedValidUntil) || approvedValidUntil <= Date.now())
		throw new Error("VIDEO_EFFECT_PRICE_EXPIRED");
	const basis = resolveVideoModelCostBasis(template.video, env);
	const paymentCostBasis = env.HOTEL_LOBBY_DUO_PAYMENT_COST_BASIS?.trim();
	if (!paymentCostBasis) throw new Error("VIDEO_EFFECT_PAYMENT_COST_NOT_CONFIRMED");
	const markupBps =
		env.HOTEL_LOBBY_DUO_PRICE_MARKUP_BPS === undefined
			? HOTEL_LOBBY_MINIMUM_MARKUP_BPS
			: costSetting(env, "HOTEL_LOBBY_DUO_PRICE_MARKUP_BPS");
	const templatePaymentFeeBps =
		env.HOTEL_LOBBY_DUO_PAYMENT_FEE_BPS === undefined
			? HOTEL_LOBBY_MINIMUM_PAYMENT_FEE_BPS
			: costSetting(env, "HOTEL_LOBBY_DUO_PAYMENT_FEE_BPS");
	if (
		markupBps < HOTEL_LOBBY_MINIMUM_MARKUP_BPS ||
		markupBps > 100_000n ||
		templatePaymentFeeBps < HOTEL_LOBBY_MINIMUM_PAYMENT_FEE_BPS ||
		templatePaymentFeeBps >= 10_000n
	)
		throw new Error("VIDEO_EFFECT_PRICING_TARGET_INVALID");
	if (
		env.HOTEL_LOBBY_DUO_TEXT_COST_RULE_VERSION !== basis.textSafetyProfile.ruleVersion ||
		!env.HOTEL_LOBBY_DUO_TEXT_COST_BASIS?.trim()
	)
		throw new Error("VIDEO_EFFECT_TEXT_COST_NOT_CONFIRMED");
	// Both actual prompts are reviewed. A free tariff is valid only with explicit, expiring evidence.
	// Retain the existing video base budget conservatively; never guess a subtraction for old text cost.
	const textReviewCostMicros =
		2n * costSetting(env, "HOTEL_LOBBY_DUO_TEXT_REVIEW_COST_MICROS", true);
	const sceneProviderCostMicros = costSetting(env, "HOTEL_LOBBY_DUO_SCENE_PROVIDER_COST_MICROS");
	const inputReviewCostMicros = 2n * costSetting(env, "HOTEL_LOBBY_DUO_INPUT_REVIEW_COST_MICROS");
	const sceneReviewCostMicros = costSetting(env, "HOTEL_LOBBY_DUO_SCENE_REVIEW_COST_MICROS");
	const additionalRuntimeCostMicros = costSetting(
		env,
		"HOTEL_LOBBY_DUO_ADDITIONAL_RUNTIME_COST_MICROS",
	);
	const additionalStorageCostMicros = costSetting(
		env,
		"HOTEL_LOBBY_DUO_ADDITIONAL_STORAGE_COST_MICROS",
	);
	const policy: VideoCostPolicy = {
		...basis.policy,
		// Template approval cannot weaken an already higher payment-cost allowance.
		paymentFeeBps:
			templatePaymentFeeBps > basis.policy.paymentFeeBps
				? templatePaymentFeeBps
				: basis.policy.paymentFeeBps,
		markupBps,
		moderationBaseMicros:
			basis.policy.moderationBaseMicros +
			inputReviewCostMicros +
			sceneReviewCostMicros +
			textReviewCostMicros,
		runtimeMicros: basis.policy.runtimeMicros + additionalRuntimeCostMicros,
		storageMicros: basis.policy.storageMicros + additionalStorageCostMicros,
	};
	const providerCostMicros = basis.providerCostMicros + sceneProviderCostMicros;
	const result = calculateVideoRetailPrice({
		providerCostMicros,
		duration: template.video.duration,
		sound: false,
		policy,
	});
	const serializedResult = Object.fromEntries(
		Object.entries(result).map(([key, value]) => [key, value.toString()]),
	) as { [Key in keyof typeof result]: string };
	return {
		credits: result.credits,
		pricingVersion: HOTEL_LOBBY_PRICE_VERSION,
		pricingBasis: env.HOTEL_LOBBY_DUO_PRICE_BASIS.trim(),
		providerCostMicros,
		moderationCostMicros: result.moderationCostMicros,
		paidFundingPolicy: { minimumUsdMicrosPerCredit: result.creditFloorMicros },
		pricingDetails: {
			kind: "video-effect" as const,
			effectId: template.effectId,
			templateVersion: template.templateVersion,
			presetKey: template.presetKey,
			safetyPolicyVersion: template.safetyPolicyVersion,
			videoPricingVersion: basis.pricingVersion,
			videoPricingBasis: basis.pricingBasis,
			visualPolicyVersion: basis.visualSafetyProfile.policyVersion,
			textRuleVersion: basis.textSafetyProfile.ruleVersion,
			textCostBasis: env.HOTEL_LOBBY_DUO_TEXT_COST_BASIS.trim(),
			textReviewCount: 2,
			paymentCostBasis,
			templatePaymentFeeBps: templatePaymentFeeBps.toString(),
			minimumRevenueToCostBps: (10_000n + markupBps).toString(),
			audioSafetyPolicy: createVideoAudioSafetyPolicy(),
			validUntil: new Date(Math.min(approvedValidUntil, basis.validUntil)).toISOString(),
			costComponents: {
				sceneProviderCostMicros: sceneProviderCostMicros.toString(),
				videoProviderCostMicros: basis.providerCostMicros.toString(),
				inputReviewCostMicros: inputReviewCostMicros.toString(),
				sceneReviewCostMicros: sceneReviewCostMicros.toString(),
				textReviewCostMicros: textReviewCostMicros.toString(),
				inheritedVideoModerationBudgetMicros: (
					basis.policy.moderationBaseMicros +
					BigInt(template.video.duration) * basis.policy.moderationPerSecondMicros
				).toString(),
				additionalRuntimeCostMicros: additionalRuntimeCostMicros.toString(),
				additionalStorageCostMicros: additionalStorageCostMicros.toString(),
			},
			costPolicy: Object.fromEntries(
				Object.entries(policy).map(([key, value]) => [key, value.toString()]),
			),
			...serializedResult,
		},
	};
}
