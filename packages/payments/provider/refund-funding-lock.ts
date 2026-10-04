import type { Prisma } from "@repo/database";

/**
 * Refund money changes paid-credit eligibility even when rounded credit revocation
 * is zero. Keep the existing payment/period -> account order and serialize every
 * monetary projection with reservation's account lock. Do not take payment locks
 * from a reservation that already owns the account lock.
 */
export async function lockRefundFundingAccount(
	accountId: string,
	client: Prisma.TransactionClient,
) {
	const rows = await client.$queryRaw<Array<{ id: string }>>`
		SELECT "id" FROM "credit_account" WHERE "id" = ${accountId} FOR UPDATE`;
	if (rows.length !== 1) throw new Error("REFUND_CREDIT_ACCOUNT_MISSING");
}
