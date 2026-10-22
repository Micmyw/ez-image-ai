import { afterEach, describe, expect, it, vi } from "vitest";

import {
	acknowledgePublishedMediaJobNotification,
	mediaJobNotification,
	ownsMediaJobSubscription,
	recordMediaJobNotification,
} from "./job-notifications";
import type { MediaDatabaseClient } from "./types";

afterEach(() => vi.unstubAllEnvs());

describe("committed result notification intents", () => {
	it("uses a stable event identity and inserts only into the supplied transaction", async () => {
		vi.stubEnv("MEDIA_JOB_EVENTS_ENABLED", "true");
		const createMany = vi.fn().mockResolvedValue({ count: 1 });
		const tx = { outboxEvent: { createMany } } as unknown as MediaDatabaseClient;
		const input = { jobId: "job-a", revision: "asset:a:g1:ready" };
		const first = await recordMediaJobNotification(tx, input);
		expect(await recordMediaJobNotification(tx, input)).toEqual(first);
		expect(first).not.toEqual(mediaJobNotification({ ...input, revision: "asset:a:g2:ready" }));
		expect(createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: [
					expect.objectContaining({
						id: first.eventId,
						eventType: "MEDIA_JOB_UPDATED",
						aggregateId: "job-a",
						payload: first,
					}),
				],
				skipDuplicates: true,
			}),
		);
	});
	it("does not emit a new event until receiver-first rollout enables producers", async () => {
		vi.stubEnv("MEDIA_JOB_EVENTS_ENABLED", "false");
		const createMany = vi.fn();
		await recordMediaJobNotification(
			{ outboxEvent: { createMany } } as unknown as MediaDatabaseClient,
			{ jobId: "job", revision: "ready" },
		);
		expect(createMany).not.toHaveBeenCalled();
	});
	it("checks the current user owner using only the job identity projection", async () => {
		const findFirst = vi.fn().mockResolvedValue(null);
		expect(
			await ownsMediaJobSubscription("owner", "job", {
				generationJob: { findFirst },
			} as unknown as MediaDatabaseClient),
		).toBe(false);
		expect(findFirst).toHaveBeenCalledWith({
			where: { id: "job", ownerType: "USER", ownerId: "owner" },
			select: { id: true },
		});
	});
	it("never steals an Outbox lease when acknowledging the fast delivery", async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 0 });
		const event = mediaJobNotification({ jobId: "job", revision: "ready" });
		await acknowledgePublishedMediaJobNotification(event, {
			outboxEvent: { updateMany },
		} as unknown as MediaDatabaseClient);
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: event.eventId,
					eventType: "MEDIA_JOB_UPDATED",
					aggregateId: "job",
					status: "PENDING",
					leaseToken: null,
				},
				data: expect.objectContaining({ status: "PROCESSED" }),
			}),
		);
	});
});
