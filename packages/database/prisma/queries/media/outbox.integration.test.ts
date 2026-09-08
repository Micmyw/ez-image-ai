import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import {
	claimOutboxBatch,
	completeOutboxEvent,
	deferOutboxEvent,
	releaseOutboxEvent,
} from "./outbox";

describe("durable Outbox completion receipts in PostgreSQL", () => {
	let client: PrismaClient;
	const ownedIds: string[] = [];
	const initialTime = new Date("1900-01-01T00:00:00.000Z");

	beforeAll(() => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
		const parsed = new URL(connectionString);
		if (
			connectionString === process.env.DATABASE_URL ||
			!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
			!/(^|[_-])(test|testing)([_-]|$)/.test(parsed.pathname.slice(1).toLowerCase())
		) {
			throw new Error("UNSAFE_TEST_DATABASE: use a separate local test database");
		}
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
	});

	afterEach(async () => {
		if (ownedIds.length)
			await client.outboxEvent.deleteMany({ where: { id: { in: ownedIds.splice(0) } } });
	});
	afterAll(async () => client?.$disconnect());

	async function createEvent() {
		const dedupeKey = `test-workflow-receipt:${crypto.randomUUID()}`;
		const event = await client.outboxEvent.create({
			data: {
				eventType: "PAYMENT_EVENT_RECEIVED",
				aggregateType: "PAYMENT_EVENT",
				aggregateId: dedupeKey,
				dedupeKey,
				payload: { paymentEventId: dedupeKey },
				availableAt: initialTime,
			},
		});
		ownedIds.push(event.id);
		return event;
	}

	async function claim(id: string, now: Date, workerId = "receipt-worker") {
		const claims = await claimOutboxBatch({ workerId, limit: 100, leaseSeconds: 60, now }, client);
		const event = claims.find((entry) => entry.id === id);
		expect(event).toBeDefined();
		return event!;
	}

	it("preserves one delivery attempt through more pending checks than the failure budget", async () => {
		const created = await createEvent();
		let now = initialTime;
		for (let check = 0; check < 15; check += 1) {
			const claimed = await claim(created.id, now);
			expect(claimed.attempts).toBe(1);
			const retryAt = new Date(now.getTime() + 30_000);
			expect(
				await deferOutboxEvent(
					{
						id: created.id,
						workerId: "receipt-worker",
						leaseToken: claimed.leaseToken,
						now,
						retryAt,
					},
					client,
				),
			).toEqual({ applied: true });
			expect(
				await client.outboxEvent.findUniqueOrThrow({ where: { id: created.id } }),
			).toMatchObject({
				status: "PENDING",
				attempts: 0,
				leaseOwner: null,
				leaseToken: null,
				leasedUntil: null,
				processedAt: null,
				availableAt: retryAt,
			});
			const early = await claimOutboxBatch(
				{
					workerId: "receipt-worker",
					limit: 100,
					leaseSeconds: 60,
					now: new Date(retryAt.getTime() - 1),
				},
				client,
			);
			expect(early.some((entry) => entry.id === created.id)).toBe(false);
			now = retryAt;
		}
		const completed = await claim(created.id, now);
		expect(completed.attempts).toBe(1);
		expect(
			await completeOutboxEvent(created.id, "receipt-worker", completed.leaseToken, client),
		).toEqual({ count: 1 });
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject(
			{ status: "PROCESSED", attempts: 1 },
		);
	});

	it("advances the delivery only on failure and decrements at most once under concurrent defer", async () => {
		const created = await createEvent();
		const first = await claim(created.id, initialTime);
		const retryAt = new Date(initialTime.getTime() + 30_000);
		expect(
			await releaseOutboxEvent(
				{
					id: created.id,
					workerId: "receipt-worker",
					leaseToken: first.leaseToken,
					error: "WORKFLOWS_EXECUTION_FAILED",
					maxAttempts: 12,
					retryAt,
				},
				client,
			),
		).toEqual({ applied: true, deadLettered: false });
		const second = await claim(created.id, retryAt);
		expect(second.attempts).toBe(2);
		const deferredAt = new Date(retryAt.getTime() + 30_000);
		const results = await Promise.all(
			[1, 2].map(() =>
				deferOutboxEvent(
					{
						id: created.id,
						workerId: "receipt-worker",
						leaseToken: second.leaseToken,
						now: retryAt,
						retryAt: deferredAt,
					},
					client,
				),
			),
		);
		expect(results.filter((result) => result.applied)).toHaveLength(1);
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject(
			{ status: "PENDING", attempts: 1 },
		);
		const third = await claim(created.id, deferredAt);
		expect(third.attempts).toBe(2);
		await client.outboxEvent.update({ where: { id: created.id }, data: { attempts: 12 } });
		expect(
			await releaseOutboxEvent(
				{
					id: created.id,
					workerId: "receipt-worker",
					leaseToken: third.leaseToken,
					error: "WORKFLOWS_EXECUTION_FAILED",
					maxAttempts: 12,
					retryAt: deferredAt,
				},
				client,
			),
		).toEqual({ applied: true, deadLettered: true });
	});

	it("does not decrement an expired or reclaimed lease, including a reused worker ID", async () => {
		const created = await createEvent();
		const first = await claim(created.id, initialTime);
		const expiredAt = new Date(initialTime.getTime() + 60_001);
		expect(
			await deferOutboxEvent(
				{
					id: created.id,
					workerId: "receipt-worker",
					leaseToken: first.leaseToken,
					now: expiredAt,
					retryAt: expiredAt,
				},
				client,
			),
		).toEqual({ applied: false });
		const second = await claim(created.id, expiredAt);
		expect(second.leaseToken).not.toBe(first.leaseToken);
		expect(
			await deferOutboxEvent(
				{
					id: created.id,
					workerId: "receipt-worker",
					leaseToken: first.leaseToken,
					now: expiredAt,
					retryAt: expiredAt,
				},
				client,
			),
		).toEqual({ applied: false });
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject(
			{ status: "LEASED", attempts: 2, leaseToken: second.leaseToken },
		);
	});
});
