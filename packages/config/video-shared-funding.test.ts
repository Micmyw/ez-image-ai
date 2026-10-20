import { describe, expect, it } from "vitest";

import { applyVideoSharedFunding, readVideoSharedFundingSnapshot } from "./video-shared-funding";

describe("video shared media funding snapshot", () => {
	it("keeps the exact retail debit and costs without asserting paid revenue or mutating the source", () => {
		const price = {
			credits: 42n,
			pricingVersion: "unchanged-price-version",
			pricingBasis: "TEST_ONLY",
			providerCostMicros: 10n,
			moderationCostMicros: 2n,
			paidFundingPolicy: { minimumUsdMicrosPerCredit: 21_944n },
			pricingDetails: {
				creditFloorMicros: "21944",
				minimumGrossRevenueMicros: "921648",
				paymentFeeMicros: "12000",
				completeCostMicros: "421648",
				profitMicros: "500000",
				markupBps: "11000",
				directCostMicros: "12",
				priceApprovalExpiryMode: "none",
				validUntil: null,
				retail: { display: { credits: "42", audience: "standard" } },
			},
		};
		const original = structuredClone(price);
		const result = applyVideoSharedFunding(price);
		expect(result).toEqual({
			...price,
			paidFundingPolicy: undefined,
			pricingDetails: {
				directCostMicros: "12",
				priceApprovalExpiryMode: "none",
				validUntil: null,
				retail: price.pricingDetails.retail,
				funding: { mode: "shared-media-credits-v1" },
				paidRevenueQualified: false,
				retailReference: {
					basis: "qualified-paid-retail-calculation-only",
					creditFloorMicros: "21944",
					minimumGrossRevenueMicros: "921648",
					paymentFeeMicros: "12000",
					completeCostMicros: "421648",
					profitMicros: "500000",
					markupBps: "11000",
				},
			},
		});
		expect(price).toEqual(original);
	});
	it("keeps independent-template debits while moving former paid-profit claims to nonbinding reference data", () => {
		const price = {
			credits: 493n,
			pricingVersion: "rumpelstiltskin-cost-2026-10-07.1",
			providerCostMicros: 1_250_000n,
			moderationCostMicros: 115_000n,
			paidFundingPolicy: { minimumUsdMicrosPerCredit: 21_944n },
			pricingDetails: {
				kind: "video-effect",
				effectId: "rumpelstiltskin-solo",
				minimumNetRevenueMicros: "9236552",
				netContributionProfitMicros: "7216552",
				netProfitBps: "35725",
				minimumRevenueToCostBps: "30000",
				creditRevenueBasis: "historical approved paid receipt reference",
				riskAdjustedOperatingCostMicros: "2020000",
			},
		};
		const result = applyVideoSharedFunding(price);
		expect(result.credits).toBe(493n);
		expect(result.pricingVersion).toBe(price.pricingVersion);
		expect(result.paidFundingPolicy).toBeUndefined();
		expect(result.pricingDetails).toMatchObject({
			kind: "video-effect",
			effectId: "rumpelstiltskin-solo",
			funding: { mode: "shared-media-credits-v1" },
			paidRevenueQualified: false,
			riskAdjustedOperatingCostMicros: "2020000",
			retailReference: {
				minimumNetRevenueMicros: "9236552",
				netContributionProfitMicros: "7216552",
				netProfitBps: "35725",
				minimumRevenueToCostBps: "30000",
				creditRevenueBasis: "historical approved paid receipt reference",
			},
		});
		for (const field of [
			"minimumNetRevenueMicros",
			"netContributionProfitMicros",
			"netProfitBps",
			"minimumRevenueToCostBps",
			"creditRevenueBasis",
		])
			expect(result.pricingDetails).not.toHaveProperty(field);
	});
	it("accepts only the explicit versioned shared snapshot", () => {
		expect(readVideoSharedFundingSnapshot({ mode: "shared-media-credits-v1" })).toEqual({
			mode: "shared-media-credits-v1",
		});
	});
	it.each([
		undefined,
		null,
		[],
		{},
		"shared-media-credits-v1",
		{ mode: "shared-media-credits-v2" },
		{ mode: "operator-funded-internal-v1" },
		{ mode: "shared-media-credits-v1", bypassExpiry: true },
	])(
		"never interprets a missing, historical or malformed policy as shared funding: %j",
		(value) => {
			expect(readVideoSharedFundingSnapshot(value)).toBeNull();
		},
	);
});
