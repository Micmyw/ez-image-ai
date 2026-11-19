import { eq, sql } from "drizzle-orm";

import {
	existingPortraitPackTrial,
	PORTRAIT_PACK_PURCHASE_SQL,
	type PortraitPackTrialInput,
} from "../../shared/portrait-packs";
import { db } from "../client";
import { portraitPackTrial } from "../schema/postgres";

export async function hasPortraitPackPurchase(userId: string): Promise<boolean> {
	const [before, after] = PORTRAIT_PACK_PURCHASE_SQL.split("$1", 2);
	const { rows } = await db.execute<{ unlocked: boolean }>(
		sql`${sql.raw(before!)}${userId}${sql.raw(after!)}`,
	);
	return rows[0]?.unlocked === true;
}

export function getPortraitPackTrials(subjectKey: string, client: Pick<typeof db, "select"> = db) {
	return client
		.select({ requestId: portraitPackTrial.requestId, cardKeys: portraitPackTrial.cardKeys })
		.from(portraitPackTrial)
		.where(eq(portraitPackTrial.subjectKey, subjectKey))
		.orderBy(portraitPackTrial.slot);
}

export async function issuePortraitPackTrial(input: PortraitPackTrialInput) {
	return db.transaction(
		async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${`portrait-pack-trial:${input.subjectKey}`}, 0))`,
			);
			const issued = await getPortraitPackTrials(input.subjectKey, tx);
			const previous = existingPortraitPackTrial(issued, input.requestId);
			if (previous) return { receipt: previous, used: issued.length };
			const slot = issued.length + 1;
			const [receipt] = await tx
				.insert(portraitPackTrial)
				.values({ ...input, slot })
				.returning({
					requestId: portraitPackTrial.requestId,
					cardKeys: portraitPackTrial.cardKeys,
				});
			if (!receipt) throw new Error("PORTRAIT_PACK_TRIAL_NOT_PERSISTED");
			return { receipt, used: slot };
		},
		{ isolationLevel: "read committed" },
	);
}
