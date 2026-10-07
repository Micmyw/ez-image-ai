import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	approvedRumpelstiltskinMotionReferenceSchema,
	readApprovedRumpelstiltskinMotionReference,
	readRumpelstiltskinCostApproval,
	RUMPELSTILTSKIN_TEMPLATE_VERSION,
	RUMPELSTILTSKIN_PRICE_VERSION,
	RUMPELSTILTSKIN_SAFETY_POLICY_VERSION,
} from "./rumpelstiltskin-reference.server";
import { RUMPELSTILTSKIN_PUBLIC_EFFECT, videoEffectRequestSchema } from "./video-effects";
import { canAccessVideoEffect, readVideoEffectAccessScope } from "./video-effects-access.server";
import {
	createVideoEffectTemplateSnapshot,
	parseVideoEffectTemplateSnapshot,
	resolveVideoEffectPrice,
	resolveVideoEffectTemplate,
} from "./video-effects.server";

// Entirely synthetic local contract fixtures, never a production asset, approval or price.
const reference = {
	assetId: "fixture-motion",
	ownerId: "fixture-admin",
	objectKey: "private/fixture-motion.mp4",
	sha256: "a".repeat(64),
	etag: "fixture-etag",
	storageVersionId: null,
	bytes: 1024,
	mimeType: "video/mp4",
	durationSeconds: 5,
	width: 720,
	height: 1280,
	fps: 30,
	audioTrackCount: 0,
	version: "fixture-reference-v1",
	review: {
		decision: "ALLOW",
		policyVersion: "seeapi-video-policy-2026-10-04.1",
		decisionHash: "b".repeat(64),
		verificationGeneration: 1,
		validUntil: "2026-10-09T00:00:00Z",
	},
	rights: { approvalId: "fixture-owned-rights", validUntil: "2026-10-10T00:00:00Z" },
};
const approval = {
	schemaVersion: 1,
	approvalId: "fixture-cost",
	approvedAt: "2026-10-06T00:00:00Z",
	templateVersion: RUMPELSTILTSKIN_TEMPLATE_VERSION,
	pricingVersion: RUMPELSTILTSKIN_PRICE_VERSION,
	safetyPolicyVersion: RUMPELSTILTSKIN_SAFETY_POLICY_VERSION,
	basis: "synthetic complete-cost fixture",
	validUntil: "2026-10-11T00:00:00Z",
	revenue: {
		minimumGrossUsdMicrosPerCredit: "21944",
		basis: "synthetic lowest annual and bonus-inclusive receipts",
		validUntil: "2026-10-11T00:00:00Z",
	},
	provider: {
		productKey: "video-seedance-2",
		executionKind: "seedance-reference",
		durationSeconds: 5,
		resolution: "720p",
		aspectRatio: "9:16",
		sound: false,
		referenceVersion: reference.version,
		referenceDurationSeconds: 5,
		totalCostMicros: "500000",
		basis: "synthetic reference-input supplier tariff",
	},
	policies: {
		visualPolicyVersion: "seeapi-video-policy-2026-10-04.1",
		textRuleVersion: "waffo-prompt-safety-2026-10-04.1",
		promptCostBasis: "synthetic explicit cost",
		paymentCostBasis: "synthetic explicit merchant allocation",
	},
	costs: {
		subjectImageReviewMicros: "1000",
		referenceVideoReviewMicros: "2000",
		outputVideoReviewBaseMicros: "3000",
		outputVideoReviewPerSecondMicros: "100",
		promptReviewEachMicros: "10",
		runtimeMicros: "10000",
		storageTransferMicros: "3000",
		paymentFixedAllocationMicros: "1000",
		paymentFeeBps: 800,
		nonBillableFailureBps: 1000,
		markupBps: 20000,
	},
};
const request = {
	effectId: "rumpelstiltskin-solo" as const,
	presetKey: "standard" as const,
	inputs: { leftAssetId: "fixture-subject", rightAssetId: "fixture-subject" },
};
function referencePrice(env: Record<string, string | undefined>) {
	const price = resolveVideoEffectPrice(request, env);
	const pricingDetails = price.pricingDetails;
	if (pricingDetails.effectId !== "rumpelstiltskin-solo")
		throw new Error("Expected reference-template price");
	return { ...price, pricingDetails };
}
function environment() {
	return {
		VIDEO_V1_ENABLED: "true",
		RUMPELSTILTSKIN_ENABLED: "true",
		RUMPELSTILTSKIN_ACCESS: "internal",
		RUMPELSTILTSKIN_ALLOWED_USER_IDS: "fixture-tester",
		RUMPELSTILTSKIN_ACCEPTED_TEMPLATE_VERSION: RUMPELSTILTSKIN_TEMPLATE_VERSION,
		RUMPELSTILTSKIN_APPROVED_MOTION_REFERENCE: JSON.stringify(reference),
		RUMPELSTILTSKIN_COST_APPROVAL: JSON.stringify(approval),
		VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
		VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
		VIDEO_MODEL_ALLOWED_OPTIONS: JSON.stringify([
			{
				productKey: "video-seedance-2",
				modes: ["image-to-video"],
				durations: [5],
				resolutions: ["720p"],
				sounds: [false],
			},
		]),
	};
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-07T00:00:00Z"));
});
afterEach(() => {
	vi.useRealTimers();
});

describe("independent internal motion-reference contract", () => {
	it("accepts one subject and refuses a second uploaded identity or client motion override", () => {
		expect(videoEffectRequestSchema.parse(request)).toEqual(request);
		expect(
			videoEffectRequestSchema.safeParse({
				...request,
				inputs: { ...request.inputs, rightAssetId: "another" },
			}).success,
		).toBe(false);
		for (const key of [
			"approvedMotionReference",
			"referenceVideoUrl",
			"motionAssetId",
			"prompt",
			"costApproval",
		])
			expect(videoEffectRequestSchema.safeParse({ ...request, [key]: reference }).success).toBe(
				false,
			);
		expect(JSON.stringify(RUMPELSTILTSKIN_PUBLIC_EFFECT)).not.toMatch(
			/provider|seedance|sha256|objectKey|approval/i,
		);
	});
	it("requires its exact internal whitelist independently of administrator role and ordinary access", () => {
		const env = {
			...environment(),
			VIDEO_V1_ACCESS: "authenticated",
			HOTEL_LOBBY_DUO_ACCESS: "authenticated",
			VIDEO_V1_ALLOWED_USER_IDS: "different-tester",
		};
		expect(
			canAccessVideoEffect(env, { id: "fixture-tester", role: "user" }, request.effectId),
		).toBe(true);
		for (const user of [
			{ id: "different-tester" },
			{ id: "administrator", role: "admin" },
			{ id: "fixture-tester", isAnonymous: true },
			null,
		])
			expect(canAccessVideoEffect(env, user, request.effectId)).toBe(false);
		for (const access of ["authenticated", "public", " internal", ""])
			expect(
				readVideoEffectAccessScope({ ...env, RUMPELSTILTSKIN_ACCESS: access }, request.effectId),
			).toBeNull();
		for (const key of [
			"VIDEO_V1_ENABLED",
			"RUMPELSTILTSKIN_ENABLED",
			"RUMPELSTILTSKIN_ALLOWED_USER_IDS",
		])
			expect(
				canAccessVideoEffect(
					{ ...env, [key]: undefined },
					{ id: "fixture-tester", role: "admin" },
					request.effectId,
				),
			).toBe(false);
	});
	it("does not reinterpret or change any legacy snapshot as a reference contract", () => {
		const legacy = createVideoEffectTemplateSnapshot({
			effectId: "hotel-lobby-duo",
			presetKey: "standard",
			inputs: { leftAssetId: "left", rightAssetId: "right" },
		});
		expect(parseVideoEffectTemplateSnapshot(legacy)).toEqual(legacy);
		expect(legacy.schemaVersion).toBe(1);
		expect(() =>
			parseVideoEffectTemplateSnapshot({ ...legacy, effectId: request.effectId }),
		).toThrow();
		expect(() =>
			parseVideoEffectTemplateSnapshot({ ...legacy, executionKind: "seedance-reference" }),
		).toThrow();
	});
	it("freezes a distinct reference binding without claiming fixed-camera support", () => {
		const snapshot = createVideoEffectTemplateSnapshot(request, environment());
		expect(snapshot).toMatchObject({
			schemaVersion: 2,
			executionKind: "seedance-reference",
			approvedMotionReference: reference,
			video: { productKey: "video-seedance-2", duration: 5, sound: false, fixedLens: false },
		});
		expect(snapshot.video.prompt).toContain("LEFT");
		expect(snapshot.video.prompt).toContain("SECOND");
		expect(snapshot.video.prompt).toContain("tiptoe");
		expect(() => parseVideoEffectTemplateSnapshot({ ...snapshot, schemaVersion: 1 })).toThrow();
		expect(() =>
			parseVideoEffectTemplateSnapshot({
				...snapshot,
				video: { ...snapshot.video, productKey: "video-seedance-1-5-pro" },
			}),
		).toThrow();
		vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
		expect(parseVideoEffectTemplateSnapshot(snapshot)).toEqual(snapshot);
		expect(() => createVideoEffectTemplateSnapshot(request, environment())).toThrow(
			"RUMPELSTILTSKIN_REFERENCE_EXPIRED",
		);
	});
	it.each([
		{ referenceVideoUrl: "https://untrusted.example/video.mp4" },
		{ objectKey: "../private/fixture.mp4" },
		{ objectKey: "https://untrusted.example/video.mp4" },
		{ sha256: "unknown" },
		{ bytes: 50_000_001 },
		{ durationSeconds: 16 },
		{ audioTrackCount: 1 },
		{ width: 1920, height: 1080 },
		{ fps: 10 },
		{ review: { ...reference.review, decision: "REVIEW" } },
		{ rights: { ...reference.rights, approvalId: "" } },
	])("rejects malformed or unapproved reference binding %j", (override) => {
		expect(
			approvedRumpelstiltskinMotionReferenceSchema.safeParse({ ...reference, ...override }).success,
		).toBe(false);
	});
	it("fails closed for missing material, disabled template, unaccepted version and model option", () => {
		expect(() => resolveVideoEffectTemplate(request, {})).toThrow("VIDEO_EFFECT_DISABLED");
		expect(() => createVideoEffectTemplateSnapshot(request)).toThrow(
			"RUMPELSTILTSKIN_REFERENCE_NOT_APPROVED",
		);
		expect(() =>
			resolveVideoEffectTemplate(request, {
				...environment(),
				RUMPELSTILTSKIN_ACCEPTED_TEMPLATE_VERSION: "old",
			}),
		).toThrow("VIDEO_EFFECT_TEMPLATE_NOT_CONFIRMED");
		expect(() =>
			resolveVideoEffectTemplate(request, { ...environment(), VIDEO_MODEL_ALLOWED_OPTIONS: "[]" }),
		).toThrow();
		for (const part of ["review", "rights"] as const)
			expect(() =>
				readApprovedRumpelstiltskinMotionReference({
					...environment(),
					RUMPELSTILTSKIN_APPROVED_MOTION_REFERENCE: JSON.stringify({
						...reference,
						[part]: { ...reference[part], validUntil: "2026-10-07T00:00:00Z" },
					}),
				}),
			).toThrow("RUMPELSTILTSKIN_REFERENCE_EXPIRED");
	});
});

describe("independent complete reference-video cost approval", () => {
	it("cannot obtain a quote by inheriting legacy costs, public tariffs or funding", () => {
		const env = {
			...environment(),
			RUMPELSTILTSKIN_COST_APPROVAL: undefined,
			HOTEL_LOBBY_DUO_PRICE_VERSION: "hotel-lobby-duo-cost-2026-10-05.2",
			HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: "2026-11-01T00:00:00Z",
			VIDEO_PRICE_ACCEPTED_VERSION: "kie-public-2026-10-04.3",
			VIDEO_PRICE_VALID_UNTIL: "2026-11-01T00:00:00Z",
		};
		expect(() => resolveVideoEffectPrice(request, env)).toThrow(
			"RUMPELSTILTSKIN_COST_NOT_APPROVED",
		);
	});
	it("counts a subject image, reference video, output video and the one submitted prompt explicitly", () => {
		const price = resolveVideoEffectPrice(request, environment());
		expect(price.providerCostMicros).toBe(500000n);
		expect(price.moderationCostMicros).toBe(6510n);
		expect(price.pricingDetails.textReviewCount).toBe(1);
		expect(price.pricingVersion).toBe(RUMPELSTILTSKIN_PRICE_VERSION);
		expect(price.pricingDetails.validUntil).toBe("2026-10-09T00:00:00.000Z");
		expect(price.pricingDetails.minimumRevenueToCostBps).toBe("30000");
		expect(price.paidFundingPolicy.minimumUsdMicrosPerCredit).toBeGreaterThan(0n);
		const expensive = resolveVideoEffectPrice(request, {
			...environment(),
			RUMPELSTILTSKIN_COST_APPROVAL: JSON.stringify({
				...approval,
				provider: { ...approval.provider, totalCostMicros: "1000000" },
			}),
		});
		expect(expensive.credits).toBeGreaterThan(price.credits);
	});
	it("prices diluted discounted and bonus credits at their reviewed lower gross receipt value", () => {
		const regular = resolveVideoEffectPrice(request, environment());
		const discounted = referencePrice({
			...environment(),
			RUMPELSTILTSKIN_COST_APPROVAL: JSON.stringify({
				...approval,
				revenue: {
					...approval.revenue,
					minimumGrossUsdMicrosPerCredit: "15000",
					basis: "synthetic all-issued-credit discounted receipt",
				},
			}),
		});
		expect(discounted.credits).toBeGreaterThan(regular.credits);
		expect(discounted.paidFundingPolicy.minimumUsdMicrosPerCredit).toBe(15000n);
		expect(discounted.pricingDetails.creditFloorMicros).toBe("15000");
		expect(BigInt(discounted.pricingDetails.minimumGrossRevenueMicros)).toBe(
			discounted.credits * 15000n,
		);
		const net = BigInt(discounted.pricingDetails.minimumNetRevenueMicros);
		const cost = BigInt(discounted.pricingDetails.riskAdjustedOperatingCostMicros);
		expect(net).toBe(
			BigInt(discounted.pricingDetails.minimumGrossRevenueMicros) -
				BigInt(discounted.pricingDetails.paymentFeeMicros),
		);
		expect(net).toBeGreaterThanOrEqual(3n * cost);
		expect(BigInt(discounted.pricingDetails.netProfitBps)).toBeGreaterThanOrEqual(20000n);
	});
	it.each([0, 750, 1000, 3000])(
		"maintains at least 200 percent net contribution on full failure-adjusted cost at %s fee bps",
		(paymentFeeBps) => {
			for (const nonBillableFailureBps of [1, 1000, 4000]) {
				const price = referencePrice({
					...environment(),
					RUMPELSTILTSKIN_COST_APPROVAL: JSON.stringify({
						...approval,
						costs: { ...approval.costs, paymentFeeBps, nonBillableFailureBps },
					}),
				});
				const gross = BigInt(price.pricingDetails.minimumGrossRevenueMicros);
				const fee = BigInt(price.pricingDetails.paymentFeeMicros);
				const net = BigInt(price.pricingDetails.minimumNetRevenueMicros);
				const cost = BigInt(price.pricingDetails.riskAdjustedOperatingCostMicros);
				expect(net).toBe(gross - fee);
				expect(net - cost).toBe(BigInt(price.pricingDetails.netContributionProfitMicros));
				expect((net - cost) * 10000n).toBeGreaterThanOrEqual(cost * 20000n);
				expect(cost).toBeGreaterThan(BigInt(price.pricingDetails.directCostMicros));
			}
		},
	);
	it("rounds the no-fee net margin boundary upward and charges more for larger fees and failure losses", () => {
		const price = referencePrice({
			...environment(),
			RUMPELSTILTSKIN_COST_APPROVAL: JSON.stringify({
				...approval,
				costs: { ...approval.costs, paymentFeeBps: 0, paymentFixedAllocationMicros: "0" },
			}),
		});
		const cost = BigInt(price.pricingDetails.riskAdjustedOperatingCostMicros);
		const floor = price.paidFundingPolicy.minimumUsdMicrosPerCredit;
		expect(price.credits * floor).toBeGreaterThanOrEqual(3n * cost);
		expect((price.credits - 1n) * floor).toBeLessThan(3n * cost);
		const regular = resolveVideoEffectPrice(request, environment());
		const costly = resolveVideoEffectPrice(request, {
			...environment(),
			RUMPELSTILTSKIN_COST_APPROVAL: JSON.stringify({
				...approval,
				costs: { ...approval.costs, paymentFeeBps: 1000, nonBillableFailureBps: 2000 },
			}),
		});
		expect(costly.credits).toBeGreaterThan(regular.credits);
	});
	it("refuses an unreviewed, expired or above-cheapest-catalog revenue assumption", () => {
		const missingRevenue: Record<string, unknown> = { ...approval };
		delete missingRevenue.revenue;
		expect(() =>
			readRumpelstiltskinCostApproval({
				...environment(),
				RUMPELSTILTSKIN_COST_APPROVAL: JSON.stringify(missingRevenue),
			}),
		).toThrow("RUMPELSTILTSKIN_COST_INVALID");
		for (const key of ["minimumGrossUsdMicrosPerCredit", "basis", "validUntil"]) {
			const revenue: Record<string, unknown> = { ...approval.revenue };
			delete revenue[key];
			expect(() =>
				readRumpelstiltskinCostApproval({
					...environment(),
					RUMPELSTILTSKIN_COST_APPROVAL: JSON.stringify({ ...approval, revenue }),
				}),
			).toThrow("RUMPELSTILTSKIN_COST_INVALID");
		}
		for (const revenue of [
			{ ...approval.revenue, minimumGrossUsdMicrosPerCredit: "21945" },
			{ ...approval.revenue, validUntil: "2026-10-07T00:00:00Z" },
		])
			expect(() =>
				resolveVideoEffectPrice(request, {
					...environment(),
					RUMPELSTILTSKIN_COST_APPROVAL: JSON.stringify({ ...approval, revenue }),
				}),
			).toThrow("RUMPELSTILTSKIN_REVENUE_NOT_APPROVED");
		const price = resolveVideoEffectPrice(request, {
			...environment(),
			RUMPELSTILTSKIN_COST_APPROVAL: JSON.stringify({
				...approval,
				revenue: { ...approval.revenue, validUntil: "2026-10-08T00:00:00Z" },
			}),
		});
		expect(price.pricingDetails.validUntil).toBe("2026-10-08T00:00:00.000Z");
	});
	it.each(Object.keys(approval.costs))(
		"never substitutes a missing complete-cost component %s",
		(key) => {
			const incomplete: Record<string, unknown> = { ...approval.costs };
			delete incomplete[key];
			expect(() =>
				readRumpelstiltskinCostApproval({
					...environment(),
					RUMPELSTILTSKIN_COST_APPROVAL: JSON.stringify({ ...approval, costs: incomplete }),
				}),
			).toThrow("RUMPELSTILTSKIN_COST_INVALID");
		},
	);
	it("rejects expired, future, unmatched material and conflicting safety approvals", () => {
		for (const override of [
			{ validUntil: "2026-10-07T00:00:00Z" },
			{ approvedAt: "2026-10-08T00:00:00Z" },
		])
			expect(() =>
				readRumpelstiltskinCostApproval({
					...environment(),
					RUMPELSTILTSKIN_COST_APPROVAL: JSON.stringify({ ...approval, ...override }),
				}),
			).toThrow("RUMPELSTILTSKIN_COST_EXPIRED");
		for (const provider of [
			{ ...approval.provider, referenceVersion: "different" },
			{ ...approval.provider, referenceDurationSeconds: 10 },
		])
			expect(() =>
				resolveVideoEffectPrice(request, {
					...environment(),
					RUMPELSTILTSKIN_COST_APPROVAL: JSON.stringify({ ...approval, provider }),
				}),
			).toThrow("RUMPELSTILTSKIN_COST_REFERENCE_MISMATCH");
		expect(() =>
			resolveVideoEffectPrice(request, {
				...environment(),
				VIDEO_V1_VIDEO_SAFETY_ADAPTER: "sightengine",
			}),
		).toThrow("VIDEO_MODERATION_NOT_CONFIGURED");
		expect(() =>
			resolveVideoEffectPrice(request, {
				...environment(),
				VIDEO_V1_TEXT_SAFETY_ADAPTER: undefined,
			}),
		).toThrow("VIDEO_TEXT_MODERATION_NOT_CONFIGURED");
		expect(() =>
			readRumpelstiltskinCostApproval({
				...environment(),
				RUMPELSTILTSKIN_COST_APPROVAL: JSON.stringify({
					...approval,
					policies: { ...approval.policies, visualPolicyVersion: "old" },
				}),
			}),
		).toThrow("RUMPELSTILTSKIN_COST_INVALID");
	});
});
