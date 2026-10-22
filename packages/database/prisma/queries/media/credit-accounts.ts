import type { Prisma } from "../../generated/client";

/** Preserve the caller's transaction and let its normal isolation/retry policy resolve races. */
export async function ensureCreditAccountInTransaction(
	owner: { ownerType: "USER" | "ORGANIZATION"; ownerId: string },
	client: Pick<Prisma.TransactionClient, "creditAccount">,
) {
	const where = { ownerType_ownerId: owner };
	const existing = await client.creditAccount.findUnique({ where });
	if (existing) return existing;

	// Empty-update Prisma upserts may emulate read/create and throw P2002 when a
	// concurrent creator commits. ON CONFLICT instead waits for that creator under
	// RC, or raises a serialization conflict for an older SSI snapshot to retry.
	await client.creditAccount.createMany({ data: owner, skipDuplicates: true });
	return client.creditAccount.findUniqueOrThrow({ where });
}
