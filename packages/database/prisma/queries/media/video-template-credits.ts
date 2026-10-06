import { findPaidFundedCreditLotIds } from "./paid-credit-funding";
import type { MediaTransactionClient, PaidCreditFundingPolicy } from "./types";

/** Advisory snapshot only. Order acceptance still locks and rechecks the same funding policy. */
export function getVideoTemplateCreditBalance(
	ownerId: string,
	policy: PaidCreditFundingPolicy | undefined,
	database: MediaTransactionClient,
) {
	return database.$transaction(
		async (tx) => {
			await tx.$executeRaw`SET TRANSACTION READ ONLY`;
			const account = await tx.creditAccount.findUnique({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
				select: { id: true, spendableCredits: true, creditDebt: true },
			});
			if (!account) return { totalCredits: "0", eligibleCredits: "0" };
			const lots = await tx.creditLot.findMany({
				where: {
					accountId: account.id,
					remainingAmount: { gt: 0n },
					OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
				},
				select: { id: true, remainingAmount: true },
			});
			const total = lots.reduce((sum, lot) => sum + lot.remainingAmount, 0n);
			const eligibleIds = policy ? await findPaidFundedCreditLotIds(account.id, policy, tx) : null;
			const eligible = lots.reduce(
				(sum, lot) => sum + (!eligibleIds || eligibleIds.has(lot.id) ? lot.remainingAmount : 0n),
				0n,
			);
			return {
				totalCredits: total.toString(),
				eligibleCredits: (account.creditDebt > 0n || account.spendableCredits <= 0n
					? 0n
					: eligible < account.spendableCredits
						? eligible
						: account.spendableCredits
				).toString(),
			};
		},
		{ isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 20_000 },
	);
}
