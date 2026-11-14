import { inArray, sql } from "drizzle-orm";

import type { db } from "../client";
import { guestTrialEntitlement } from "../schema/postgres";

type Client = Parameters<Parameters<typeof db.transaction>[0]>[0];
export function guestEntitlementSubjects(input: { ownerId: string; browserSubjectHash?: string }) {
	return [
		`owner:${input.ownerId}`,
		...(input.browserSubjectHash ? [`browser:${input.browserSubjectHash}`] : []),
	].sort();
}

export async function getGuestLifetimeAllowance(
	input: { ownerId: string; browserSubjectHash?: string },
	client: Client,
) {
	const [receipt] = await client
		.select()
		.from(guestTrialEntitlement)
		.where(inArray(guestTrialEntitlement.subjectKey, guestEntitlementSubjects(input)))
		.limit(1);
	const historical = receipt
		? undefined
		: ((
				await client.execute(sql`
		SELECT "id", "currentJobId", "consumedJobId" FROM "guest_media_trial"
		WHERE "ownerId" = ${input.ownerId} ORDER BY "createdAt", "id" LIMIT 1`)
			).rows[0] as { currentJobId: string | null; consumedJobId: string | null } | undefined);
	return {
		limit: 1 as const,
		remaining: receipt || historical ? 0 : 1,
		resetsAt: null,
		existingJobId:
			receipt?.reservedJobId ?? historical?.currentJobId ?? historical?.consumedJobId ?? null,
	};
}

/** Same caller-owned sorted subject locks and atomic job/funding transaction as Prisma. */
export async function reserveGuestLifetimeEntitlement(
	input: { ownerId: string; browserSubjectHash: string; trialId: string; jobId: string; now: Date },
	tx: Client,
) {
	for (const subjectKey of guestEntitlementSubjects(input)) {
		await tx.insert(guestTrialEntitlement).values({
			subjectKey,
			trialId: input.trialId,
			reservedJobId: input.jobId,
			createdAt: input.now,
		});
	}
}
