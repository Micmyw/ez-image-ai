import type { PrismaClient } from "@repo/database/generated-client";

export interface UnmanagedLegacyTask {
	outcome: "NOT_MANAGED";
	executionEngine: string;
	done: true;
	waitSeconds: 0;
	outboxCommitted: false;
}

/** Read ownership before constructing providers or entering any legacy executor. */
export async function unmanagedLegacyTask(
	database: PrismaClient,
	payload: Record<string, unknown>,
): Promise<UnmanagedLegacyTask | null> {
	const engines: Array<string | undefined> = [];
	if (typeof payload.jobId === "string") {
		const job = await database.generationJob.findUnique({
			where: { id: payload.jobId },
			select: { executionEngine: true },
		});
		engines.push(job?.executionEngine);
	}
	if (typeof payload.assetId === "string") {
		const asset = await database.mediaAsset.findUnique({
			where: { id: payload.assetId },
			select: { verificationEngine: true },
		});
		engines.push(asset?.verificationEngine);
	}
	if (typeof payload.attemptId === "string") {
		const attempt = await database.generationAttempt.findUnique({
			where: { id: payload.attemptId },
			select: { job: { select: { executionEngine: true } } },
		});
		engines.push(attempt?.job.executionEngine);
	}
	if (typeof payload.providerWebhookEventId === "string") {
		const event = await database.providerWebhookEvent.findUnique({
			where: { id: payload.providerWebhookEventId },
			select: { provider: true, providerTaskId: true, providerEventId: true },
		});
		if (
			event?.provider === "kie-video-v1" ||
			event?.provider === "sightengine-video-v1" ||
			event?.provider === "seeapi-video-v1" ||
			event?.providerEventId?.startsWith("video-v1:")
		) {
			engines.push("video-workflow-v1");
		}
		if (event?.providerTaskId) {
			const attempt = await database.generationAttempt.findFirst({
				where: { provider: event.provider, providerTaskId: event.providerTaskId },
				select: { job: { select: { executionEngine: true } } },
			});
			engines.push(attempt?.job.executionEngine);
		}
	}
	const executionEngine = engines.find((engine) => engine !== undefined && engine !== "legacy");
	return executionEngine === undefined
		? null
		: {
				outcome: "NOT_MANAGED",
				executionEngine,
				done: true,
				waitSeconds: 0,
				outboxCommitted: false,
			};
}
