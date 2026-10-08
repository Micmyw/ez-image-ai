import { z } from "zod";

import {
	videoModelInputSchema,
	videoModelReceiptInputSchema,
	VIDEO_MODEL_CATALOG_VERSION,
} from "./video-models";
import { readVideoSeeapiCallbackConfig } from "./video-seeapi-callback";

export const VIDEO_V1_PRODUCT_KEY = "video-kling-2-6-v1";
export const VIDEO_V1_MODEL_CONTRACT_VERSION = "kie-kling-2.6-2026-10-04.1";
export const VIDEO_V1_RULE_VERSION = "video-safety-2026-10-04.1";
export const VIDEO_V1_POLICY_VERSION = "video-policy-2026-10-04.1";
export const VIDEO_V1_MAX_PROMPT_CODE_POINTS = 1000;
export const videoV1PromptSchema = z
	.string()
	.trim()
	.refine((value) => {
		const length = Array.from(value).length;
		return length >= 1 && length <= VIDEO_V1_MAX_PROMPT_CODE_POINTS;
	}, "VIDEO_PROMPT_LENGTH");
const common = { prompt: videoV1PromptSchema, duration: z.literal(5), sound: z.literal(false) };
const legacyVideoV1InputSchema = z.discriminatedUnion("mode", [
	z
		.object({
			...common,
			mode: z.literal("text-to-video"),
			aspectRatio: z.enum(["16:9", "9:16"]).default("16:9"),
		})
		.strict(),
	z
		.object({
			...common,
			mode: z.literal("image-to-video"),
			inputAssetId: z.string().min(1).max(160),
		})
		.strict(),
]);
// Do not inject new defaults into already-persisted V1 input fingerprints.
export const videoV1InputSchema = z.union([legacyVideoV1InputSchema, videoModelInputSchema]);
export const videoV1ReceiptInputSchema = z.union([
	legacyVideoV1InputSchema,
	videoModelReceiptInputSchema,
]);
export type VideoV1Input = z.infer<typeof videoV1InputSchema>;
export type VideoV1Environment = Record<string, string | undefined>;
export type VideoV1AccessScope = "internal" | "authenticated";

/** Missing scope preserves internal admission; invalid values keep admission closed. */
export function readVideoV1AccessScope(env: VideoV1Environment): VideoV1AccessScope | null {
	const scope = env.VIDEO_V1_ACCESS ?? "internal";
	return scope === "internal" || scope === "authenticated" ? scope : null;
}

/** One origin for callback construction and readiness; never take this value from a client. */
export function resolveVideoV1CallbackBaseUrl(env: VideoV1Environment): string | null {
	const value = env.VIDEO_V1_CALLBACK_BASE_URL ?? env.NEXT_PUBLIC_SAAS_URL;
	if (!value) return null;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/" ||
			url.hostname === "localhost" ||
			url.hostname.endsWith(".localhost") ||
			/^[\d.]+$/.test(url.hostname) ||
			url.hostname.includes(":")
		)
			return null;
		if (env.NEXT_PUBLIC_SAAS_URL && new URL(env.NEXT_PUBLIC_SAAS_URL).origin !== url.origin)
			return null;
		return url.origin;
	} catch {
		return null;
	}
}

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
	if (!value) return fallback;
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 && number <= maximum ? number : 0;
}
function positiveBigInt(value: string | undefined, allowZero = false): bigint | null {
	if (!value || !/^\d{1,18}$/.test(value)) return null;
	const parsed = BigInt(value);
	return parsed > BigInt(0) || (allowZero && parsed === BigInt(0)) ? parsed : null;
}
export function readVideoV1Config(env: VideoV1Environment) {
	return {
		enabled: env.VIDEO_V1_ENABLED === "true",
		access: readVideoV1AccessScope(env),
		credits: positiveBigInt(env.VIDEO_V1_CREDITS),
		pricingVersion: env.VIDEO_V1_PRICE_VERSION?.trim() || null,
		pricingBasis: env.VIDEO_V1_PRICING_BASIS?.trim() || null,
		providerCostMicros: positiveBigInt(env.VIDEO_V1_PROVIDER_COST_MICROS),
		moderationCostMicros: positiveBigInt(env.VIDEO_V1_MODERATION_COST_MICROS),
		ownerConcurrency: boundedInteger(env.VIDEO_V1_OWNER_CONCURRENCY, 1, 1),
		globalConcurrency: boundedInteger(env.VIDEO_V1_GLOBAL_CONCURRENCY, 5, 5),
		providerConcurrency: boundedInteger(env.VIDEO_V1_PROVIDER_CONCURRENCY, 0, 5),
		providerPollSeconds: boundedInteger(env.VIDEO_V1_PROVIDER_POLL_SECONDS, 30, 300),
		providerDeadlineSeconds: boundedInteger(env.VIDEO_V1_PROVIDER_DEADLINE_SECONDS, 1800, 7200),
		moderationPollSeconds: boundedInteger(env.VIDEO_V1_MODERATION_POLL_SECONDS, 30, 300),
		moderationDeadlineSeconds: boundedInteger(env.VIDEO_V1_MODERATION_DEADLINE_SECONDS, 1800, 7200),
		maxInputBytes: 10_000_000,
		maxOutputBytes: 100 * 1024 * 1024,
		maxPromptCodePoints: VIDEO_V1_MAX_PROMPT_CODE_POINTS,
		outputAllowedHosts: (env.VIDEO_V1_OUTPUT_ALLOWED_HOSTS ?? "")
			.split(",")
			.map((host) => host.trim().toLowerCase())
			.filter((host) => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)),
	};
}
export type VideoV1Config = ReturnType<typeof readVideoV1Config>;
type VideoV1User = { id: string; role?: string | null; isAnonymous?: boolean | null };

/** Administrator-only rollback audience; templates retain their independent access scope. */
export function canAccessInternalVideoV1(
	config: VideoV1Config,
	user: VideoV1User | null | undefined,
): boolean {
	return Boolean(config.enabled && user?.id && !user.isAnonymous && user.role === "admin");
}
export function canAccessVideoV1(
	config: VideoV1Config,
	user: VideoV1User | null | undefined,
): boolean {
	return Boolean(
		config.enabled &&
		user?.id &&
		!user.isAnonymous &&
		(config.access === "authenticated" ||
			(config.access === "internal" && canAccessInternalVideoV1(config, user))),
	);
}
export type VideoV1Bindings = {
	workflow?: boolean;
	r2?: boolean;
	hyperdrive?: boolean;
	uploadCors?: boolean;
};
/** The caller supplies actual binding availability; missing evidence keeps admission closed. */
export function videoV1Readiness(
	env: VideoV1Environment,
	bindings: VideoV1Bindings = {},
	options: { multiModel?: boolean; sound?: boolean } = {},
) {
	const config = readVideoV1Config(env);
	const reasons: string[] = [];
	if (!config.enabled) reasons.push("VIDEO_DISABLED");
	if (env.MEDIA_GENERATION_ENABLED !== "true") reasons.push("MEDIA_GENERATION_DISABLED");
	if (!config.access) reasons.push("VIDEO_ACCESS_CONFIGURATION_INVALID");
	if (
		!options.multiModel &&
		(!config.credits ||
			!config.pricingVersion ||
			!config.pricingBasis ||
			!config.providerCostMicros ||
			!config.moderationCostMicros)
	)
		reasons.push("VIDEO_PRICING_NOT_CONFIGURED");
	if (!env.KIE_API_KEY?.trim() || !env.KIE_WEBHOOK_SECRET?.trim())
		reasons.push("VIDEO_PROVIDER_NOT_CONFIGURED");
	if (!resolveVideoV1CallbackBaseUrl(env)) reasons.push("VIDEO_CALLBACK_ORIGIN_NOT_CONFIGURED");
	if (
		options.multiModel
			? env.VIDEO_MODEL_CONTRACT_VERSION !== VIDEO_MODEL_CATALOG_VERSION
			: env.VIDEO_V1_MODEL_CONTRACT_VERSION !== VIDEO_V1_MODEL_CONTRACT_VERSION
	)
		reasons.push("VIDEO_MODEL_CONTRACT_NOT_CONFIRMED");
	if (
		env.VIDEO_V1_TEXT_SAFETY_ADAPTER !== "waffo" ||
		!env.WAFFO_MERCHANT_ID?.trim() ||
		!env.WAFFO_PRIVATE_KEY?.trim()
	)
		reasons.push("VIDEO_MODERATION_NOT_CONFIGURED");
	if (env.VIDEO_V1_VIDEO_SAFETY_ADAPTER !== "seeapi" || !env.SEEAPI_API_KEY?.trim())
		reasons.push("VIDEO_VISUAL_MODERATION_NOT_CONFIGURED");
	if (env.VIDEO_V1_VIDEO_SAFETY_ADAPTER === "seeapi" && !readVideoSeeapiCallbackConfig(env).ready)
		reasons.push("VIDEO_SEEAPI_CALLBACK_NOT_CONFIGURED");
	if (env.VIDEO_V1_IMAGE_SAFETY_ADAPTER !== "seeapi" || !env.SEEAPI_API_KEY?.trim())
		reasons.push("VIDEO_IMAGE_MODERATION_NOT_CONFIGURED");
	if (!config.ownerConcurrency || !config.globalConcurrency || !config.providerConcurrency)
		reasons.push("VIDEO_CONCURRENCY_NOT_CONFIGURED");
	if (
		config.providerPollSeconds < 15 ||
		config.moderationPollSeconds < 15 ||
		!config.providerDeadlineSeconds ||
		!config.moderationDeadlineSeconds
	)
		reasons.push("VIDEO_TIMING_CONFIGURATION_INVALID");
	if (!config.outputAllowedHosts.length) reasons.push("VIDEO_OUTPUT_HOSTS_NOT_CONFIGURED");
	for (const name of ["workflow", "r2", "hyperdrive", "uploadCors"] as const)
		if (!bindings[name]) reasons.push(`VIDEO_BINDING_${name.toUpperCase()}_NOT_READY`);
	return { ready: reasons.length === 0, reasons };
}
