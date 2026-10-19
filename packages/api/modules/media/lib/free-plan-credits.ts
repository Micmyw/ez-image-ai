import { getPlanEntitlement } from "@repo/config";
import {
	ensureFreeMonthlyCreditGrant,
	ensureOneTimeLoginCreditGrant,
	hasMatchingFreeMonthlyCreditGrant,
} from "@repo/database";
import { db } from "@repo/database/client";
import { logger } from "@repo/logs";

async function attemptOneTimeLoginBonus(userId: string) {
	try {
		await ensureOneTimeLoginCreditGrant({ ownerId: userId }, db);
	} catch (error) {
		// A promotional retry must not block an already funded account. Existing
		// monthly-credit and generation eligibility checks still run unchanged.
		logger.warn("Login credit bonus could not be granted", {
			ctx: "loginCreditBonus",
			userId,
			errorType: error instanceof Error ? error.name : "UnknownError",
		});
	}
}

export async function ensureFreePlanCreditsForUser(userId: string, now = new Date()) {
	await attemptOneTimeLoginBonus(userId);
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
	await attemptOneTimeLoginBonus(userId);
	const input = { ownerId: userId, amount: BigInt(getPlanEntitlement("free").monthlyCredits), now };
	if (await hasMatchingFreeMonthlyCreditGrant(input, db)) return;
	await ensureFreeMonthlyCreditGrant(input, db);
}
