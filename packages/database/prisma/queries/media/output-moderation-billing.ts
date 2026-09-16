import type { Prisma } from "#prisma-runtime-client";

/** Called inside the same serializable transaction as reservation settlement. */
export async function claimOutputModerationGraceInTransaction(
	input: { accountId: string; jobId: string },
	tx: Prisma.TransactionClient,
): Promise<boolean> {
	const claimed = await tx.creditAccount.updateMany({
		where: { id: input.accountId, outputModerationGraceJobId: null },
		data: { outputModerationGraceJobId: input.jobId, version: { increment: 1 } },
	});
	if (claimed.count === 1) return true;
	const account = await tx.creditAccount.findUniqueOrThrow({ where: { id: input.accountId } });
	return account.outputModerationGraceJobId === input.jobId;
}
