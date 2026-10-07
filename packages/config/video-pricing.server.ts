import { PUBLIC_CREDIT_PACKS } from "./credit-packs";
import { PLAN_ENTITLEMENTS } from "./plans";
import { createVideoAudioSafetyPolicy } from "./video-output";
import { configuredVideoVisualSafetyProfile } from "./video-safety";
import { createVideoTextSafetyProfile } from "./video-text-safety";

/**
 * Public price basis: Mini/Fast rechecked on 2026-10-07; other tariffs retain
 * their earlier source evidence. This is not an account-specific billing receipt.
 * See docs/operations/video-v1-price-basis-2026-10-07.md.
 */
export const VIDEO_SUPPLIER_PRICE_VERSION = "kie-public-2026-10-07.1";
export type VideoPricingSelection = {
	productKey: string;
	mode: "text-to-video" | "image-to-video";
	duration: number;
	resolution: string;
	sound: boolean;
};
const BPS = 10_000n;
const ceil = (numerator: bigint, denominator: bigint) => {
	if (numerator < 0n || denominator <= 0n) throw new Error("VIDEO_PRICE_INVALID");
	return (numerator + denominator - 1n) / denominator;
};

/** Lowest gross USD revenue per issued paid credit, including annual/pack bonuses. */
export function videoPaidCreditFloorMicros(): bigint {
	const floors: bigint[] = [];
	for (const plan of PLAN_ENTITLEMENTS) {
		if (!plan.monthlyCredits) continue;
		for (const price of plan.prices) {
			floors.push(
				BigInt(Math.round(price.amount * 1_000_000)) /
					BigInt(plan.monthlyCredits * (price.interval === "year" ? 12 : 1)),
			);
		}
	}
	for (const pack of PUBLIC_CREDIT_PACKS) {
		floors.push(BigInt(Math.round(pack.price.amount * 1_000_000)) / BigInt(pack.subscriberCredits));
	}
	if (!floors.length || floors.some((value) => value <= 0n))
		throw new Error("VIDEO_CREDIT_REVENUE_UNVERIFIED");
	return floors.reduce((a, b) => (a < b ? a : b));
}

/** Only text/single-image input prices. Video-reference discounts do not apply. */
export function videoSupplierCostMicros(input: VideoPricingSelection): bigint {
	if (!Number.isSafeInteger(input.duration) || input.duration < 2 || input.duration > 30)
		throw new Error("VIDEO_MODEL_PRICE_UNAVAILABLE");
	const seconds = BigInt(input.duration);
	const resolution = input.resolution.toLowerCase();
	let rate: number | undefined;
	switch (input.productKey) {
		case "video-kling-2-6-v1":
			if (![5, 10].includes(input.duration) || resolution !== "default") break;
			return seconds * (input.sound ? 110_000n : 55_000n);
		case "video-kling-3":
			rate = (
				{
					"720p": input.sound ? 100_000 : 70_000,
					"1080p": input.sound ? 135_000 : 90_000,
					"4k": 335_000,
				} as Record<string, number>
			)[resolution];
			break;
		case "video-kling-3-turbo":
			rate = ({ "720p": 90_000, "1080p": 112_500 } as Record<string, number>)[resolution];
			break;
		case "video-minimax-h3":
			// The first five input images are free; this product accepts one image.
			rate = ({ "768p": 40_000, "2k": 65_000 } as Record<string, number>)[resolution];
			break;
		case "video-seedance-2-5":
			rate = ({ "480p": 140_000, "720p": 315_000, "1080p": 790_000 } as Record<string, number>)[
				resolution
			];
			break;
		case "video-seedance-2":
			rate = (
				{ "480p": 95_000, "720p": 205_000, "1080p": 510_000, "4k": 1_040_000 } as Record<
					string,
					number
				>
			)[resolution];
			break;
		case "video-seedance-2-mini":
			rate = ({ "480p": 19_000, "720p": 41_000 } as Record<string, number>)[resolution];
			break;
		case "video-seedance-2-fast":
			// The page rounds 11.7 Kie credits to $0.059; use the higher published USD amount.
			rate = ({ "480p": 59_000, "720p": 124_000 } as Record<string, number>)[resolution];
			break;
		case "video-seedance-1-5-pro":
			rate = (
				{
					"480p": input.sound ? 17_500 : 8_750,
					"720p": input.sound ? 35_000 : 17_500,
					"1080p": input.sound ? 75_000 : 37_500,
				} as Record<string, number>
			)[resolution];
			break;
		case "video-seedance-1-pro-fast": {
			if (input.mode !== "image-to-video" || input.sound) break;
			const amount = (
				{ "720p:5": 80_000, "720p:10": 180_000, "1080p:5": 180_000, "1080p:10": 360_000 } as Record<
					string,
					number
				>
			)[`${resolution}:${input.duration}`];
			if (amount) return BigInt(amount);
			break;
		}
		case "video-gemini-omni-flash": {
			if (!["360p", "720p", "1080p", "4k"].includes(resolution)) break;
			const cost = ({ 4: 315_000, 6: 420_000, 8: 525_000, 10: 630_000 } as Record<number, number>)[
				input.duration
			];
			if (cost) return BigInt(cost + (resolution === "4k" ? 420_000 : 0));
			break;
		}
		case "video-veo-3-1-fast": {
			// The old /veo/generate contract explicitly binds veo3_fast to Fast.
			// Published rates are per video, not per second; generic veo-3-1 remains unpriced.
			if (!input.sound || ![4, 6, 8].includes(input.duration)) break;
			const cost = ({ "720p": 300_000, "1080p": 325_000, "4k": 900_000 } as Record<string, number>)[
				resolution
			];
			if (cost) return BigInt(cost);
			break;
		}
	}
	if (!rate) throw new Error("VIDEO_MODEL_PRICE_UNAVAILABLE");
	return BigInt(rate) * seconds;
}

export type VideoCostPolicy = {
	moderationBaseMicros: bigint;
	moderationPerSecondMicros: bigint;
	audioModerationPerSecondMicros: bigint;
	runtimeMicros: bigint;
	storageMicros: bigint;
	paymentFixedAllocationMicros: bigint;
	paymentFeeBps: bigint;
	nonBillableFailureBps: bigint;
	markupBps: bigint;
};

/** Profit / complete variable cost, including revenue-proportional payment fees. */
export function calculateVideoRetailPrice(input: {
	providerCostMicros: bigint;
	duration: number;
	sound: boolean;
	policy: VideoCostPolicy;
	creditFloorMicros?: bigint;
}) {
	const p = input.policy;
	const creditFloorMicros = input.creditFloorMicros ?? videoPaidCreditFloorMicros();
	if (
		Object.values(p).some((value) => value < 0n) ||
		input.providerCostMicros <= 0n ||
		!Number.isSafeInteger(input.duration) ||
		input.duration <= 0 ||
		input.duration > 30 ||
		p.markupBps <= BPS ||
		p.markupBps > 100_000n ||
		p.paymentFeeBps >= BPS ||
		p.nonBillableFailureBps >= BPS ||
		creditFloorMicros <= 0n
	)
		throw new Error("VIDEO_PRICE_INVALID");
	const multiplier = BPS + p.markupBps;
	const denominator = BPS * BPS - multiplier * p.paymentFeeBps;
	if (denominator <= 0n) throw new Error("VIDEO_PRICE_INVALID");
	const moderationCostMicros =
		p.moderationBaseMicros +
		BigInt(input.duration) *
			(p.moderationPerSecondMicros + (input.sound ? p.audioModerationPerSecondMicros : 0n));
	const directCostMicros =
		input.providerCostMicros + moderationCostMicros + p.runtimeMicros + p.storageMicros;
	const riskAdjustedCostMicros = ceil(directCostMicros * BPS, BPS - p.nonBillableFailureBps);
	const nonPercentageCost = riskAdjustedCostMicros + p.paymentFixedAllocationMicros;
	// Extra one-micro payment-rounding reserve maintains the bound after fee ceil.
	const minimumRevenueMicros = ceil((nonPercentageCost + 1n) * multiplier * BPS, denominator);
	const credits = ceil(minimumRevenueMicros, creditFloorMicros);
	const minimumGrossRevenueMicros = credits * creditFloorMicros;
	const paymentFeeMicros =
		ceil(minimumGrossRevenueMicros * p.paymentFeeBps, BPS) + p.paymentFixedAllocationMicros;
	const completeCostMicros = riskAdjustedCostMicros + paymentFeeMicros;
	const profitMicros = minimumGrossRevenueMicros - completeCostMicros;
	if (profitMicros * BPS < completeCostMicros * p.markupBps)
		throw new Error("VIDEO_PROFIT_FLOOR_NOT_MET");
	return {
		credits,
		moderationCostMicros,
		creditFloorMicros,
		minimumGrossRevenueMicros,
		directCostMicros,
		riskAdjustedCostMicros,
		paymentFeeMicros,
		completeCostMicros,
		profitMicros,
		markupBps: (profitMicros * BPS) / completeCostMicros,
	};
}

function setting(env: Record<string, string | undefined>, key: string, allowZero = false): bigint {
	const value = env[key];
	if (!value || !/^\d{1,14}$/.test(value) || (!allowZero && BigInt(value) === 0n))
		throw new Error("VIDEO_COST_POLICY_NOT_CONFIGURED");
	return BigInt(value);
}

/** Shared approved cost basis; callers may add a template's costs before one retail calculation. */
export function resolveVideoModelCostBasis(
	request: VideoPricingSelection,
	env: Record<string, string | undefined>,
) {
	if (
		env.VIDEO_PRICE_ACCEPTED_VERSION !== VIDEO_SUPPLIER_PRICE_VERSION ||
		!env.VIDEO_PRICE_BASIS?.trim()
	)
		throw new Error("VIDEO_PRICE_NOT_APPROVED");
	const now = Date.now();
	const approvedValidUntil = Date.parse(env.VIDEO_PRICE_VALID_UNTIL ?? "");
	if (!Number.isFinite(approvedValidUntil) || approvedValidUntil <= now)
		throw new Error("VIDEO_PRICE_EXPIRED");
	// The refreshed Mini/Fast source has no announced successor cutoff. Quotes
	// still freeze the finite operator deadline; public prices are not perpetual approval.
	const validUntil = approvedValidUntil;
	const visualSafetyProfile = configuredVideoVisualSafetyProfile(env, request.duration);
	if (env.VIDEO_COST_VISUAL_POLICY_VERSION !== visualSafetyProfile.policyVersion)
		throw new Error("VIDEO_VISUAL_COST_POLICY_NOT_CONFIRMED");
	const textSafetyProfile = createVideoTextSafetyProfile();
	if (env.VIDEO_COST_TEXT_RULE_VERSION !== textSafetyProfile.ruleVersion)
		throw new Error("VIDEO_TEXT_COST_POLICY_NOT_CONFIRMED");
	const providerCostMicros = videoSupplierCostMicros(request);
	const policy: VideoCostPolicy = {
		moderationBaseMicros: setting(env, "VIDEO_COST_MODERATION_BASE_MICROS"),
		moderationPerSecondMicros: setting(env, "VIDEO_COST_MODERATION_PER_SECOND_MICROS"),
		audioModerationPerSecondMicros: 0n,
		runtimeMicros: setting(env, "VIDEO_COST_RUNTIME_MICROS"),
		storageMicros: setting(env, "VIDEO_COST_STORAGE_MICROS"),
		paymentFixedAllocationMicros: setting(env, "VIDEO_COST_PAYMENT_FIXED_MICROS", true),
		paymentFeeBps: setting(env, "VIDEO_COST_PAYMENT_FEE_BPS", true),
		nonBillableFailureBps: setting(env, "VIDEO_COST_NONBILLABLE_FAILURE_BPS"),
		markupBps: env.VIDEO_PRICE_MARKUP_BPS ? setting(env, "VIDEO_PRICE_MARKUP_BPS") : 11_000n,
	};
	return {
		pricingVersion: VIDEO_SUPPLIER_PRICE_VERSION,
		pricingBasis: env.VIDEO_PRICE_BASIS.trim(),
		providerCostMicros,
		policy,
		validUntil,
		visualSafetyProfile,
		textSafetyProfile,
	};
}

export function resolveVideoModelPrice(
	request: VideoPricingSelection,
	env: Record<string, string | undefined>,
) {
	const {
		providerCostMicros,
		policy,
		validUntil,
		visualSafetyProfile,
		textSafetyProfile,
		pricingVersion,
		pricingBasis,
	} = resolveVideoModelCostBasis(request, env);
	const result = calculateVideoRetailPrice({
		providerCostMicros,
		duration: request.duration,
		sound: request.sound,
		policy,
	});
	return {
		credits: result.credits,
		pricingVersion,
		pricingBasis,
		providerCostMicros,
		moderationCostMicros: result.moderationCostMicros,
		paidFundingPolicy: { minimumUsdMicrosPerCredit: result.creditFloorMicros },
		pricingDetails: {
			visualPolicyVersion: visualSafetyProfile.policyVersion,
			textRuleVersion: textSafetyProfile.ruleVersion,
			audioSafetyPolicy: createVideoAudioSafetyPolicy(),
			validUntil: new Date(validUntil).toISOString(),
			costPolicy: Object.fromEntries(
				Object.entries(policy).map(([key, value]) => [key, value.toString()]),
			),
			...Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.toString()])),
		},
	};
}
