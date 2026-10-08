import { z } from "zod";

import { DEFAULT_PRODUCT_CONFIG } from "./product";
import {
	approvedRumpelstiltskinMotionReferenceSchema,
	readApprovedRumpelstiltskinMotionReference,
	readRumpelstiltskinCostApproval,
	RUMPELSTILTSKIN_TEMPLATE_VERSION,
	RUMPELSTILTSKIN_SAFETY_POLICY_VERSION,
} from "./rumpelstiltskin-reference.server";
import {
	HOTEL_LOBBY_EFFECT_ID,
	RAINDANCE_DUO_EFFECT_ID,
	RAINDANCE_SOLO_EFFECT_ID,
	RUMPELSTILTSKIN_SOLO_EFFECT_ID,
	videoEffectRequestSchema,
	VIDEO_EFFECT_RETAIL_PRICE_VERSION,
	HOTEL_LOBBY_LONG_TEMPLATE_VERSION,
	RAINDANCE_LONG_TEMPLATE_VERSION,
	videoEffectPricingDisplaySchema,
	type VideoEffectRequest,
} from "./video-effects";
import { validateVideoModelSelection } from "./video-models";
import { createVideoAudioSafetyPolicy } from "./video-output";
import {
	calculateVideoRetailPrice,
	resolveVideoModelCostBasis,
	readVideoRetailDisplay,
	type VideoRetailPricingContext,
	type VideoCostPolicy,
} from "./video-pricing.server";
import { configuredVideoVisualSafetyProfile } from "./video-safety";
import { configuredVideoTextSafetyProfile } from "./video-text-safety";
export {
	RUMPELSTILTSKIN_TEMPLATE_VERSION,
	RUMPELSTILTSKIN_PRICE_VERSION,
	RUMPELSTILTSKIN_SAFETY_POLICY_VERSION,
} from "./rumpelstiltskin-reference.server";

export const HOTEL_LOBBY_TEMPLATE_VERSION = "hotel-lobby-duo-2026-10-05.1";
export const RAINDANCE_TEMPLATE_VERSION = "raindance-2026-10-07.1";
export {
	HOTEL_LOBBY_LONG_TEMPLATE_VERSION,
	RAINDANCE_LONG_TEMPLATE_VERSION,
} from "./video-effects";
export const RAINDANCE_PRICE_VERSION = "raindance-cost-2026-10-07.1";
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

const raindanceScene = `Create an original cinematic portrait photograph on a weathered wooden pier
over a calm blue-green sea at sunset. Use warm amber rim light, a visible horizon and soft natural
shadows. Preserve the adult subjects' facial features, hair and clothing from the supplied
references. Compose a waist-up or three-quarter portrait with faces large enough to recognize,
hands clear of faces and safe space around the edges. One continuous scene, no collage, no extra
people, text, logos or captions. Do not imitate any named artist or copy an existing music video.`;
const raindanceMotion = `Animate this original sunset pier portrait for five seconds with a fixed
camera. Preserve each subject's face, hair, clothing and position, the pier and the horizon.
Use a gentle sea breeze, a small natural sway and a relaxed music-video-style performance toward
the lens. Keep faces visible and motion restrained. No scene cuts, face blending, extra people,
large hand gestures or camera moves. Silent video, no speech and no song. Do not reproduce
specific lyrics, lip synchronization or any named artist's performance.`;

const version = z.string().min(1).max(120);
const hotelLobbyLongMotion = `Animate this exact two-person orange studio scene for ten seconds with one fixed camera.
Seconds 0–2: both adults settle into a relaxed pose, faces visible and one suspended microphone between them.
Seconds 2–5: the LEFT performer leads with one small rhythmic shoulder and hand gesture while the RIGHT reacts.
Seconds 5–8: the RIGHT performer takes the lead with a different restrained gesture while the LEFT reacts.
Seconds 8–10: they exchange a brief glance and return to a calm finishing pose.
Keep left and right identities, clothing, positions, framing and the original scene throughout.
No cuts, identity swaps, face merging, extra people, mirrored choreography, overlapping gestures, text or logos.
Silent video; no speech, lip synchronization, song or named artist's performance.`;
const raindanceLongMotion = `Animate this original sunset pier portrait for ten seconds with a fixed camera.
Seconds 0–2: establish a relaxed still pose with a gentle sea breeze.
Seconds 2–5: begin a small natural shoulder sway while keeping the face visible.
Seconds 5–8: add a restrained change in pose and gaze toward the lens.
Seconds 8–10: settle into a relaxed finishing pose while the breeze continues.
Preserve each adult's face, hair, clothing, position, the pier and the horizon throughout.
No cuts, extra people, face blending, large gestures, camera moves, captions or logos.
Silent video; no speech, song, lip synchronization or named artist's performance.`;
/** Add historical versions explicitly when introducing a new execution contract. Never re-resolve defaults. */
const legacyVideoEffectTemplateSnapshotSchema = z
	.object({
		schemaVersion: z.literal(1),
		effectId: z.enum([HOTEL_LOBBY_EFFECT_ID, RAINDANCE_SOLO_EFFECT_ID, RAINDANCE_DUO_EFFECT_ID]),
		presetKey: z.literal("standard"),
		templateVersion: z.enum([HOTEL_LOBBY_TEMPLATE_VERSION, RAINDANCE_TEMPLATE_VERSION]),
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
	.strict()
	.refine(
		(snapshot) =>
			snapshot.templateVersion ===
			(snapshot.effectId === HOTEL_LOBBY_EFFECT_ID
				? HOTEL_LOBBY_TEMPLATE_VERSION
				: RAINDANCE_TEMPLATE_VERSION),
		{ message: "Template version does not match effect" },
	);
/** Ten-second choreography is a separate frozen contract; never reinterpret schema 1 orders. */
const longVideoEffectTemplateSnapshotSchema = z
	.object({
		...legacyVideoEffectTemplateSnapshotSchema.shape,
		schemaVersion: z.literal(3),
		templateVersion: z.enum([HOTEL_LOBBY_LONG_TEMPLATE_VERSION, RAINDANCE_LONG_TEMPLATE_VERSION]),
		video: legacyVideoEffectTemplateSnapshotSchema.shape.video.extend({ duration: z.literal(10) }),
		output: legacyVideoEffectTemplateSnapshotSchema.shape.output.extend({
			durationSeconds: z.literal(10),
		}),
	})
	.strict()
	.refine(
		(snapshot) =>
			snapshot.templateVersion ===
			(snapshot.effectId === HOTEL_LOBBY_EFFECT_ID
				? HOTEL_LOBBY_LONG_TEMPLATE_VERSION
				: RAINDANCE_LONG_TEMPLATE_VERSION),
		{ message: "Template version does not match effect" },
	);
const rumpelstiltskinMotionPrompt = `Use the authorized silent reference video as the motion and scene reference.
Replace only the LEFT dancing adult with the subject from the uploaded adult portrait.
Preserve that subject's recognizable facial features, hair and clothing while transferring the
reference's small raised-heel tiptoe steps and timing. Keep the feet and full body visible.
Keep the SECOND character's identity, appearance and position from the authorized reference fixed.
Preserve the reference framing and continuous scene. No extra people, face blending, identity swaps,
scene cuts, captions, logos or audio. Do not imitate a named artist or introduce copyrighted music.`;
/** A separate immutable execution contract; legacy snapshots cannot be reinterpreted as reference jobs. */
export const rumpelstiltskinTemplateSnapshotSchema = z
	.object({
		schemaVersion: z.literal(2),
		effectId: z.literal(RUMPELSTILTSKIN_SOLO_EFFECT_ID),
		presetKey: z.literal("standard"),
		executionKind: z.literal("seedance-reference"),
		templateVersion: z.literal(RUMPELSTILTSKIN_TEMPLATE_VERSION),
		safetyPolicyVersion: z.literal(RUMPELSTILTSKIN_SAFETY_POLICY_VERSION),
		preprocessingVersion: z.literal("sealed-upload-2026-10-05.1"),
		approvedMotionReference: approvedRumpelstiltskinMotionReferenceSchema,
		// Shape retained for historical shared code; this placeholder is never submitted or separately reviewed.
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
				productKey: z.literal("video-seedance-2"),
				mode: z.literal("image-to-video"),
				duration: z.literal(5),
				resolution: z.literal("720p"),
				aspectRatio: z.literal("9:16"),
				sound: z.literal(false),
				prompt: z.string().min(1).max(10000),
				promptVersion: version,
				fixedLens: z.literal(false),
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
export type RumpelstiltskinTemplateConfig = z.infer<typeof rumpelstiltskinTemplateSnapshotSchema>;
export const videoEffectTemplateSnapshotSchema = z.union([
	legacyVideoEffectTemplateSnapshotSchema,
	rumpelstiltskinTemplateSnapshotSchema,
	longVideoEffectTemplateSnapshotSchema,
]);
export type VideoEffectTemplateConfig = z.infer<typeof videoEffectTemplateSnapshotSchema>;

/** Pure construction only. Admission must separately enforce current readiness and cost approvals. */
export function createVideoEffectTemplateSnapshot(
	request: VideoEffectRequest,
	environment: Record<string, string | undefined> = {},
): VideoEffectTemplateConfig {
	videoEffectRequestSchema.parse(request);
	if (request.effectId === RUMPELSTILTSKIN_SOLO_EFFECT_ID) {
		return rumpelstiltskinTemplateSnapshotSchema.parse({
			schemaVersion: 2,
			effectId: RUMPELSTILTSKIN_SOLO_EFFECT_ID,
			presetKey: "standard",
			executionKind: "seedance-reference",
			templateVersion: RUMPELSTILTSKIN_TEMPLATE_VERSION,
			safetyPolicyVersion: RUMPELSTILTSKIN_SAFETY_POLICY_VERSION,
			preprocessingVersion: "sealed-upload-2026-10-05.1",
			approvedMotionReference: readApprovedRumpelstiltskinMotionReference(environment),
			scene: {
				productKey: "nano-banana-2-lite-1k",
				aspectRatio: "9:16",
				outputCount: 1,
				prompt:
					"Use the uploaded adult portrait solely as the authorized identity reference for the left performer. The approved motion reference fixes the second character. Do not generate or replace a scene image.",
				promptVersion: "rumpelstiltskin-identity-2026-10-07.1",
				maxOutputBytes: 10_000_000,
			},
			video: {
				productKey: "video-seedance-2",
				mode: "image-to-video",
				duration: 5,
				resolution: "720p",
				aspectRatio: "9:16",
				sound: false,
				prompt: rumpelstiltskinMotionPrompt,
				promptVersion: "rumpelstiltskin-motion-2026-10-07.1",
				fixedLens: false,
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
				sceneMaximumBytes: 20_000_000,
				sceneRetentionSeconds: DEFAULT_PRODUCT_CONFIG.retention.inputDays * 86_400,
				videoMaximumBytes: 104_857_600,
			},
		});
	}
	const raindance = request.effectId !== HOTEL_LOBBY_EFFECT_ID;
	const solo = request.effectId === RAINDANCE_SOLO_EFFECT_ID;
	const long = request.duration === 10;
	return videoEffectTemplateSnapshotSchema.parse({
		schemaVersion: long ? 3 : 1,
		effectId: request.effectId,
		presetKey: "standard",
		templateVersion: long
			? raindance
				? RAINDANCE_LONG_TEMPLATE_VERSION
				: HOTEL_LOBBY_LONG_TEMPLATE_VERSION
			: raindance
				? RAINDANCE_TEMPLATE_VERSION
				: HOTEL_LOBBY_TEMPLATE_VERSION,
		safetyPolicyVersion: HOTEL_LOBBY_SAFETY_POLICY_VERSION,
		preprocessingVersion: "sealed-upload-2026-10-05.1",
		scene: {
			productKey: "nano-banana-2-lite-1k",
			aspectRatio: "9:16",
			outputCount: 1,
			prompt: raindance
				? raindanceScene +
					(solo
						? " Both references show the SAME adult. Show exactly ONE person seated on the pier, looking toward the lens. Never duplicate the person."
						: " Reference 1 is the LEFT performer. Reference 2 is the RIGHT performer. Show exactly TWO distinct adults side by side with space between them. Keep their identities separate.")
				: scenePrompt,
			promptVersion: raindance
				? `raindance-${solo ? "solo" : "duo"}-scene-2026-10-07.1`
				: "hotel-lobby-scene-2026-10-05.1",
			maxOutputBytes: 10_000_000,
		},
		video: {
			productKey: "video-seedance-1-5-pro",
			mode: "image-to-video",
			duration: long ? 10 : 5,
			resolution: "720p",
			aspectRatio: "9:16",
			sound: false,
			prompt: long
				? raindance
					? raindanceLongMotion +
						(solo
							? " Keep exactly ONE adult seated in frame throughout, using subtle head and shoulder motion."
							: " Keep the LEFT adult on the left and the RIGHT adult on the right. During seconds 2–5 the left adult leads and the right reacts; during seconds 5–8 the right adult leads and the left reacts. Finish with a brief mutual glance.")
					: hotelLobbyLongMotion
				: raindance
					? raindanceMotion +
						(solo
							? " Keep exactly one adult in frame throughout."
							: " Keep the left person on the left and the right person on the right. One makes a small gesture while the other reacts, then they exchange a brief glance.")
					: motionPrompt,
			promptVersion: long
				? raindance
					? `raindance-${solo ? "solo" : "duo"}-motion-10s-2026-10-08.1`
					: "hotel-lobby-motion-10s-2026-10-08.1"
				: raindance
					? `raindance-${solo ? "solo" : "duo"}-motion-2026-10-07.1`
					: "hotel-lobby-motion-2026-10-05.1",
			fixedLens: true,
		},
		output: {
			durationSeconds: long ? 10 : 5,
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
	const prefix =
		request.effectId === HOTEL_LOBBY_EFFECT_ID
			? "HOTEL_LOBBY_DUO"
			: request.effectId === RUMPELSTILTSKIN_SOLO_EFFECT_ID
				? "RUMPELSTILTSKIN"
				: "RAINDANCE";
	const enabled =
		env[`${prefix}_ENABLED`] ??
		(request.effectId === RUMPELSTILTSKIN_SOLO_EFFECT_ID ? "true" : undefined);
	if (enabled !== "true") throw new Error("VIDEO_EFFECT_DISABLED");
	const template = createVideoEffectTemplateSnapshot(request, env);
	const acceptedVersion =
		env[`${prefix}_ACCEPTED_${request.duration === 10 ? "LONG_" : ""}TEMPLATE_VERSION`] ??
		(request.effectId === RUMPELSTILTSKIN_SOLO_EFFECT_ID
			? RUMPELSTILTSKIN_TEMPLATE_VERSION
			: undefined);
	if (acceptedVersion !== template.templateVersion)
		throw new Error("VIDEO_EFFECT_TEMPLATE_NOT_CONFIRMED");
	if (request.duration === 10 && !isVideoEffectRetailPricingApproved(env))
		throw new Error("VIDEO_EFFECT_PRICE_NOT_APPROVED");
	if (!validateVideoModelSelection(template.video))
		throw new Error("VIDEO_MODEL_SELECTION_UNSUPPORTED");
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

function resolveRumpelstiltskinTemplatePrice(
	template: RumpelstiltskinTemplateConfig,
	environment: Record<string, string | undefined>,
) {
	const approval = readRumpelstiltskinCostApproval(environment, template.approvedMotionReference);
	const visualSafetyProfile = configuredVideoVisualSafetyProfile(
		environment,
		template.video.duration,
	);
	const textSafetyProfile = configuredVideoTextSafetyProfile(environment);
	if (
		approval.policies.visualPolicyVersion !== visualSafetyProfile.policyVersion ||
		approval.policies.textRuleVersion !== textSafetyProfile.ruleVersion
	)
		throw new Error("RUMPELSTILTSKIN_COST_POLICY_MISMATCH");
	const costs = approval.costs;
	const policy: VideoCostPolicy = {
		moderationBaseMicros:
			BigInt(costs.subjectImageReviewMicros) +
			BigInt(costs.referenceVideoReviewMicros) +
			BigInt(costs.outputVideoReviewBaseMicros) +
			BigInt(costs.promptReviewEachMicros),
		moderationPerSecondMicros: BigInt(costs.outputVideoReviewPerSecondMicros),
		audioModerationPerSecondMicros: 0n,
		runtimeMicros: BigInt(costs.runtimeMicros),
		storageMicros: BigInt(costs.storageTransferMicros),
		paymentFixedAllocationMicros: BigInt(costs.paymentFixedAllocationMicros),
		paymentFeeBps: BigInt(costs.paymentFeeBps),
		nonBillableFailureBps: BigInt(costs.nonBillableFailureBps),
		markupBps: BigInt(costs.markupBps),
	};
	const providerCostMicros = BigInt(approval.provider.totalCostMicros);
	const result = calculateVideoRetailPrice({
		providerCostMicros,
		duration: template.video.duration,
		sound: false,
		policy,
		creditFloorMicros: BigInt(approval.revenue.minimumGrossUsdMicrosPerCredit),
	});
	// Payment fees are deducted once from gross revenue. Operating cost already includes expected
	// nonbillable failures. This is a per-order contribution bound, not enterprise after-tax profit.
	const minimumNetRevenueMicros = result.minimumGrossRevenueMicros - result.paymentFeeMicros;
	const riskAdjustedOperatingCostMicros = result.riskAdjustedCostMicros;
	const netContributionProfitMicros = minimumNetRevenueMicros - riskAdjustedOperatingCostMicros;
	if (netContributionProfitMicros * 10_000n < riskAdjustedOperatingCostMicros * policy.markupBps)
		throw new Error("RUMPELSTILTSKIN_NET_PROFIT_FLOOR_NOT_MET");
	const netProfitBps = (netContributionProfitMicros * 10_000n) / riskAdjustedOperatingCostMicros;
	const serializedResult = Object.fromEntries(
		Object.entries(result).map(([key, value]) => [key, value.toString()]),
	) as { [Key in keyof typeof result]: string };
	const validUntil = Math.min(
		Date.parse(approval.validUntil),
		Date.parse(approval.revenue.validUntil),
		Date.parse(template.approvedMotionReference.review.validUntil),
		Date.parse(template.approvedMotionReference.rights.validUntil),
	);
	return {
		credits: result.credits,
		pricingVersion: approval.pricingVersion,
		pricingBasis: approval.basis,
		providerCostMicros,
		moderationCostMicros: result.moderationCostMicros,
		paidFundingPolicy: { minimumUsdMicrosPerCredit: result.creditFloorMicros },
		pricingDetails: {
			kind: "video-effect" as const,
			effectId: template.effectId,
			templateVersion: template.templateVersion,
			presetKey: template.presetKey,
			safetyPolicyVersion: template.safetyPolicyVersion,
			executionKind: template.executionKind,
			approvalId: approval.approvalId,
			costApprovalEvidence: approval.evidence ?? null,
			creditRevenueBasis: approval.revenue.basis,
			minimumNetRevenueMicros: minimumNetRevenueMicros.toString(),
			riskAdjustedOperatingCostMicros: riskAdjustedOperatingCostMicros.toString(),
			netContributionProfitMicros: netContributionProfitMicros.toString(),
			netProfitBps: netProfitBps.toString(),
			videoPricingVersion: approval.pricingVersion,
			videoPricingBasis: approval.provider.basis,
			visualPolicyVersion: visualSafetyProfile.policyVersion,
			textRuleVersion: textSafetyProfile.ruleVersion,
			textCostBasis: approval.policies.promptCostBasis,
			textReviewCount: 1,
			paymentCostBasis: approval.policies.paymentCostBasis,
			priceApprovalExpiryMode: "until" as const,
			templatePaymentFeeBps: String(costs.paymentFeeBps),
			minimumRevenueToCostBps: String(10_000 + costs.markupBps),
			audioSafetyPolicy: createVideoAudioSafetyPolicy(),
			validUntil: new Date(validUntil).toISOString(),
			costComponents: {
				...costs,
				videoProviderCostMicros: approval.provider.totalCostMicros,
				textReviewCostMicros: costs.promptReviewEachMicros,
			},
			costPolicy: Object.fromEntries(
				Object.entries(policy).map(([key, value]) => [key, value.toString()]),
			),
			...serializedResult,
		},
	};
}

/** One full-cost calculation, one payment allocation and one failure budget for both paid stages. */
export function isVideoEffectRetailPricingApproved(
	env: Record<string, string | undefined>,
): boolean {
	const version = env.VIDEO_EFFECT_RETAIL_PRICE_ACCEPTED_VERSION;
	if (version !== undefined && version !== VIDEO_EFFECT_RETAIL_PRICE_VERSION)
		throw new Error("VIDEO_EFFECT_PRICE_NOT_APPROVED");
	return version === VIDEO_EFFECT_RETAIL_PRICE_VERSION;
}
export function readVideoEffectPricingDisplay(details: unknown) {
	const parsed = videoEffectPricingDisplaySchema.safeParse(
		readVideoRetailDisplay(details, VIDEO_EFFECT_RETAIL_PRICE_VERSION),
	);
	return parsed.success ? parsed.data : null;
}

export function resolveVideoEffectPrice(
	request: VideoEffectRequest,
	env: Record<string, string | undefined>,
	context: VideoRetailPricingContext = {},
) {
	const template = resolveVideoEffectTemplate(request, env);
	if (template.schemaVersion === 2) return resolveRumpelstiltskinTemplatePrice(template, env);
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
	const baseMarkupBps =
		env.HOTEL_LOBBY_DUO_PRICE_MARKUP_BPS === undefined
			? HOTEL_LOBBY_MINIMUM_MARKUP_BPS
			: costSetting(env, "HOTEL_LOBBY_DUO_PRICE_MARKUP_BPS");
	const templatePaymentFeeBps =
		env.HOTEL_LOBBY_DUO_PAYMENT_FEE_BPS === undefined
			? HOTEL_LOBBY_MINIMUM_PAYMENT_FEE_BPS
			: costSetting(env, "HOTEL_LOBBY_DUO_PAYMENT_FEE_BPS");
	if (
		baseMarkupBps < HOTEL_LOBBY_MINIMUM_MARKUP_BPS ||
		baseMarkupBps > 100_000n ||
		templatePaymentFeeBps < HOTEL_LOBBY_MINIMUM_PAYMENT_FEE_BPS ||
		templatePaymentFeeBps >= 10_000n
	)
		throw new Error("VIDEO_EFFECT_PRICING_TARGET_INVALID");
	const upgraded = isVideoEffectRetailPricingApproved(env);
	const audience = context.audience ?? "standard";
	if (
		!["standard", "annual"].includes(audience) ||
		(context.eligibility && context.eligibility.audience !== audience)
	)
		throw new Error("VIDEO_RETAIL_AUDIENCE_INVALID");
	const extraMarkupBps = upgraded ? BigInt(Math.max(0, template.video.duration - 5)) * 1_500n : 0n;
	const standardMarkupBps =
		baseMarkupBps + extraMarkupBps > 100_000n ? 100_000n : baseMarkupBps + extraMarkupBps;
	// Annual membership halves only the surcharge above the effect's own approved base.
	const annualMarkupBps = baseMarkupBps + (standardMarkupBps - baseMarkupBps) / 2n;
	const markupBps = upgraded && audience === "annual" ? annualMarkupBps : standardMarkupBps;
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
	const standard = calculateVideoRetailPrice({
		providerCostMicros,
		duration: template.video.duration,
		sound: false,
		policy: { ...policy, markupBps: standardMarkupBps },
	});
	const annual = calculateVideoRetailPrice({
		providerCostMicros,
		duration: template.video.duration,
		sound: false,
		policy: { ...policy, markupBps: annualMarkupBps },
	});
	const retail = upgraded
		? {
				version: VIDEO_EFFECT_RETAIL_PRICE_VERSION,
				baseMarkupBps: baseMarkupBps.toString(),
				standardMarkupBps: standardMarkupBps.toString(),
				annualMarkupBps: annualMarkupBps.toString(),
				eligibility: context.eligibility ?? null,
				display: {
					policyVersion: VIDEO_EFFECT_RETAIL_PRICE_VERSION,
					audience,
					credits: result.credits.toString(),
					standardCredits: standard.credits.toString(),
					annualCredits: annual.credits.toString(),
					savedCredits: (standard.credits - result.credits).toString(),
					annualSavingsCredits: (standard.credits - annual.credits).toString(),
				},
			}
		: undefined;
	const serializedResult = Object.fromEntries(
		Object.entries(result).map(([key, value]) => [key, value.toString()]),
	) as { [Key in keyof typeof result]: string };
	return {
		credits: result.credits,
		// Same two-stage model tuple and conservative two-input review budget. Approval expiry,
		// complete cost and minimum revenue checks stay authoritative for every template.
		pricingVersion: upgraded
			? `${VIDEO_EFFECT_RETAIL_PRICE_VERSION}/${audience}`
			: request.effectId === HOTEL_LOBBY_EFFECT_ID
				? HOTEL_LOBBY_PRICE_VERSION
				: RAINDANCE_PRICE_VERSION,
		pricingBasis: env.HOTEL_LOBBY_DUO_PRICE_BASIS.trim(),
		providerCostMicros,
		moderationCostMicros: result.moderationCostMicros,
		paidFundingPolicy: { minimumUsdMicrosPerCredit: result.creditFloorMicros },
		pricingDetails: {
			kind: "video-effect" as const,
			...(retail ? { retail } : {}),
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
			priceApprovalExpiryMode: "until" as const,
			validUntil: new Date(
				basis.validUntil === null
					? approvedValidUntil
					: Math.min(approvedValidUntil, basis.validUntil),
			).toISOString(),
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
