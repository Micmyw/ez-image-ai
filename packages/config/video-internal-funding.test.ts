import { describe, expect, it } from "vitest";

import {
	applyVideoInternalFunding,
	readVideoInternalFundingSnapshot,
	VIDEO_INTERNAL_FUNDING_VERSION,
} from "./video-internal-funding";

const now = new Date("2026-10-05T00:00:00.000Z");
const validUntil = "2026-10-05T12:00:00.000Z";
const operator = { userId: "video-internal-funding-test-operator", role: "admin" };
const authorization = {
	userIds: [operator.userId],
	validUntil,
	reason: "Operator authorized existing credits for capped internal acceptance",
};
const environment = {
	VIDEO_V1_ACCESS: "internal",
	VIDEO_INTERNAL_FUNDING: JSON.stringify(authorization),
};
const price = {
	credits: 42n,
	providerCostMicros: 10n,
	moderationCostMicros: 2n,
	paidFundingPolicy: { minimumUsdMicrosPerCredit: 21_944n },
	pricingDetails: {
		creditFloorMicros: "21944",
		minimumGrossRevenueMicros: "921648",
		profitMicros: "500000",
		markupBps: "11000",
		paymentFeeMicros: "12000",
		completeCostMicros: "421648",
		directCostMicros: "12",
		visualPolicyVersion: "test-policy",
	},
};

describe("explicit operator funding for internal video acceptance", () => {
	it("retains the real credit debit and freezes authorization without asserting paid revenue", () => {
		const result = applyVideoInternalFunding(price, operator, environment, now);
		expect(result).toMatchObject({
			credits: price.credits,
			providerCostMicros: price.providerCostMicros,
			moderationCostMicros: price.moderationCostMicros,
			paidFundingPolicy: undefined,
			pricingDetails: {
				paidRevenueQualified: false,
				funding: {
					mode: VIDEO_INTERNAL_FUNDING_VERSION,
					authorizedOwnerId: operator.userId,
					validUntil,
					reason: authorization.reason,
				},
				retailReference: {
					basis: "qualified-paid-retail-calculation-only",
					minimumGrossRevenueMicros: "921648",
					profitMicros: "500000",
					markupBps: "11000",
				},
				directCostMicros: "12",
				visualPolicyVersion: "test-policy",
			},
		});
		for (const field of [
			"creditFloorMicros",
			"minimumGrossRevenueMicros",
			"profitMicros",
			"markupBps",
		])
			expect(result.pricingDetails).not.toHaveProperty(field);
		expect(price.paidFundingPolicy).toEqual({ minimumUsdMicrosPerCredit: 21_944n });
		expect(price.pricingDetails).not.toHaveProperty("funding");
	});

	it.each([
		{ label: "another admin", context: { userId: "other-admin", role: "admin" } },
		{ label: "operator without admin", context: { userId: operator.userId, role: "user" } },
		{ label: "missing role", context: { userId: operator.userId } },
		{ label: "empty user", context: { userId: "", role: "admin" } },
	])("retains normal paid funding for $label", ({ context }) => {
		expect(applyVideoInternalFunding(price, context, environment, now)).toBe(price);
	});

	it.each([
		{ label: "no config", encoded: undefined },
		{ label: "invalid JSON", encoded: "{" },
		{ label: "null config", encoded: "null" },
		{ label: "empty users", encoded: JSON.stringify({ ...authorization, userIds: [] }) },
		{
			label: "other admin only",
			encoded: JSON.stringify({ ...authorization, userIds: ["other"] }),
		},
		{
			label: "additional admin",
			encoded: JSON.stringify({ ...authorization, userIds: [...authorization.userIds, "other"] }),
		},
		{ label: "wildcard", encoded: JSON.stringify({ ...authorization, userIds: ["*"] }) },
		{
			label: "expired",
			encoded: JSON.stringify({ ...authorization, validUntil: now.toISOString() }),
		},
		{ label: "invalid expiry", encoded: JSON.stringify({ ...authorization, validUntil: "never" }) },
		{
			label: "missing reason",
			encoded: JSON.stringify({ userIds: authorization.userIds, validUntil }),
		},
		{ label: "blank reason", encoded: JSON.stringify({ ...authorization, reason: " " }) },
		{
			label: "unexpected field",
			encoded: JSON.stringify({ ...authorization, bypassModeration: true }),
		},
	])("does not grant an exception for $label", ({ encoded }) => {
		expect(
			applyVideoInternalFunding(
				price,
				operator,
				{ ...environment, VIDEO_INTERNAL_FUNDING: encoded },
				now,
			),
		).toBe(price);
	});

	it("requires internal access even with a valid operator authorization", () => {
		expect(
			applyVideoInternalFunding(
				price,
				operator,
				{ ...environment, VIDEO_V1_ACCESS: "public" },
				now,
			),
		).toBe(price);
	});
	it("validates frozen owner and expiry again at the database boundary", () => {
		const result = applyVideoInternalFunding(price, operator, environment, now);
		const funding = result.pricingDetails?.funding;
		expect(readVideoInternalFundingSnapshot(funding, operator.userId, now)).toMatchObject({
			mode: VIDEO_INTERNAL_FUNDING_VERSION,
		});
		expect(readVideoInternalFundingSnapshot(funding, "other", now)).toBeNull();
		expect(
			readVideoInternalFundingSnapshot(funding, operator.userId, new Date(validUntil)),
		).toBeNull();
		expect(
			readVideoInternalFundingSnapshot(
				{ ...(funding as object), mode: "ordinary" },
				operator.userId,
				now,
			),
		).toBeNull();
	});
});
