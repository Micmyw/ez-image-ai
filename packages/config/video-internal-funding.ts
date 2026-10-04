import { z } from "zod";

export const VIDEO_INTERNAL_FUNDING_VERSION = "operator-funded-internal-v1";

const userIdSchema = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[a-zA-Z0-9_-]+$/);
const authorizationSchema = z
	.object({
		userIds: z.tuple([userIdSchema]),
		validUntil: z.iso.datetime({ offset: true }),
		reason: z.string().trim().min(1).max(300),
	})
	.strict();
const fundingSnapshotSchema = z
	.object({
		mode: z.literal(VIDEO_INTERNAL_FUNDING_VERSION),
		authorizedOwnerId: userIdSchema,
		validUntil: z.iso.datetime({ offset: true }),
		reason: z.string().trim().min(1).max(300),
	})
	.strict();
export type VideoInternalFundingSnapshot = z.infer<typeof fundingSnapshotSchema>;

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue | undefined };
type FundingPrice = {
	paidFundingPolicy: { minimumUsdMicrosPerCredit: bigint };
	pricingDetails?: JsonObject;
};

/** Missing, invalid, expired or unauthorized settings never weaken paid-lot funding. */
function resolveInternalFunding(
	context: { userId: string; role?: string | null },
	environment: Record<string, string | undefined>,
	now: Date,
): VideoInternalFundingSnapshot | null {
	if (context.role !== "admin" || (environment.VIDEO_V1_ACCESS ?? "internal") !== "internal")
		return null;
	const encoded = environment.VIDEO_INTERNAL_FUNDING;
	if (!encoded || encoded.length > 2000 || !Number.isFinite(now.getTime())) return null;
	let value: unknown;
	try {
		value = JSON.parse(encoded);
	} catch {
		return null;
	}
	const parsed = authorizationSchema.safeParse(value);
	if (
		!parsed.success ||
		parsed.data.userIds[0] !== context.userId ||
		Date.parse(parsed.data.validUntil) <= now.getTime()
	)
		return null;
	return {
		mode: VIDEO_INTERNAL_FUNDING_VERSION,
		authorizedOwnerId: context.userId,
		validUntil: new Date(parsed.data.validUntil).toISOString(),
		reason: parsed.data.reason,
	};
}

/** Server-only: preserve the retail debit, but never represent operator credits as paid revenue. */
export function applyVideoInternalFunding<Price extends FundingPrice>(
	price: Price,
	context: { userId: string; role?: string | null },
	environment: Record<string, string | undefined>,
	now = new Date(),
): Omit<Price, "paidFundingPolicy" | "pricingDetails"> & {
	paidFundingPolicy: Price["paidFundingPolicy"] | undefined;
	pricingDetails?: JsonObject;
} {
	const funding = resolveInternalFunding(context, environment, now);
	if (!funding) return price;
	const {
		creditFloorMicros,
		minimumGrossRevenueMicros,
		paymentFeeMicros,
		completeCostMicros,
		profitMicros,
		markupBps,
		...costDetails
	} = price.pricingDetails ?? {};
	const retailReference = Object.fromEntries(
		Object.entries({
			basis: "qualified-paid-retail-calculation-only",
			creditFloorMicros,
			minimumGrossRevenueMicros,
			paymentFeeMicros,
			completeCostMicros,
			profitMicros,
			markupBps,
		}).filter(([, value]) => value !== undefined),
	);
	return {
		...price,
		paidFundingPolicy: undefined,
		pricingDetails: {
			...costDetails,
			paidRevenueQualified: false,
			funding,
			retailReference,
		},
	};
}

/** Validate persisted authorization at the database boundary using its current clock. */
export function readVideoInternalFundingSnapshot(
	value: unknown,
	ownerId: string,
	now: Date,
): VideoInternalFundingSnapshot | null {
	const parsed = fundingSnapshotSchema.safeParse(value);
	if (
		!parsed.success ||
		parsed.data.authorizedOwnerId !== ownerId ||
		!Number.isFinite(now.getTime()) ||
		Date.parse(parsed.data.validUntil) <= now.getTime()
	)
		return null;
	return parsed.data;
}
