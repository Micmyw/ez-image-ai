import { createHash } from "node:crypto";

import type { PrismaClient } from "@repo/database/generated-client";
import { expect } from "vitest";

/** Native video executes in its Workflow. Only a committed result hint may use the shared Outbox. */
export async function expectVideoNotificationOutbox(
	client: Pick<PrismaClient, "outboxEvent">,
	jobId: string,
	revision = "video:ready",
) {
	const events = await client.outboxEvent.findMany({
		where: { aggregateId: jobId },
		select: {
			id: true,
			eventType: true,
			aggregateType: true,
			aggregateId: true,
			dedupeKey: true,
			payload: true,
		},
	});
	if (process.env.MEDIA_JOB_EVENTS_ENABLED !== "true") {
		expect(events).toEqual([]);
		return;
	}
	const digest = createHash("sha256")
		.update(JSON.stringify([jobId, revision]))
		.digest("hex");
	// Exact equality forbids GENERATION_*, legacy dispatch, foreign jobs and duplicate
	// terminal intents while permitting either PENDING recovery or an already ACKed hint.
	expect(events).toEqual([
		{
			id: `mju_${digest}`,
			eventType: "MEDIA_JOB_UPDATED",
			aggregateType: "GenerationJob",
			aggregateId: jobId,
			dedupeKey: `media-job-updated:${digest}`,
			payload: { eventId: `mju_${digest}`, jobId, version: revision },
		},
	]);
}
