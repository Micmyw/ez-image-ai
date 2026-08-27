import { getPlanEntitlement } from "@repo/config";
import { ensureFreeMonthlyCreditGrant } from "@repo/database";
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
