import { PrismaPg } from "@prisma/adapter-pg";
import {
	claimOutboxBatch,
	completeOutboxEvent,
	deferOutboxEvent,
	releaseOutboxEvent,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleDispatch, type WorkflowCreator } from "../../../../apps/workflows/src/dispatch";
import { createJobDispatcher } from "../orchestration/client";
import { deliverOutboxEvent } from "./deliver-outbox-event";
import { dispatchOutbox } from "./dispatch-outbox";

describe("committed output event recovery in PostgreSQL", () => {
	let database: PrismaClient;
	beforeAll(() => {
		const url = new URL(process.env.TEST_DATABASE_URL ?? "");
		if (
			!["127.0.0.1", "localhost"].includes(url.hostname) ||
			url.port !== "55432" ||
			!/test/.test(url.pathname)
		)
			throw new Error("USE_DISPOSABLE_LOCAL_TEST_DATABASE");
		database = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href }) });
	});
	afterAll(async () => database?.$disconnect());
	it.each(["after-commit-before-wake", "after-accepted-wake"] as const)(
		"recovers %s through scanning with one Workflow identity and ACKs only completion",
		async (crashAt) => {
			// Isolate the unfiltered recovery scan from other suites' current-time events.
			let now = new Date("1901-01-01T00:00:00.000Z");
			const asset = await database.mediaAsset.create({
				data: {
					ownerType: "USER",
					ownerId: "output-delivery-test",
					kind: "OUTPUT",
					status: "VERIFYING",
					objectKey: `test/${crypto.randomUUID()}`,
					mimeType: "image/png",
					byteSize: 16n,
				},
			});
			const committed = await database.outboxEvent.create({
				data: {
					aggregateId: asset.id,
					aggregateType: "MEDIA_ASSET",
					eventType: "MEDIA_ASSET_VERIFY",
					dedupeKey: `output-delivery-test:${asset.id}`,
					payload: { assetId: asset.id },
					availableAt: now,
				},
			});
			const identities = new Set<string>();
			let completed = false;
			let loseResponse = crashAt === "after-accepted-wake";
			const workflows: WorkflowCreator = {
				async createBatch(batch) {
					for (const item of batch) identities.add(item.id);
				},
				async get() {
					return {
						async status() {
							return { status: completed ? "complete" : "running" };
						},
						async restart() {
							throw new Error("must not restart");
						},
					};
				},
			};
			const secret = "isolated-output-review-test-secret-32";
			const dispatch = createJobDispatcher({
				url: "https://isolated.example/internal/dispatch",
				secret,
				fetch: async (request, init) => {
					const response = await handleDispatch(new Request(request, init), secret, workflows);
					if (loseResponse) {
						loseResponse = false;
						throw new TypeError("response lost after acceptance");
					}
					return response;
				},
			});
			const store = {
				claimBatch: (input: Parameters<typeof claimOutboxBatch>[0]) =>
					claimOutboxBatch({ ...input, now }, database),
				async complete(id: string, workerId: string, leaseToken: string) {
					await completeOutboxEvent(id, workerId, leaseToken, database);
				},
				async defer(input: { id: string; workerId: string; leaseToken: string; retryAt: Date }) {
					expect(await deferOutboxEvent({ ...input, now }, database)).toEqual({ applied: true });
				},
				async release(input: {
					id: string;
					workerId: string;
					leaseToken: string;
					errorCode: string;
					retryAt: Date;
				}) {
					await releaseOutboxEvent({ ...input, error: input.errorCode, maxAttempts: 12 }, database);
				},
			};
			try {
				for (let cycle = 0; cycle < 3; cycle++) {
					completed = cycle === 2;
					if (cycle > 0 || crashAt === "after-accepted-wake")
						await dispatchOutbox(
							cycle === 0
								? { workerId: "targeted-worker", outputReviewEventId: committed.id }
								: { workerId: "scheduled-recovery" },
							{
								store,
								now: () => now,
								deliver: (event) =>
									deliverOutboxEvent(event, {
										resolveDispatchRoute: async () => null,
										trigger: (taskId, payload) =>
											dispatch(taskId, payload, {
												requireCompletion: true,
												idempotencyKey: `outbox:${event.id}:attempt:${event.attempts}:${taskId}`,
											}),
									}),
							},
						);
					const event = await database.outboxEvent.findUniqueOrThrow({
						where: { id: committed.id },
					});
					expect(event).toMatchObject({
						status: completed ? "PROCESSED" : "PENDING",
						attempts: completed ? 1 : 0,
					});
					if (!completed) expect(event.processedAt).toBeNull();
					now = new Date(now.getTime() + 30_000);
				}
				expect(identities.size).toBe(1);
			} finally {
				await database.outboxEvent.delete({ where: { id: committed.id } });
				await database.mediaAsset.delete({ where: { id: asset.id } });
			}
		},
	);
});
