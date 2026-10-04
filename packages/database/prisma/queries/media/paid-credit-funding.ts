import type { Prisma } from "../../generated/client";
import type { PaidCreditFundingPolicy } from "./types";

/** Call only after the account and its ordered lots are locked by the ledger. */
export async function findPaidFundedCreditLotIds(
	accountId: string,
	policy: PaidCreditFundingPolicy,
	tx: Prisma.TransactionClient,
) {
	if (policy.minimumUsdMicrosPerCredit <= 0n) throw new Error("PAID_CREDIT_FUNDING_POLICY_INVALID");
	const rows = await tx.$queryRaw<Array<{ id: string }>>`
		SELECT lot."id"
		FROM "credit_lot" lot
		JOIN "credit_account" account ON account."id" = lot."accountId"
		LEFT JOIN "credit_pack_fulfillment" pack
			ON pack."grantReferenceKey" = lot."grantReferenceKey"
		LEFT JOIN "billing_period" period
			ON period."grantReferenceKey" = lot."grantReferenceKey"
		LEFT JOIN "subscription" subscription ON subscription."id" = period."subscriptionId"
		LEFT JOIN "billing_plan" plan ON plan."id" = subscription."planId"
		LEFT JOIN LATERAL (
			-- Annual billing repeats the full payment on every monthly period.
			-- Divide that payment once across ALL promised periods, including future
			-- ones. MIN paid / MAX refunded is conservative if old rows disagree.
			SELECT SUM(sibling."creditAmount") AS "credits",
				MIN(sibling."paidAmount") AS "paid", MAX(sibling."refundedAmount") AS "refunded"
			FROM "billing_period" sibling
			WHERE sibling."subscriptionId" = period."subscriptionId"
				AND sibling."providerInvoicePaymentId" = period."providerInvoicePaymentId"
		) payment ON true
		WHERE lot."accountId" = ${accountId} AND lot."remainingAmount" > 0
			AND (
				(pack."ownerType" = account."ownerType" AND pack."ownerId" = account."ownerId"
					AND upper(pack."currency") = 'USD'
					AND pack."status" IN ('FULFILLED', 'PARTIALLY_REFUNDED')
					AND pack."paidAmountMicros" > 0 AND pack."refundedAmountMicros" >= 0
					AND pack."grantedCredits" > 0
					AND pack."grantedCredits" = pack."baseCredits" + pack."bonusCredits"
					AND lot."grantedAmount" <= pack."grantedCredits"
					AND (pack."paidAmountMicros" - pack."refundedAmountMicros")::numeric
						>= ${policy.minimumUsdMicrosPerCredit}::numeric * pack."grantedCredits")
				OR
				(subscription."ownerType" = account."ownerType" AND subscription."ownerId" = account."ownerId"
					AND upper(plan."currency") = 'USD'
					AND plan."provider" = subscription."provider"
					AND period."status" NOT IN ('PENDING', 'VOID', 'REFUNDED')
					AND period."providerInvoicePaymentId" IS NOT NULL
					AND period."paidAmount" > 0 AND payment."refunded" >= 0 AND payment."credits" > 0
					AND lot."grantedAmount" <= period."creditAmount"
					AND (
						-- The legacy Stripe invoice reducer persists USD minor units.
						(subscription."provider" = 'stripe' AND lot."grantReferenceKey" LIKE 'stripe-invoice:%'
							AND (payment."paid" - payment."refunded")::numeric * 10000
								>= ${policy.minimumUsdMicrosPerCredit}::numeric * payment."credits")
						OR
						-- The unified provider lifecycle reducer persists micro-USD.
						(lot."grantReferenceKey" LIKE subscription."provider" || '-payment:%'
							AND (payment."paid" - payment."refunded")::numeric
								>= ${policy.minimumUsdMicrosPerCredit}::numeric * payment."credits")
					)
				)
			)`;
	return new Set(rows.map((row) => row.id));
}
