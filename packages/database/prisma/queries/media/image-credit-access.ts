import type { Prisma } from "../../generated/client";

/** Model access only: all valid credit lots still share the existing reservation ledger.
 * Admission calls this after the owner account lock; reads do not grant storage or a subscription.
 */
export async function hasSpendablePurchasedImageCredits(
	ownerId: string,
	tx: Pick<Prisma.TransactionClient, "$queryRaw">,
): Promise<boolean> {
	const [row] = await tx.$queryRaw<Array<{ hasPaidCredits: boolean }>>`
		SELECT EXISTS (
			SELECT 1 FROM "credit_lot" lot
			JOIN "credit_account" account ON account."id" = lot."accountId"
			LEFT JOIN "credit_pack_fulfillment" pack ON pack."grantReferenceKey" = lot."grantReferenceKey"
			LEFT JOIN "billing_period" period ON period."grantReferenceKey" = lot."grantReferenceKey"
			LEFT JOIN "subscription" subscription ON subscription."id" = period."subscriptionId"
			WHERE account."ownerType" = 'USER' AND account."ownerId" = ${ownerId}
				AND lot."remainingAmount" > 0 AND (lot."expiresAt" IS NULL OR lot."expiresAt" > clock_timestamp())
				AND (
					(pack."ownerType" = 'USER' AND pack."ownerId" = account."ownerId"
						AND pack."status" IN ('FULFILLED', 'PARTIALLY_REFUNDED')
						AND pack."expiresAt" > clock_timestamp()
						AND pack."paidAmountMicros" > pack."refundedAmountMicros"
						AND pack."refundedAmountMicros" >= 0)
					OR (subscription."ownerType" = 'USER' AND subscription."ownerId" = account."ownerId"
						AND period."status" NOT IN ('PENDING', 'VOID', 'REFUNDED')
						AND period."paidAmount" > period."refundedAmount" AND period."refundedAmount" >= 0)
				)
		) AS "hasPaidCredits"`;
	return row?.hasPaidCredits === true;
}
