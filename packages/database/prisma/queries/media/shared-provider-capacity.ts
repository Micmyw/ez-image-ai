import type { Prisma } from "../../generated/client";
import { ACTIVE_GENERATION_JOB_STATUSES } from "./state-machine";

/** A missing video account cap leaves the existing image-only admission unchanged. */
export function configuredSharedKieCapacity(environment = process.env): number | null {
	const value = Number(environment.VIDEO_V1_PROVIDER_CONCURRENCY);
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Acquire before owner/storage/account locks; count in a separate fresh statement. */
export async function lockSharedKieCapacity(tx: Prisma.TransactionClient): Promise<void> {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('media:provider-capacity:kie', 0))`;
}

export async function assertSharedKieCapacity(
	tx: Prisma.TransactionClient,
	maximum: number,
): Promise<void> {
	const active = await tx.generationJob.count({
		where: {
			OR: [
				{
					executionEngine: "legacy",
					terminalAt: null,
					status: { in: [...ACTIVE_GENERATION_JOB_STATUSES] },
				},
				{
					executionEngine: "video-workflow-v1",
					videoExecution: { stage: { notIn: ["READY", "REJECTED", "FAILED"] } },
				},
			],
		},
	});
	if (active >= maximum) throw new Error("PROVIDER_CONCURRENT_JOB_LIMIT_REACHED");
}
