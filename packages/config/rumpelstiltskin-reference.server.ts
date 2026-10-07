import { z } from "zod";

import { PUBLIC_CREDIT_PACKS } from "./credit-packs";
import { PLAN_ENTITLEMENTS } from "./plans";

export const RUMPELSTILTSKIN_TEMPLATE_VERSION = "rumpelstiltskin-reference-2026-10-07.1";
export const RUMPELSTILTSKIN_PRICE_VERSION = "rumpelstiltskin-cost-2026-10-07.1";
export const RUMPELSTILTSKIN_SAFETY_POLICY_VERSION = "rumpelstiltskin-safety-2026-10-07.1";

/** Public sources plus explicit operating allowances, authorized independently of legacy templates.
 * These allowances are not supplier invoices, measured failure rates, or a live trial budget. */
export const RUMPELSTILTSKIN_PUBLIC_COST_POLICY = {
	checkedAt: "2026-10-07T17:15:24Z",
	validUntil: "2026-10-14T16:47:22Z",
	providerUsdMicrosPerBilledSecond: "125000",
	sourceUrls: [
		"https://kie.ai/seedance-2-0?model=bytedance/seedance-2",
		"https://docs.kie.ai/market/bytedance/seedance-2",
		"https://www.seeapi.com/docs/nsfw-filter/image-moderation/",
		"https://www.seeapi.com/docs/video-nsfw-filter/video-moderation/",
		"https://waffo.com/en/fraud-protection",
		"https://stripe.com/pricing",
		"https://waffo.com/en/pricing",
		"https://developers.cloudflare.com/r2/pricing/",
		"https://developers.cloudflare.com/workers/platform/pricing/",
	],
	assumptions:
		"Conservative operator budgets, not measured charges: subject $0.005, motion $0.05, output $0.05, prompt $0.01, runtime $0.10, storage/transfer $0.05; payment 10% plus $0.50 per video; nonbillable failure allowance 25%. No promotional supplier price, free quota, fee amortization or moderation free beta is assumed.",
} as const;

const identity = z.string().trim().min(1).max(160);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().datetime({ offset: true });
const objectKey = z
	.string()
	.min(1)
	.max(512)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/)
	.refine((value) => value.split("/").every((part) => part && part !== "." && part !== ".."));

/** Private manifest, never browser data. DB admission must verify this exact physical asset,
 * its administrator owner and persisted SeeAPI decision envelope against decisionHash.
 * A syntactically valid manifest alone is not evidence of approval. */
export const approvedRumpelstiltskinMotionReferenceSchema = z
	.object({
		assetId: identity,
		ownerId: identity,
		objectKey,
		sha256: hash,
		etag: z.string().min(1).max(256),
		storageVersionId: z.string().min(1).max(256).nullable(),
		bytes: z.number().int().positive().max(50_000_000),
		mimeType: z.literal("video/mp4"),
		durationSeconds: z.number().min(2).max(15),
		width: z.number().int().min(300).max(6000),
		height: z.number().int().min(300).max(6000),
		fps: z.number().min(24).max(60),
		audioTrackCount: z.literal(0),
		version: identity,
		review: z
			.object({
				decision: z.literal("ALLOW"),
				policyVersion: z.literal("seeapi-video-policy-2026-10-04.1"),
				decisionHash: hash,
				verificationGeneration: z.number().int().nonnegative(),
				validUntil: date,
			})
			.strict(),
		rights: z.object({ approvalId: identity, validUntil: date }).strict(),
	})
	.strict()
	.refine((reference) => {
		const pixels = reference.width * reference.height;
		const ratio = reference.width / reference.height;
		return pixels >= 409_600 && pixels <= 927_408 && ratio >= 0.4 && ratio <= 2.5;
	}, "Motion reference dimensions are outside the approved provider contract");
export type ApprovedRumpelstiltskinMotionReference = z.infer<
	typeof approvedRumpelstiltskinMotionReferenceSchema
>;

/** History parses the frozen schema without mutable expiry checks. New work must use this reader. */
export function readApprovedRumpelstiltskinMotionReference(
	environment: Record<string, string | undefined>,
	now = Date.now(),
): ApprovedRumpelstiltskinMotionReference {
	const raw = environment.RUMPELSTILTSKIN_APPROVED_MOTION_REFERENCE;
	if (!raw) throw new Error("RUMPELSTILTSKIN_REFERENCE_NOT_APPROVED");
	let input: unknown;
	try {
		input = JSON.parse(raw);
	} catch {
		throw new Error("RUMPELSTILTSKIN_REFERENCE_INVALID");
	}
	const parsed = approvedRumpelstiltskinMotionReferenceSchema.safeParse(input);
	if (!parsed.success) throw new Error("RUMPELSTILTSKIN_REFERENCE_INVALID");
	if (
		Date.parse(parsed.data.review.validUntil) <= now ||
		Date.parse(parsed.data.rights.validUntil) <= now
	)
		throw new Error("RUMPELSTILTSKIN_REFERENCE_EXPIRED");
	return parsed.data;
}

const micros = z.string().regex(/^\d{1,14}$/);
const positiveMicros = micros.refine((value) => BigInt(value) > 0n);
function catalogCreditFloorMicros(): bigint {
	const floors = [
		...PLAN_ENTITLEMENTS.flatMap((plan) =>
			plan.prices.map(
				(price) =>
					BigInt(Math.round(price.amount * 1_000_000)) /
					BigInt(plan.monthlyCredits * (price.interval === "year" ? 12 : 1)),
			),
		),
		...PUBLIC_CREDIT_PACKS.map(
			(pack) => BigInt(Math.round(pack.price.amount * 1_000_000)) / BigInt(pack.subscriberCredits),
		),
	];
	if (!floors.length || floors.some((floor) => floor <= 0n))
		throw new Error("RUMPELSTILTSKIN_REVENUE_NOT_APPROVED");
	return floors.reduce((minimum, floor) => (floor < minimum ? floor : minimum));
}
/** Independent complete-cost approval. No legacy public tariff or template budget is inherited. */
export const rumpelstiltskinCostApprovalSchema = z
	.object({
		schemaVersion: z.literal(1),
		approvalId: identity,
		approvedAt: date,
		templateVersion: z.literal(RUMPELSTILTSKIN_TEMPLATE_VERSION),
		pricingVersion: z.literal(RUMPELSTILTSKIN_PRICE_VERSION),
		safetyPolicyVersion: z.literal(RUMPELSTILTSKIN_SAFETY_POLICY_VERSION),
		basis: z.string().trim().min(1).max(2000),
		validUntil: date,
		evidence: z
			.object({
				kind: z.literal("public-source-conservative-budget"),
				checkedAt: date,
				sourceUrls: z.array(z.string().url()).min(1).max(12),
				assumptions: z.string().trim().min(1).max(2000),
			})
			.strict()
			.optional(),
		// Actual currently purchasable discounted USD receipts / ALL issued credits, including bonuses.
		// Fees are deducted separately. An unverified coupon or merchant rate cannot fill this approval.
		revenue: z
			.object({
				minimumGrossUsdMicrosPerCredit: positiveMicros,
				basis: z.string().trim().min(1).max(2000),
				validUntil: date,
			})
			.strict(),
		provider: z
			.object({
				productKey: z.literal("video-seedance-2"),
				executionKind: z.literal("seedance-reference"),
				durationSeconds: z.literal(5),
				resolution: z.literal("720p"),
				aspectRatio: z.literal("9:16"),
				sound: z.literal(false),
				referenceVersion: identity,
				referenceDurationSeconds: z.number().min(2).max(15),
				totalCostMicros: positiveMicros,
				basis: z.string().trim().min(1).max(2000),
			})
			.strict(),
		policies: z
			.object({
				visualPolicyVersion: z.literal("seeapi-video-policy-2026-10-04.1"),
				textRuleVersion: z.literal("waffo-prompt-safety-2026-10-04.1"),
				promptCostBasis: z.string().trim().min(1).max(2000),
				paymentCostBasis: z.string().trim().min(1).max(2000),
			})
			.strict(),
		costs: z
			.object({
				subjectImageReviewMicros: positiveMicros,
				referenceVideoReviewMicros: positiveMicros,
				outputVideoReviewBaseMicros: positiveMicros,
				outputVideoReviewPerSecondMicros: micros,
				promptReviewEachMicros: micros,
				runtimeMicros: positiveMicros,
				storageTransferMicros: positiveMicros,
				paymentFixedAllocationMicros: micros,
				paymentFeeBps: z.number().int().min(0).max(9999),
				nonBillableFailureBps: z.number().int().min(1).max(9999),
				markupBps: z.number().int().min(20_000).max(100_000),
			})
			.strict(),
	})
	.strict();
export type RumpelstiltskinCostApproval = z.infer<typeof rumpelstiltskinCostApprovalSchema>;

export function createPublicRumpelstiltskinCostApproval(
	reference: ApprovedRumpelstiltskinMotionReference,
	now = Date.now(),
): RumpelstiltskinCostApproval {
	const approved = approvedRumpelstiltskinMotionReferenceSchema.safeParse(reference);
	if (!approved.success) throw new Error("RUMPELSTILTSKIN_REFERENCE_INVALID");
	if (
		Date.parse(approved.data.review.validUntil) <= now ||
		Date.parse(approved.data.rights.validUntil) <= now
	)
		throw new Error("RUMPELSTILTSKIN_REFERENCE_EXPIRED");
	const policy = RUMPELSTILTSKIN_PUBLIC_COST_POLICY;
	if (Date.parse(policy.checkedAt) > now || Date.parse(policy.validUntil) <= now)
		throw new Error("RUMPELSTILTSKIN_COST_EXPIRED");
	// Round fractional reference seconds up; both the input clip and fixed output are billed.
	const providerCost =
		BigInt(Math.ceil(approved.data.durationSeconds) + 5) *
		BigInt(policy.providerUsdMicrosPerBilledSecond);
	return rumpelstiltskinCostApprovalSchema.parse({
		schemaVersion: 1,
		approvalId: "rumpelstiltskin-public-budget-2026-10-07.1",
		approvedAt: policy.checkedAt,
		templateVersion: RUMPELSTILTSKIN_TEMPLATE_VERSION,
		pricingVersion: RUMPELSTILTSKIN_PRICE_VERSION,
		safetyPolicyVersion: RUMPELSTILTSKIN_SAFETY_POLICY_VERSION,
		basis:
			"Kie Standard reference-video public tariff plus independently authorized conservative operating budgets; no account-specific receipt or live output is claimed.",
		validUntil: policy.validUntil,
		evidence: {
			kind: "public-source-conservative-budget",
			checkedAt: policy.checkedAt,
			sourceUrls: [...policy.sourceUrls],
			assumptions: policy.assumptions,
		},
		revenue: {
			minimumGrossUsdMicrosPerCredit: catalogCreditFloorMicros().toString(),
			basis:
				"Current USD catalog's lowest gross price per ALL issued paid credits, including annual and subscriber pack bonuses; lower discounted receipts require a lower explicit approval.",
			validUntil: policy.validUntil,
		},
		provider: {
			productKey: "video-seedance-2",
			executionKind: "seedance-reference",
			durationSeconds: 5,
			resolution: "720p",
			aspectRatio: "9:16",
			sound: false,
			referenceVersion: approved.data.version,
			referenceDurationSeconds: approved.data.durationSeconds,
			totalCostMicros: providerCost.toString(),
			basis: `${policy.sourceUrls[0]}; checked 2026-10-07T16:47:22Z; Standard 720p with-video $0.125 per total input+output second; fractional reference duration rounded up.`,
		},
		policies: {
			visualPolicyVersion: "seeapi-video-policy-2026-10-04.1",
			textRuleVersion: "waffo-prompt-safety-2026-10-04.1",
			promptCostBasis:
				"https://waffo.com/en/fraud-protection; prompt API has no public per-call USD quote; explicit $0.01 allowance, not an asserted tariff.",
			paymentCostBasis:
				"https://stripe.com/pricing and https://waffo.com/en/pricing; conservative 10% plus $0.50 per video, without fixed-fee amortization; not an account-specific rate.",
		},
		costs: {
			subjectImageReviewMicros: "5000",
			referenceVideoReviewMicros: "50000",
			outputVideoReviewBaseMicros: "50000",
			outputVideoReviewPerSecondMicros: "0",
			promptReviewEachMicros: "10000",
			runtimeMicros: "100000",
			storageTransferMicros: "50000",
			paymentFixedAllocationMicros: "500000",
			paymentFeeBps: 1000,
			nonBillableFailureBps: 2500,
			markupBps: 20000,
		},
	});
}

export function readRumpelstiltskinCostApproval(
	environment: Record<string, string | undefined>,
	reference?: ApprovedRumpelstiltskinMotionReference,
	now = Date.now(),
): RumpelstiltskinCostApproval {
	const raw = environment.RUMPELSTILTSKIN_COST_APPROVAL;
	let input: unknown;
	if (!raw) {
		if (!reference) throw new Error("RUMPELSTILTSKIN_COST_NOT_APPROVED");
		input = createPublicRumpelstiltskinCostApproval(reference, now);
	} else {
		try {
			input = JSON.parse(raw);
		} catch {
			throw new Error("RUMPELSTILTSKIN_COST_INVALID");
		}
	}
	const parsed = rumpelstiltskinCostApprovalSchema.safeParse(input);
	if (!parsed.success) throw new Error("RUMPELSTILTSKIN_COST_INVALID");
	const approval = parsed.data;
	if (Date.parse(approval.validUntil) <= now || Date.parse(approval.approvedAt) > now)
		throw new Error("RUMPELSTILTSKIN_COST_EXPIRED");
	if (
		Date.parse(approval.revenue.validUntil) <= now ||
		BigInt(approval.revenue.minimumGrossUsdMicrosPerCredit) > catalogCreditFloorMicros()
	)
		throw new Error("RUMPELSTILTSKIN_REVENUE_NOT_APPROVED");
	if (
		reference &&
		(approval.provider.referenceVersion !== reference.version ||
			approval.provider.referenceDurationSeconds !== reference.durationSeconds ||
			approval.policies.visualPolicyVersion !== reference.review.policyVersion)
	)
		throw new Error("RUMPELSTILTSKIN_COST_REFERENCE_MISMATCH");
	return approval;
}
