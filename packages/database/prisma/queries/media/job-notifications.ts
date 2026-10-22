import { createHash } from "node:crypto";

import { getMediaDatabaseClient, type MediaDatabaseClient } from "./types";

export interface MediaJobNotification {
	eventId: string;
	jobId: string;
	/** Opaque committed revision; a READY asset can precede the job version. */
	version: string;
}

export function mediaJobNotification(input: {
	jobId: string;
	revision: string;
}): MediaJobNotification {
	if (!input.jobId || input.jobId.length > 128 || !input.revision || input.revision.length > 256)
		throw new Error("INVALID_MEDIA_JOB_NOTIFICATION");
	const digest = createHash("sha256")
		.update(JSON.stringify([input.jobId, input.revision]))
		.digest("hex");
	return { eventId: `mju_${digest}`, jobId: input.jobId, version: input.revision };
}

/** Call inside the transaction which makes the result visible. */
export async function recordMediaJobNotification(
	tx: MediaDatabaseClient,
	input: { jobId: string; revision: string },
): Promise<MediaJobNotification> {
	const notification = mediaJobNotification(input);
	// Receiver-first rollout: old Outbox consumers must drain before producers are enabled.
	if (process.env.MEDIA_JOB_EVENTS_ENABLED !== "true") return notification;
	const digest = notification.eventId.slice(4);
	// The ID is already known; a duplicate-safe insert avoids an upsert existence read.
	await tx.outboxEvent.createMany({
		data: [
			{
				id: notification.eventId,
				eventType: "MEDIA_JOB_UPDATED",
				aggregateType: "GenerationJob",
				aggregateId: input.jobId,
				dedupeKey: `media-job-updated:${digest}`,
				payload: { ...notification },
			},
		],
		skipDuplicates: true,
	});
	return notification;
}

export async function ownsMediaJobSubscription(
	userId: string,
	jobId: string,
	client?: MediaDatabaseClient,
): Promise<boolean> {
	const job = await getMediaDatabaseClient(client).generationJob.findFirst({
		where: { id: jobId, ownerType: "USER", ownerId: userId },
		select: { id: true },
	});
	return Boolean(job);
}

/** The fast publisher must never steal a consumer's lease or ACK before hub persistence. */
export async function acknowledgePublishedMediaJobNotification(
	notification: MediaJobNotification,
	client?: MediaDatabaseClient,
): Promise<void> {
	await getMediaDatabaseClient(client).outboxEvent.updateMany({
		where: {
			id: notification.eventId,
			eventType: "MEDIA_JOB_UPDATED",
			aggregateId: notification.jobId,
			status: "PENDING",
			leaseToken: null,
		},
		data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
	});
}
