import { PUBLIC_CREDIT_PACKS } from "./credit-packs";
import { PLAN_ENTITLEMENTS } from "./plans";
import { getVideoModel, type VideoVeoTier } from "./video-models";
import { createVideoAudioSafetyPolicy } from "./video-output";
import { configuredVideoVisualSafetyProfile } from "./video-safety";
import { createVideoTextSafetyProfile } from "./video-text-safety";

/**
 * Public price basis: explicit Veo tiers observed on 2026-10-08; Mini/Fast
 * rechecked on 2026-10-07. Other tariffs retain their earlier source evidence.
 * Not an account-specific bill. See docs/operations/video-v1-price-basis-2026-10-08.md.
 */
export const VIDEO_SUPPLIER_PRICE_VERSION = "kie-public-2026-10-08.1";
export const VIDEO_RETAIL_PRICE_VERSION = "video-retail-2026-10-08.1";
export const VIDEO_ANNUAL_ELIGIBILITY_VERSION = "video-annual-eligibility-2026-10-08.1";
export type VideoRetailAudience = "standard" | "annual";
export type VideoRetailEligibility = {
	version: typeof VIDEO_ANNUAL_ELIGIBILITY_VERSION;
	ownerId: string;
	audience: VideoRetailAudience;
	subscriptionId: string | null;
	planKey: "creator" | "ultimate" | "studio" | null;
	validUntil: string | null;
};
export type VideoRetailDisplay = {
	policyVersion: string;
	audience: VideoRetailAudience;
	credits: string;
	standardCredits: string;
	annualCredits: string;
	savedCredits: string;
	annualSavingsCredits: string;
};
export type VideoRetailPricingContext = {
	audience?: VideoRetailAudience;
	eligibility?: VideoRetailEligibility;
};
export type VideoPricingSelection = {
	productKey: string;
	mode: "text-to-video" | "image-to-video";
	duration: number;
	resolution: string;
	sound: boolean;
	veoTier?: VideoVeoTier;
};

/** Fixed approved family anchors. UI defaults and click history never set retail policy. */
const retailBaselines: Record<
	string,
	{ seconds: number; resolutions: readonly string[]; anchor?: string; nonBaseMode?: boolean }
> = {
	"video-minimax-h3": { seconds: 4, resolutions: ["768p", "2k"] },
	"video-seedance-2-5": { seconds: 4, resolutions: ["480p", "720p", "1080p"] },
	"video-seedance-2-mini": { seconds: 4, resolutions: ["480p", "720p"] },
	"video-seedance-2-fast": {
		seconds: 4,
		resolutions: ["480p", "720p"],
		anchor: "video-seedance-2-mini",
		nonBaseMode: true,
	},
	"video-seedance-2": {
		seconds: 4,
		resolutions: ["480p", "720p", "1080p", "4k"],
		anchor: "video-seedance-2-mini",
		nonBaseMode: true,
	},
	"video-seedance-1-5-pro": { seconds: 4, resolutions: ["480p", "720p", "1080p"] },
	"video-seedance-1-pro-fast": { seconds: 5, resolutions: ["720p", "1080p"] },
	"video-gemini-omni-flash": { seconds: 4, resolutions: ["360p", "720p", "1080p", "4k"] },
	"video-kling-3": { seconds: 3, resolutions: ["720p", "1080p", "4k"] },
	"video-kling-3-turbo": {
		seconds: 3,
		resolutions: ["720p", "1080p"],
		anchor: "video-kling-3",
		nonBaseMode: true,
	},
	"video-kling-2-6-v1": { seconds: 5, resolutions: ["default"] },
	"video-veo-3-1": { seconds: 4, resolutions: ["720p", "1080p", "4k"] },
	"video-veo-3-1-fast": { seconds: 4, resolutions: ["720p", "1080p", "4k"] },
};

export function resolveVideoRetailTarget(request: VideoPricingSelection) {
	const baseline = retailBaselines[request.productKey];
	const model = getVideoModel(request.productKey);
	if (
		!baseline ||
		model?.status !== "implemented" ||
		!model.groups.some(
			(group) =>
				group.mode === request.mode &&
				group.durations.includes(request.duration) &&
				group.resolutions.includes(request.resolution) &&
				group.sounds.includes(request.sound) &&
				(group.veoTiers
					? request.veoTier !== undefined && group.veoTiers.includes(request.veoTier)
					: request.veoTier === undefined),
		)
	)
		throw new Error("VIDEO_MODEL_PRICE_UNAVAILABLE");
	const extraSeconds = request.duration - baseline.seconds;
	const resolutionSteps = baseline.resolutions.indexOf(request.resolution);
	if (extraSeconds < 0 || resolutionSteps < 0) throw new Error("VIDEO_MODEL_PRICE_UNAVAILABLE");
	const nonBaseMode = Boolean(
		baseline.nonBaseMode || (request.productKey === "video-veo-3-1" && request.veoTier !== "lite"),
	);
	const rawMarkupBps =
		11000n +
		BigInt(extraSeconds) * 1500n +
		BigInt(resolutionSteps) * 20000n +
		(nonBaseMode ? 30000n : 0n);
	const standardMarkupBps = rawMarkupBps > 100000n ? 100000n : rawMarkupBps;
	return {
		baselineProductKey: baseline.anchor ?? request.productKey,
		baselineSeconds: baseline.seconds,
		extraSeconds,
		resolutionSteps,
		nonBaseMode,
		rawMarkupBps,
		standardMarkupBps,
		annualMarkupBps: 11000n + (standardMarkupBps - 11000n) / 2n,
	};
}

export function isVideoRetailPricingApproved(environment: Record<string, string | undefined>) {
	const version = environment.VIDEO_RETAIL_PRICE_ACCEPTED_VERSION;
	if (version !== undefined && version !== VIDEO_RETAIL_PRICE_VERSION)
		throw new Error("VIDEO_RETAIL_PRICE_NOT_APPROVED");
	return version === VIDEO_RETAIL_PRICE_VERSION;
}

/** Whitelisted customer projection. Costs, markup and membership evidence stay server-side. */
export function readVideoRetailDisplay(details: unknown): VideoRetailDisplay | null {
	if (!details || typeof details !== "object" || !("retail" in details)) return null;
	const retail = details.retail;
	if (!retail || typeof retail !== "object" || !("display" in retail)) return null;
	const value = retail.display;
	if (!value || typeof value !== "object") return null;
	const display = value as Record<string, unknown>;
	if (
		display.policyVersion !== VIDEO_RETAIL_PRICE_VERSION ||
		!["standard", "annual"].includes(String(display.audience))
	)
		return null;
	for (const key of [
		"credits",
		"standardCredits",
		"annualCredits",
		"savedCredits",
		"annualSavingsCredits",
	])
		if (typeof display[key] !== "string" || !/^\d{1,16}$/.test(display[key])) return null;
	const standard = BigInt(display.standardCredits as string);
	const annual = BigInt(display.annualCredits as string);
	const charged = BigInt(display.credits as string);
	if (
		annual <= 0n ||
		annual > standard ||
		charged !== (display.audience === "annual" ? annual : standard) ||
		BigInt(display.savedCredits as string) !== standard - charged ||
		BigInt(display.annualSavingsCredits as string) !== standard - annual
	)
		return null;
	return {
		policyVersion: VIDEO_RETAIL_PRICE_VERSION,
		audience: display.audience as VideoRetailAudience,
		credits: display.credits as string,
		standardCredits: display.standardCredits as string,
		annualCredits: display.annualCredits as string,
		savedCredits: display.savedCredits as string,
		annualSavingsCredits: display.annualSavingsCredits as string,
	};
}
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
	if (input.veoTier !== undefined && input.productKey !== "video-veo-3-1")
		throw new Error("VIDEO_MODEL_PRICE_UNAVAILABLE");
	if (!Number.isSafeInteger(input.duration) || input.duration < 2 || input.duration > 30)
		throw new Error("VIDEO_MODEL_PRICE_UNAVAILABLE");
	const seconds = BigInt(input.duration);
	const resolution = input.resolution.toLowerCase();
	let rate: number | undefined;
	switch (input.productKey) {
		case "video-veo-3-1": {
			// Observed 2026-10-08 USD REGION PRICE, per video. High-resolution
			// creation includes the upgrade once; no recharge bonus is assumed.
			if (!input.veoTier || !input.sound || ![4, 6, 8].includes(input.duration)) break;
			const tariffs: Record<VideoVeoTier, Record<string, bigint>> = {
				lite: { "720p": 75_000n, "1080p": 112_500n, "4k": 375_000n },
				fast: { "720p": 150_000n, "1080p": 187_500n, "4k": 450_000n },
				quality: { "720p": 1_125_000n, "1080p": 1_162_500n, "4k": 1_425_000n },
			};
			const amount = tariffs[input.veoTier]?.[resolution];
			if (amount) return amount;
			break;
		}
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
			// Preserve this old endpoint's per-video budget and accepted order semantics.
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
	const priceApprovalExpiryMode: "none" | "until" =
		env.VIDEO_PRICE_VALID_UNTIL === "none" ? "none" : "until";
	const validUntil =
		priceApprovalExpiryMode === "none" ? null : Date.parse(env.VIDEO_PRICE_VALID_UNTIL ?? "");
	if (validUntil !== null && (!Number.isFinite(validUntil) || validUntil <= Date.now()))
		throw new Error("VIDEO_PRICE_EXPIRED");
	// Only the explicit operator setting "none" removes the approval deadline.
	// Missing or malformed settings deny approval; existing finite deadlines remain enforced.
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
		priceApprovalExpiryMode,
		visualSafetyProfile,
		textSafetyProfile,
	};
}

export function resolveVideoModelPrice(
	request: VideoPricingSelection,
	env: Record<string, string | undefined>,
	context: VideoRetailPricingContext = {},
) {
	const {
		providerCostMicros,
		policy,
		validUntil,
		priceApprovalExpiryMode,
		visualSafetyProfile,
		textSafetyProfile,
		pricingVersion,
		pricingBasis,
	} = resolveVideoModelCostBasis(request, env);
	const upgraded = isVideoRetailPricingApproved(env);
	const target = upgraded ? resolveVideoRetailTarget(request) : undefined;
	const audience = context.audience ?? "standard";
	if (audience !== "standard" && audience !== "annual")
		throw new Error("VIDEO_RETAIL_AUDIENCE_INVALID");
	const standard = calculateVideoRetailPrice({
		providerCostMicros,
		duration: request.duration,
		sound: request.sound,
		policy: target ? { ...policy, markupBps: target.standardMarkupBps } : policy,
	});
	const annual = target
		? calculateVideoRetailPrice({
				providerCostMicros,
				duration: request.duration,
				sound: request.sound,
				policy: { ...policy, markupBps: target.annualMarkupBps },
			})
		: standard;
	const result = target && audience === "annual" ? annual : standard;
	const effectivePolicy = target
		? {
				...policy,
				markupBps: audience === "annual" ? target.annualMarkupBps : target.standardMarkupBps,
			}
		: policy;
	const retail = target
		? {
				version: VIDEO_RETAIL_PRICE_VERSION,
				baselineProductKey: target.baselineProductKey,
				baselineSeconds: target.baselineSeconds,
				extraSeconds: target.extraSeconds,
				resolutionSteps: target.resolutionSteps,
				nonBaseMode: target.nonBaseMode,
				rawMarkupBps: target.rawMarkupBps.toString(),
				standardMarkupBps: target.standardMarkupBps.toString(),
				annualMarkupBps: target.annualMarkupBps.toString(),
				capOrder: "standard_then_annual_extra_half",
				...(context.eligibility ? { eligibility: context.eligibility } : {}),
				display: {
					policyVersion: VIDEO_RETAIL_PRICE_VERSION,
					audience,
					credits: result.credits.toString(),
					standardCredits: standard.credits.toString(),
					annualCredits: annual.credits.toString(),
					savedCredits: (standard.credits - result.credits).toString(),
					annualSavingsCredits: (standard.credits - annual.credits).toString(),
				} satisfies VideoRetailDisplay,
			}
		: undefined;
	return {
		credits: result.credits,
		pricingVersion: target
			? `${pricingVersion}/${VIDEO_RETAIL_PRICE_VERSION}/${audience}`
			: pricingVersion,
		pricingBasis,
		providerCostMicros,
		moderationCostMicros: result.moderationCostMicros,
		paidFundingPolicy: { minimumUsdMicrosPerCredit: result.creditFloorMicros },
		pricingDetails: {
			...(retail ? { retail } : {}),
			visualPolicyVersion: visualSafetyProfile.policyVersion,
			textRuleVersion: textSafetyProfile.ruleVersion,
			audioSafetyPolicy: createVideoAudioSafetyPolicy(),
			priceApprovalExpiryMode,
			validUntil: validUntil === null ? null : new Date(validUntil).toISOString(),
			costPolicy: Object.fromEntries(
				Object.entries(effectivePolicy).map(([key, value]) => [key, value.toString()]),
			),
			...Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.toString()])),
		},
	};
}
