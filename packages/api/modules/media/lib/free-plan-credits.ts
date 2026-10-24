import { ensureOneTimeLoginCreditGrant } from "@repo/database";
import { db } from "@repo/database/client";
import { logger } from "@repo/logs";

async function attemptOneTimeLoginBonus(userId: string) {
	try {
		await ensureOneTimeLoginCreditGrant({ ownerId: userId }, db);
	} catch (error) {
		// A promotional retry must not block an already funded account. Existing
		// generation eligibility and spendable-balance checks still run unchanged.
		logger.warn("Login credit bonus could not be granted", {
			ctx: "loginCreditBonus",
			userId,
			errorType: error instanceof Error ? error.name : "UnknownError",
		});
	}
}

export async function ensureFreePlanCreditsForUser(userId: string, _now = new Date()) {
	await attemptOneTimeLoginBonus(userId);
}

/** This wrapper intentionally has no grant-status contract. */
export async function ensureFreePlanCreditsForGeneration(userId: string, _now = new Date()) {
	await attemptOneTimeLoginBonus(userId);
}
