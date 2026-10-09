import { getPlanEntitlement } from "@repo/config";
import { ensureFreeMonthlyCreditGrant, hasMatchingFreeMonthlyCreditGrant } from "@repo/database";
import { db } from "@repo/database/client";

export function ensureFreePlanCreditsForUser(userId: string, now = new Date()) {
	return ensureFreeMonthlyCreditGrant(
		{
			ownerId: userId,
			amount: BigInt(getPlanEntitlement("free").monthlyCredits),
			now,
		},
		db,
	);
}

/** This wrapper intentionally has no grant-status contract. */
export async function ensureFreePlanCreditsForGeneration(userId: string, now = new Date()) {
	const input = { ownerId: userId, amount: BigInt(getPlanEntitlement("free").monthlyCredits), now };
	if (await hasMatchingFreeMonthlyCreditGrant(input, db)) return;
	await ensureFreeMonthlyCreditGrant(input, db);
}
