import { z } from "zod";

export const VIDEO_SHARED_FUNDING_VERSION = "shared-media-credits-v1";

const fundingSnapshotSchema = z.object({ mode: z.literal(VIDEO_SHARED_FUNDING_VERSION) }).strict();

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue | undefined };
type FundingPrice = {
	paidFundingPolicy: { minimumUsdMicrosPerCredit: bigint };
	pricingDetails?: JsonObject;
};

/** New video orders share image credits; retail calculations do not certify lot revenue. */
export function applyVideoSharedFunding<Price extends FundingPrice>(
	price: Price,
): Omit<Price, "paidFundingPolicy" | "pricingDetails"> & {
	paidFundingPolicy: undefined;
	pricingDetails: JsonObject;
} {
	const {
		creditFloorMicros,
		minimumGrossRevenueMicros,
		paymentFeeMicros,
		completeCostMicros,
		profitMicros,
		markupBps,
		minimumNetRevenueMicros,
		netContributionProfitMicros,
		netProfitBps,
		minimumRevenueToCostBps,
		creditRevenueBasis,
		...costDetails
	} = price.pricingDetails ?? {};
	return {
		...price,
		paidFundingPolicy: undefined,
		pricingDetails: {
			...costDetails,
			paidRevenueQualified: false,
			funding: { mode: VIDEO_SHARED_FUNDING_VERSION },
			retailReference: Object.fromEntries(
				Object.entries({
					basis: "qualified-paid-retail-calculation-only",
					creditFloorMicros,
					minimumGrossRevenueMicros,
					paymentFeeMicros,
					completeCostMicros,
					profitMicros,
					markupBps,
					minimumNetRevenueMicros,
					netContributionProfitMicros,
					netProfitBps,
					minimumRevenueToCostBps,
					creditRevenueBasis,
				}).filter(([, value]) => value !== undefined),
			),
		},
	};
}

/** Explicit, immutable policy only; missing/unknown modes never opt a historical job in. */
export function readVideoSharedFundingSnapshot(value: unknown) {
	const parsed = fundingSnapshotSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}
