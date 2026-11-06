import { calculateVideoRetailPrice, type VideoCostPolicy } from "./video-pricing.server";
import {
	HISTORICAL_VIDEO_RETAIL_REFERENCE_MICROS_PER_CREDIT,
	VIDEO_RETAIL_REFERENCE_PRICE_VERSION,
} from "./video-retail-reference.server";
import { expandVideoRuntimeEnvironment } from "./video-runtime-environment";
import {
	configuredProviderOwnedVideoVisualSafetyProfile,
	configuredVideoVisualSafetyProfile,
} from "./video-safety";
import {
	isFlyingCarTemplate,
	isRapTemplate,
	sourceTemplateDefaults,
	sourceTemplateRoles,
	type SourceTemplateChoices,
	type SourceTemplateKey,
} from "./video-template-library";
import { configuredVideoTextSafetyProfile } from "./video-text-safety";

/** Target-account SeeAPI rules and public Kie H3 tariff observed 2026-11-06. */
export const SOURCE_TEMPLATE_PRICE_VERSION = "source-template-cost-2026-11-06.1";
export const SOURCE_TEMPLATE_PRICE_OPTION_KEYS = [
	"tier",
	"preset",
	"durationSeconds",
	"resolution",
	"aspectRatio",
] as const;

/** Public purchasable plans, not evidence of the account's recharge or invoice. */
export const SEEAPI_PUBLIC_CREDIT_USD_BASES = {
	"creator-pay-once-299-30000": { usdMicros: 299_000_000n, credits: 30_000n },
	"studio-pay-once-499-60000": { usdMicros: 499_000_000n, credits: 60_000n },
	"scale-pay-once-1999-400000": { usdMicros: 1_999_000_000n, credits: 400_000n },
	"starter-annual-199-24000": { usdMicros: 199_000_000n, credits: 24_000n },
	"pro-annual-799-150000": { usdMicros: 799_000_000n, credits: 150_000n },
	"studio-annual-1199-320000": { usdMicros: 1_199_000_000n, credits: 320_000n },
} as const;
export const DEFAULT_SEEAPI_CREDIT_USD_BASIS = "creator-pay-once-299-30000";
type Environment = Record<string, string | undefined>;
type CreditBasis = { usdMicros: bigint; credits: bigint; description: string };
export type SourceTemplatePricingTransport = {
	executionContract?: "prompt" | "provider-owned-template";
	provider: "seeapi" | "kie";
	modelId: string;
	endpoint: string;
	body: object;
	output: {
		durationSeconds: number | null;
		resolution: string;
		aspectRatio: string;
		sound: boolean;
	};
};
export type SourceTemplatePriceRequest = {
	templateKey: SourceTemplateKey;
	options: SourceTemplateChoices;
	transport: SourceTemplatePricingTransport;
};

const ceil = (numerator: bigint, denominator: bigint) => {
	if (numerator < 0n || denominator <= 0n) throw new Error("SOURCE_TEMPLATE_PRICE_INVALID");
	return (numerator + denominator - 1n) / denominator;
};
function setting(environment: Environment, key: string, allowZero = false): bigint {
	const value = environment[key];
	if (!value || !/^\d{1,14}$/.test(value) || (!allowZero && BigInt(value) === 0n))
		throw new Error(`SOURCE_TEMPLATE_PRICE_CONFIG_REQUIRED:${key}`);
	return BigInt(value);
}
function creditBasis(environment: Environment): CreditBasis {
	const key = environment.SEEAPI_CREDIT_USD_BASIS ?? DEFAULT_SEEAPI_CREDIT_USD_BASIS;
	if (key === "custom") {
		if (!environment.SEEAPI_CREDIT_USD_BASIS_EVIDENCE?.trim())
			throw new Error("SOURCE_TEMPLATE_PRICE_CONFIG_REQUIRED:SEEAPI_CREDIT_USD_BASIS_EVIDENCE");
		return {
			usdMicros: setting(environment, "SEEAPI_CREDIT_USD_AMOUNT_MICROS"),
			credits: setting(environment, "SEEAPI_CREDIT_USD_AMOUNT_CREDITS"),
			description: `explicit cost budget: ${environment.SEEAPI_CREDIT_USD_BASIS_EVIDENCE.trim()}`,
		};
	}
	const basis = SEEAPI_PUBLIC_CREDIT_USD_BASES[key as keyof typeof SEEAPI_PUBLIC_CREDIT_USD_BASES];
	if (!basis) throw new Error("SOURCE_TEMPLATE_PRICE_SEEAPI_BASIS_INVALID");
	return {
		...basis,
		description: `public tariff budget ${key}; https://www.seeapi.com/pricing/; non-account invoice`,
	};
}
/** Preserve the rational until the final USD micro rounding; never use displayed $0.0037. */
export function seeapiSupplierCreditsCostMicros(
	numerator: bigint,
	denominator = 1n,
	environment: Environment = {},
): bigint {
	const basis = creditBasis(environment);
	return ceil(numerator * basis.usdMicros, denominator * basis.credits);
}

const seeapiRates: Record<string, Record<string, number>> = {
	"seedance-2-mini": { "480p": 10, "720p": 20 },
	"seedance-2-fast": { "480p": 16, "720p": 34 },
	"seedance-2": { "480p": 26, "720p": 55, "1080p": 137 },
	"seedance-2-5": { "480p": 38, "720p": 85, "1080p": 211 },
};
const modelByTier = {
	standard: "seedance-2-mini",
	fast: "seedance-2-fast",
	pro: "seedance-2",
	ultra: "seedance-2-5",
} as const;

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("SOURCE_TEMPLATE_PRICE_TRANSPORT_INVALID");
	return value as Record<string, unknown>;
}
function imageCount(value: unknown) {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item))
		throw new Error("SOURCE_TEMPLATE_PRICE_IMAGES_INVALID");
	return value.length;
}

function supplierCost(request: SourceTemplatePriceRequest, environment: Environment) {
	const { templateKey: key, transport, options } = request;
	const { durationSeconds: duration, resolution, aspectRatio, sound } = transport.output;
	const body = object(transport.body);
	const input = object(body.input);
	const choices = { ...sourceTemplateDefaults(key), ...options };
	const roles = sourceTemplateRoles(key, choices);
	if (
		!sound ||
		input.resolution !== resolution ||
		input.aspect_ratio !== aspectRatio ||
		(options.resolution !== undefined && options.resolution !== resolution) ||
		(options.aspectRatio !== undefined && options.aspectRatio !== aspectRatio) ||
		(options.durationSeconds !== undefined && options.durationSeconds !== duration)
	)
		throw new Error("SOURCE_TEMPLATE_PRICE_OUTPUT_MISMATCH");
	// Current source builders never send reference videos. Unknown media must not be priced free.
	if (Object.keys(input).some((field) => /(?:reference|input)_video/.test(field)))
		throw new Error("SOURCE_TEMPLATE_PRICE_REFERENCE_VIDEO_UNSUPPORTED");
	if (key === "source-hotel-lobby") {
		if (
			transport.provider !== "seeapi" ||
			transport.modelId !== "hotel-lobby-ai" ||
			transport.endpoint !== "hotel-lobby-ai" ||
			transport.executionContract !== "provider-owned-template" ||
			duration !== null ||
			body.provider !== "seeapi" ||
			body.model !== undefined ||
			input.duration !== undefined ||
			input.duration_seconds !== undefined ||
			input.prompt !== undefined ||
			imageCount(input.reference_images) !== 2 ||
			!["768P", "2K"].includes(resolution)
		)
			throw new Error("SOURCE_TEMPLATE_PRICE_HOTEL_CONTRACT_INVALID");
		const supplierCredits = resolution === "768P" ? 285n : 395n;
		return {
			providerCostMicros: seeapiSupplierCreditsCostMicros(supplierCredits, 1n, environment),
			userImageCount: 2,
			totalImageCount: 2,
			duration: null,
			rateBasis: `https://www.seeapi.com/docs/templates/hotel-lobby-ai/; ${supplierCredits} supplier credits/generation`,
			resolutionSteps: resolution === "768P" ? 0 : 1,
			nonBaseMode: false,
		};
	}
	if (
		!Number.isSafeInteger(duration) ||
		duration === null ||
		duration < 2 ||
		duration > 30 ||
		transport.executionContract === "provider-owned-template"
	)
		throw new Error("SOURCE_TEMPLATE_PRICE_DURATION_INVALID");
	if (transport.provider === "seeapi") {
		if (
			(!isRapTemplate(key) && key !== "spin-me-round" && key !== "bulin-47") ||
			body.provider !== "seeapi" ||
			body.model !== transport.modelId ||
			body.endpoint !== transport.endpoint ||
			input.duration_seconds !== duration ||
			input.generate_audio !== true ||
			![5, 8, 10, 12, 15].includes(duration) ||
			!seeapiRates[transport.modelId]?.[resolution]
		)
			throw new Error("SOURCE_TEMPLATE_PRICE_SEEAPI_CONTRACT_INVALID");
		if (
			(key !== "bulin-47" && modelByTier[choices.tier ?? "standard"] !== transport.modelId) ||
			(key === "bulin-47" && duration !== 15)
		)
			throw new Error("SOURCE_TEMPLATE_PRICE_MODEL_MISMATCH");
		let totalImageCount: number;
		if (transport.endpoint === "reference-to-video")
			totalImageCount = imageCount(input.reference_images);
		else if (transport.endpoint === "image-to-video" && typeof input.first_frame_image === "string")
			totalImageCount = 1;
		else if (
			transport.endpoint === "text-to-video" &&
			roles.length === 0 &&
			input.reference_images === undefined &&
			input.first_frame_image === undefined
		)
			totalImageCount = 0;
		else throw new Error("SOURCE_TEMPLATE_PRICE_ENDPOINT_INVALID");
		const expectedImages =
			roles.length + (key === "bulin-47" ? 2 : key === "spin-me-round" ? 1 : 0);
		if (totalImageCount !== expectedImages) throw new Error("SOURCE_TEMPLATE_PRICE_IMAGES_INVALID");
		const rate = seeapiRates[transport.modelId]![resolution]!;
		return {
			providerCostMicros: seeapiSupplierCreditsCostMicros(BigInt(rate * duration), 1n, environment),
			userImageCount: roles.length,
			totalImageCount,
			duration,
			rateBasis: `https://api.seeapi.com/v1/prices; worker-v1; ${rate} supplier credits/output second; no input video; reference audio does not select video tariff`,
			resolutionSteps: ["480p", "720p", "1080p"].indexOf(resolution),
			nonBaseMode: ["seedance-2-fast", "seedance-2"].includes(transport.modelId),
		};
	}
	const fixedSeconds: Partial<Record<SourceTemplateKey, number>> = {
		"58th-floor": 15,
		"green-booth-freestyle": 10,
		"kung-fu-cat": 9,
		"paws-at-you": 6,
		"flying-car-curved-ramp-showcase": 15,
		"flying-car-curved-ramp": 15,
		"flying-car-fleet-side": 7,
		"flying-car-fleet-front": 7,
	};
	const fixedImages =
		key === "58th-floor" || key === "green-booth-freestyle"
			? 3
			: isFlyingCarTemplate(key)
				? key.includes("curved-ramp")
					? 6
					: 5
				: 2;
	if (
		transport.provider !== "kie" ||
		transport.modelId !== "minimax-h3/reference-to-video" ||
		transport.endpoint !== "reference-to-video" ||
		body.model !== transport.modelId ||
		input.duration !== duration ||
		fixedSeconds[key] !== duration ||
		!["768P", "2K"].includes(resolution) ||
		(["green-booth-freestyle", "kung-fu-cat", "paws-at-you"].includes(key) && resolution !== "768P")
	)
		throw new Error("SOURCE_TEMPLATE_PRICE_KIE_CONTRACT_INVALID");
	const totalImageCount = imageCount(input.reference_image_urls);
	if (totalImageCount !== roles.length + fixedImages)
		throw new Error("SOURCE_TEMPLATE_PRICE_IMAGES_INVALID");
	const rate = resolution === "768P" ? 40_000n : 65_000n;
	const additionalImages = Math.max(0, totalImageCount - 5);
	return {
		providerCostMicros: BigInt(duration) * rate + BigInt(additionalImages) * 20_000n,
		userImageCount: roles.length,
		totalImageCount,
		duration,
		rateBasis: `https://kie.ai/minimax-h3; ${rate} USD micros/output second; ${additionalImages} images above five at 20000 USD micros each; reference audio free; no top-up discount`,
		resolutionSteps: resolution === "768P" ? 0 : 1,
		nonBaseMode: false,
	};
}

function textCost(environment: Environment, noPrompt: boolean) {
	if (noPrompt)
		return {
			micros: 0n,
			basis: "provider-owned template: no caller prompt and no prompt-review call",
		};
	const profile = configuredVideoTextSafetyProfile(environment);
	if (environment.VIDEO_COST_TEXT_RULE_VERSION !== profile.ruleVersion)
		throw new Error("SOURCE_TEMPLATE_PRICE_TEXT_POLICY_MISMATCH");
	if (environment.SOURCE_TEMPLATE_TEXT_REVIEW_COST_MICROS !== undefined) {
		if (!environment.SOURCE_TEMPLATE_TEXT_COST_BASIS?.trim())
			throw new Error("SOURCE_TEMPLATE_PRICE_CONFIG_REQUIRED:SOURCE_TEMPLATE_TEXT_COST_BASIS");
		return {
			micros: setting(environment, "SOURCE_TEMPLATE_TEXT_REVIEW_COST_MICROS", true),
			basis: environment.SOURCE_TEMPLATE_TEXT_COST_BASIS.trim(),
		};
	}
	if (
		environment.HOTEL_LOBBY_DUO_TEXT_COST_RULE_VERSION === profile.ruleVersion &&
		environment.HOTEL_LOBBY_DUO_TEXT_COST_BASIS?.trim()
	)
		return {
			micros: setting(environment, "HOTEL_LOBBY_DUO_TEXT_REVIEW_COST_MICROS", true),
			basis: environment.HOTEL_LOBBY_DUO_TEXT_COST_BASIS.trim(),
		};
	throw new Error("SOURCE_TEMPLATE_PRICE_CONFIG_REQUIRED:SOURCE_TEMPLATE_TEXT_REVIEW_COST_MICROS");
}

/** Local price preparation only. Does not authorize funding, moderation, provider work or publication. */
export function resolveSourceTemplatePrice(
	request: SourceTemplatePriceRequest,
	rawEnvironment: Environment,
) {
	const environment: Environment = expandVideoRuntimeEnvironment(rawEnvironment);
	const cost = supplierCost(request, environment);
	const visual =
		cost.duration === null
			? configuredProviderOwnedVideoVisualSafetyProfile(environment)
			: configuredVideoVisualSafetyProfile(environment, cost.duration);
	if (
		visual.provider !== "seeapi" ||
		environment.VIDEO_COST_VISUAL_POLICY_VERSION !== visual.policyVersion
	)
		throw new Error("SOURCE_TEMPLATE_PRICE_VISUAL_POLICY_MISMATCH");
	const text = textCost(environment, cost.duration === null);
	// Each new customer image is reviewed once. Frozen administrator material was reviewed at import.
	// Round each separate request up, rather than rounding a batch down.
	const inputModerationCostMicros =
		BigInt(cost.userImageCount) * seeapiSupplierCreditsCostMicros(1n, 100n, environment);
	const frames = visual.sampling.numFrames;
	const outputModerationCostMicros = seeapiSupplierCreditsCostMicros(
		BigInt(50 + 2 * (frames - 8)),
		100n,
		environment,
	);
	const moderationCostMicros = inputModerationCostMicros + outputModerationCostMicros + text.micros;
	// Same family anchors and duration/resolution surcharges as the existing retail matrix.
	// Provider-owned templates have a per-generation base, without an invented duration surcharge.
	const rawMarkupBps =
		11_000n +
		BigInt(cost.duration === null ? 0 : cost.duration - 4) * 1_500n +
		BigInt(cost.resolutionSteps) * 20_000n +
		(cost.nonBaseMode ? 30_000n : 0n);
	const markupBps = rawMarkupBps > 100_000n ? 100_000n : rawMarkupBps;
	const policy: VideoCostPolicy = {
		moderationBaseMicros: moderationCostMicros,
		moderationPerSecondMicros: 0n,
		audioModerationPerSecondMicros: 0n,
		runtimeMicros: setting(environment, "VIDEO_COST_RUNTIME_MICROS"),
		storageMicros: setting(environment, "VIDEO_COST_STORAGE_MICROS"),
		paymentFixedAllocationMicros: setting(environment, "VIDEO_COST_PAYMENT_FIXED_MICROS", true),
		paymentFeeBps: setting(environment, "VIDEO_COST_PAYMENT_FEE_BPS", true),
		nonBillableFailureBps: setting(environment, "VIDEO_COST_NONBILLABLE_FAILURE_BPS"),
		markupBps,
	};
	const price = calculateVideoRetailPrice({
		providerCostMicros: cost.providerCostMicros,
		// A neutral calculation dimension only; all time-derived costs are already explicit.
		duration: cost.duration ?? 1,
		sound: true,
		policy,
		creditFloorMicros: HISTORICAL_VIDEO_RETAIL_REFERENCE_MICROS_PER_CREDIT,
	});
	const conversion = creditBasis(environment);
	return {
		options: Object.fromEntries(
			SOURCE_TEMPLATE_PRICE_OPTION_KEYS.flatMap((key) =>
				request.options[key] === undefined ? [] : [[key, request.options[key]]],
			),
		),
		credits: price.credits.toString(),
		providerCostMicros: cost.providerCostMicros.toString(),
		moderationCostMicros: moderationCostMicros.toString(),
		pricingVersion: `${SOURCE_TEMPLATE_PRICE_VERSION}/${VIDEO_RETAIL_REFERENCE_PRICE_VERSION}`,
		pricingBasis: JSON.stringify({
			observedAt: "2026-11-06",
			supplier: cost.rateBasis,
			seeapiConversion: {
				basis: conversion.description,
				usdMicros: conversion.usdMicros.toString(),
				supplierCredits: conversion.credits.toString(),
				rounding: "ceil-each-request-to-USD-micro",
			},
			moderation: {
				imageRule: "nsfw-filter-2:0.01-credit/request",
				userImages: cost.userImageCount,
				inputMicros: inputModerationCostMicros.toString(),
				outputRule: "video-nsfw-filter:return_frames=none;0.5+0.02*max(0,frames-8)",
				frames,
				outputMicros: outputModerationCostMicros.toString(),
				textMicros: text.micros.toString(),
				textBasis: text.basis,
				audioReview: "not_requested",
			},
			retailReference: {
				version: VIDEO_RETAIL_REFERENCE_PRICE_VERSION,
				usdMicrosPerCredit: HISTORICAL_VIDEO_RETAIL_REFERENCE_MICROS_PER_CREDIT.toString(),
				markupBps: markupBps.toString(),
				policy: Object.fromEntries(
					Object.entries(policy).map(([key, value]) => [key, value.toString()]),
				),
				budgetBasis:
					environment.SOURCE_TEMPLATE_RUNTIME_COST_BASIS?.trim() ??
					"explicit configured runtime, storage, payment and failure budgets; not an account invoice",
			},
			funding: "shared-media-credits-v1",
			paidRevenueQualified: false,
			costScope:
				"budget for one generation, user input review, output review, text review when present, runtime, storage, failure reserve and payment fees; no scene generation or audio mixing",
		}),
	};
}
