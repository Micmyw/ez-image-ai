import {
	existingPortraitPackTrial,
	PORTRAIT_PACK_PURCHASE_SQL,
	type PortraitPackTrialInput,
} from "../../shared/portrait-packs";
import { db } from "../client";

export async function hasPortraitPackPurchase(userId: string): Promise<boolean> {
	const [result] = await db.$queryRawUnsafe<Array<{ unlocked: boolean }>>(
		PORTRAIT_PACK_PURCHASE_SQL,
		userId,
	);
	return result?.unlocked === true;
}

export function getPortraitPackTrials(
	subjectKey: string,
	client: Pick<typeof db, "portraitPackTrial"> = db,
) {
	return client.portraitPackTrial.findMany({
		where: { subjectKey },
		orderBy: { slot: "asc" },
		select: { requestId: true, cardKeys: true },
	});
}

export async function issuePortraitPackTrial(input: PortraitPackTrialInput) {
	return db.$transaction(
		async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`portrait-pack-trial:${input.subjectKey}`}, 0))`;
			const issued = await getPortraitPackTrials(input.subjectKey, tx);
			const previous = existingPortraitPackTrial(issued, input.requestId);
			if (previous) return { receipt: previous, used: issued.length };
			const slot = issued.length + 1;
			const receipt = await tx.portraitPackTrial.create({
				data: { ...input, slot },
				select: { requestId: true, cardKeys: true },
			});
			return { receipt, used: slot };
		},
		{ isolationLevel: "ReadCommitted" },
	);
}
