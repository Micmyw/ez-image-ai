import { getPlanEntitlement } from "@repo/config";
import { ensureFreeMonthlyCreditGrant } from "@repo/database";
import { db } from "@repo/database/client";

export function ensureFreePlanCreditsForUser(
	user: string | { id: string; isAnonymous?: boolean | null },
	now = new Date(),
) {
	if (typeof user !== "string" && user.isAnonymous === true) {
		return Promise.resolve({ status: "ANONYMOUS_USER" as const });
	}
	const userId = typeof user === "string" ? user : user.id;
	return ensureFreeMonthlyCreditGrant(
		{
			ownerId: userId,
			amount: BigInt(getPlanEntitlement("free").monthlyCredits),
			now,
		},
		db,
	);
}
