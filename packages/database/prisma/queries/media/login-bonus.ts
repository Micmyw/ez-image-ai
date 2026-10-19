import { createCreditGrant, hasMatchingCreditGrant } from "./credits";
import { runSerializable, type MediaTransactionClient } from "./types";

const LOGIN_BONUS_CREDITS = 5n;
const metadata = { program: "one-time-login-bonus-v1" };

export type OneTimeLoginCreditGrantResult =
	| { status: "USER_NOT_FOUND" | "ANONYMOUS_USER" }
	| { status: "GRANTED" | "ALREADY_GRANTED"; referenceKey: string };

/** Lifetime identity is independent of sessions, subscription and monthly free grants. */
export function ensureOneTimeLoginCreditGrant(
	input: { ownerId: string },
	client: MediaTransactionClient,
): Promise<OneTimeLoginCreditGrantResult> {
	const referenceKey = `login-bonus:user:${input.ownerId}:v1`;
	return runSerializable(client, async (tx) => {
		await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${referenceKey}, 0))::text AS "locked"`;
		const user = await tx.user.findUnique({
			where: { id: input.ownerId },
			select: { isAnonymous: true },
		});
		if (!user) return { status: "USER_NOT_FOUND" };
		if (user.isAnonymous) return { status: "ANONYMOUS_USER" };

		const grant = {
			amount: LOGIN_BONUS_CREDITS,
			expiresAt: null,
			referenceKey,
			metadata,
		};
		if (await hasMatchingCreditGrant({ ...grant, ownerType: "USER", ownerId: input.ownerId }, tx))
			return { status: "ALREADY_GRANTED", referenceKey };

		const account = await tx.creditAccount.upsert({
			where: { ownerType_ownerId: { ownerType: "USER", ownerId: input.ownerId } },
			create: { ownerType: "USER", ownerId: input.ownerId },
			update: {},
		});
		await createCreditGrant({ accountId: account.id, ...grant }, tx);
		return { status: "GRANTED", referenceKey };
	});
}
