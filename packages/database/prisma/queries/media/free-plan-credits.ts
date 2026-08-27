import { findEffectivePaidSubscription } from "./billing";
import { createCreditGrant } from "./credits";
import { runSerializable, type MediaTransactionClient } from "./types";

export interface EnsureFreeMonthlyCreditGrantInput {
	ownerId: string;
	amount: bigint;
	now: Date;
}

export type EnsureFreeMonthlyCreditGrantResult =
	| { status: "ANONYMOUS_USER" }
	| { status: "USER_NOT_FOUND" }
	| { status: "PAID_SUBSCRIPTION"; referenceKey: string }
	| { status: "GRANTED"; referenceKey: string; accountId: string };

export async function ensureFreeMonthlyCreditGrant(
	input: EnsureFreeMonthlyCreditGrantInput,
	client: MediaTransactionClient,
): Promise<EnsureFreeMonthlyCreditGrantResult> {
	if (input.amount <= 0n) throw new Error("Free monthly credit amount must be positive");
	if (Number.isNaN(input.now.getTime())) throw new Error("Free monthly credit date is invalid");

	const periodStart = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), 1));
	const periodEnd = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth() + 1, 1));
	const periodKey = periodStart.toISOString().slice(0, 7);
	const referenceKey = `free-plan:user:${input.ownerId}:${periodKey}`;

	return runSerializable(client, async (tx) => {
		await tx.$queryRaw<Array<{ locked: string }>>`
			SELECT pg_advisory_xact_lock(hashtextextended(${referenceKey}, 0))::text AS "locked"`;
		const user = await tx.user.findUnique({
			where: { id: input.ownerId },
			select: { isAnonymous: true },
		});
		if (!user) return { status: "USER_NOT_FOUND" };
		if (user.isAnonymous) return { status: "ANONYMOUS_USER" };

		const paidSubscription = await findEffectivePaidSubscription(
			{ ownerType: "USER", ownerId: input.ownerId, now: input.now },
			tx,
		);
		if (paidSubscription) {
			return { status: "PAID_SUBSCRIPTION", referenceKey };
		}

		const account = await tx.creditAccount.upsert({
			where: { ownerType_ownerId: { ownerType: "USER", ownerId: input.ownerId } },
			create: { ownerType: "USER", ownerId: input.ownerId },
			update: {},
		});
		await createCreditGrant(
			{
				accountId: account.id,
				amount: input.amount,
				referenceKey,
				expiresAt: periodEnd,
				metadata: {
					planId: "free",
					periodStart: periodStart.toISOString(),
					periodEnd: periodEnd.toISOString(),
				},
			},
			tx,
		);

		return { status: "GRANTED", referenceKey, accountId: account.id };
	});
}
