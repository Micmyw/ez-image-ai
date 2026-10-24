import { FREE_ACCOUNT_SIGN_IN_CREDITS } from "@repo/config";

import { ensureCreditAccountInTransaction } from "./credit-accounts";
import { createCreditGrant, hasMatchingCreditGrant } from "./credits";
import {
	runReadCommitted,
	runSerializable,
	type MediaDatabaseClient,
	type MediaTransactionClient,
} from "./types";

const LOGIN_BONUS_CREDITS = BigInt(FREE_ACCOUNT_SIGN_IN_CREDITS);
const LEGACY_LOGIN_BONUS_CREDITS = 5n;
const metadata = { program: "one-time-login-bonus-v1" };

export type OneTimeLoginCreditGrantResult =
	| { status: "USER_NOT_FOUND" | "ANONYMOUS_USER" }
	| { status: "GRANTED" | "ALREADY_GRANTED"; referenceKey: string };

/** Lifetime identity is independent of sessions, subscription and monthly free grants. */
export async function ensureOneTimeLoginCreditGrant(
	input: { ownerId: string },
	client: MediaTransactionClient,
): Promise<OneTimeLoginCreditGrantResult> {
	const referenceKey = `login-bonus:user:${input.ownerId}:v1`;
	const grant = {
		amount: LOGIN_BONUS_CREDITS,
		expiresAt: null,
		referenceKey,
		metadata,
	};
	const wasAlreadyGranted = async (database: MediaDatabaseClient) =>
		(await hasMatchingCreditGrant(
			{ ...grant, ownerType: "USER", ownerId: input.ownerId },
			database,
		)) ||
		(await hasMatchingCreditGrant(
			{
				...grant,
				amount: LEGACY_LOGIN_BONUS_CREDITS,
				ownerType: "USER",
				ownerId: input.ownerId,
			},
			database,
		));
	const user = await client.user.findUnique({
		where: { id: input.ownerId },
		select: { isAnonymous: true },
	});
	if (!user) return { status: "USER_NOT_FOUND" };
	if (user.isAnonymous) return { status: "ANONYMOUS_USER" };
	// This receipt is append-only and validates the complete command and owner.
	// It proves lifetime issuance, never the current balance or generation access.
	// The same lifetime identity recognizes the historical 5-credit receipt without
	// rewriting it, issuing a replacement or topping it up to the new allowance.
	if (await wasAlreadyGranted(client)) return { status: "ALREADY_GRANTED", referenceKey };
	// Enable only after every account creator has the atomic helper and older
	// writers have drained. The immutable receipt fast path needs no rollout flag.
	const transaction =
		process.env.MEDIA_LOGIN_BONUS_READ_COMMITTED_ENABLED === "true"
			? runReadCommitted
			: runSerializable;
	return transaction(client, async (tx) => {
		// Keep the existing lifetime lock before any account/lot lock. After rollout,
		// RC reads after waiting see the winner without cross-user SSI predicates.
		await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${referenceKey}, 0))::text AS "locked"`;
		const user = await tx.user.findUnique({
			where: { id: input.ownerId },
			select: { isAnonymous: true },
		});
		if (!user) return { status: "USER_NOT_FOUND" };
		if (user.isAnonymous) return { status: "ANONYMOUS_USER" };

		if (await wasAlreadyGranted(tx)) return { status: "ALREADY_GRANTED", referenceKey };

		const account = await ensureCreditAccountInTransaction(
			{ ownerType: "USER", ownerId: input.ownerId },
			tx,
		);
		// The shared grant command still locks account -> lots and atomically
		// writes expiry/debt, balances, account.version and immutable ledger rows.
		// That real account write also fences older Serializable account writers.
		await createCreditGrant({ accountId: account.id, ...grant }, tx);
		return { status: "GRANTED", referenceKey };
	});
}
