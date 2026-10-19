import type { Prisma } from "../../generated/client";

/** Retired same-key producer. Its historical flag must never enable adoption. */
export async function accountInputRetentionPatch(
	input: {
		draftId: string;
		nextOwnerId: string;
		asset: { id: string; objectKey: string; retentionClass: string; deleteAfter: Date | null };
	},
	tx: Prisma.TransactionClient,
): Promise<{ retentionClass?: "ACCOUNT"; deleteAfter?: null }> {
	// Same-key retention is retired: a stale external delete can outlive its lease.
	// Registered retention uses the separate fresh-key copy protocol.
	void input;
	void tx;
	return {};
}
