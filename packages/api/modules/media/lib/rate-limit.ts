import { createHash } from "node:crypto";

import { db } from "@repo/database/client";

export async function enforceMediaRateLimit(userId: string, action: string): Promise<void> {
	const now = new Date();
	const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
	const subjectHash = createHash("sha256").update(`${action}:${userId}`).digest("hex");
	const [result] = await db.$queryRaw<Array<{ allowed: boolean }>>`
		INSERT INTO "rate_limit_bucket" (
			"id", "action", "subjectHash", "windowStart", "windowEnd", "count", "updatedAt"
		)
		VALUES (
			gen_random_uuid()::text, ${action}, ${subjectHash}, ${windowStart},
			${new Date(windowStart.getTime() + 60_000)}, 1, now()
		)
		ON CONFLICT ("action", "subjectHash", "windowStart") DO UPDATE
		SET "count" = "rate_limit_bucket"."count" + 1, "updatedAt" = now()
		RETURNING ("count" <= 30) AS "allowed"`;
	if (!result?.allowed) throw new Error("RATE_LIMITED");
}
