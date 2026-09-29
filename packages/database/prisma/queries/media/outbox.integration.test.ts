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
	const ownedAssets: string[] = [];
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
		if (ownedAssets.length)
			await client.mediaAsset.deleteMany({ where: { id: { in: ownedAssets.splice(0) } } });
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

	async function createOutputEvent(kind: "INPUT" | "OUTPUT" = "OUTPUT") {
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: "outbox-target-test",
				kind,
				status: "VERIFYING",
				objectKey: `test/${crypto.randomUUID()}`,
				mimeType: "image/png",
				byteSize: 16n,
			},
		});
		ownedAssets.push(asset.id);
		const event = await client.outboxEvent.create({
			data: {
				eventType: "MEDIA_ASSET_VERIFY",
				aggregateType: "MEDIA_ASSET",
				aggregateId: asset.id,
				dedupeKey: `test-output-poll:${asset.id}`,
				payload: { assetId: asset.id },
				availableAt: initialTime,
			},
		});
		ownedIds.push(event.id);
		return event;
	}

	it("targets only the committed output event and leaves input/other events to normal delivery", async () => {
		const output = await createOutputEvent();
		const input = await createOutputEvent("INPUT");
		const other = await createEvent();
		const target = (id: string) =>
			claimOutboxBatch(
				{
					workerId: "target",
					limit: 1,
					leaseSeconds: 60,
					now: initialTime,
					outputReviewEventId: id,
				},
				client,
			);
		for (const id of [input.id, other.id, "missing"]) expect(await target(id)).toEqual([]);
		expect(await target(output.id)).toMatchObject([{ id: output.id, attempts: 1 }]);
		expect(await target(output.id)).toEqual([]);
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: input.id } })).toMatchObject({
			status: "PENDING",
			attempts: 0,
		});
	});
	it("claims old output events without new trace fields but rejects mismatched payload identity", async () => {
		const old = await createOutputEvent();
		await client.outboxEvent.update({ where: { id: old.id }, data: { payload: {} } });
		expect(
			await claimOutboxBatch(
				{
					workerId: "old-format",
					limit: 1,
					leaseSeconds: 60,
					now: initialTime,
					outputReviewEventId: old.id,
				},
				client,
			),
		).toMatchObject([{ id: old.id }]);
		const mismatched = await createOutputEvent();
		await client.outboxEvent.update({
			where: { id: mismatched.id },
			data: { payload: { assetId: old.aggregateId } },
		});
		expect(
			await claimOutboxBatch(
				{
					workerId: "mismatched",
					limit: 1,
					leaseSeconds: 60,
					now: initialTime,
					outputReviewEventId: mismatched.id,
				},
				client,
			),
		).toEqual([]);
	});

	it("has one winner between targeted wake and scheduled scan, and fences an expired winner", async () => {
		const event = await createOutputEvent();
		const claims = await Promise.all([
			claimOutboxBatch(
				{
					workerId: "target",
					limit: 1,
					leaseSeconds: 60,
					now: initialTime,
					outputReviewEventId: event.id,
				},
				client,
			),
			claimOutboxBatch(
				{ workerId: "scan", limit: 100, leaseSeconds: 60, now: initialTime },
				client,
			),
		]);
		const winners = claims.flat().filter((row) => row.id === event.id);
		expect(winners).toHaveLength(1);
		const oldOwner = claims[0]!.some((row) => row.id === event.id) ? "target" : "scan";
		const reclaimed = await claimOutboxBatch(
			{
				workerId: "recovery",
				limit: 1,
				leaseSeconds: 60,
				now: new Date(initialTime.getTime() + 60001),
				outputReviewEventId: event.id,
			},
			client,
		);
		expect(reclaimed).toHaveLength(1);
		expect(reclaimed[0]!.leaseToken).not.toBe(winners[0]!.leaseToken);
		expect(await completeOutboxEvent(event.id, oldOwner, winners[0]!.leaseToken, client)).toEqual({
			count: 0,
		});
		expect(
			await completeOutboxEvent(event.id, "recovery", reclaimed[0]!.leaseToken, client),
		).toEqual({ count: 1 });
	});

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
