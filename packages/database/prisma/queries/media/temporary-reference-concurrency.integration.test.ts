import { PrismaPg } from "@prisma/adapter-pg";
import { temporaryReferenceObjectKey, type TemporaryReference } from "@repo/config";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient, type Prisma } from "../../generated/client";
import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { lockOwnerStorageUsage } from "./storage-usage-locks";
import {
	commitTemporaryReferenceVerificationTransaction,
	reserveTemporaryReference,
} from "./temporary-references";
import { runReadCommitted, runSerializable, type MediaTransactionClient } from "./types";

let client: PrismaClient;
let observer: Pool;
const verification = {
	provider: "seeapi",
	ruleVersion: "fixture-rule",
	policyVersion: "fixture-policy",
};

function isolatedUrl() {
	const value = process.env.TEST_DATABASE_URL;
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const url = new URL(value);
	if (
		!["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
		!/(^|[_-])test([_-]|$)/.test(url.pathname.slice(1)) ||
		value === process.env.DATABASE_URL
	)
		throw new Error("ISOLATED_LOCAL_TEST_DATABASE_REQUIRED");
	return value;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function reference(
	ownerId = `temporary-concurrency-${crypto.randomUUID()}`,
	bytes = 60,
): TemporaryReference {
	const now = new Date();
	return {
		v: 1,
		ownerId,
		assetId: crypto.randomUUID(),
		bytes,
		contentType: "image/png",
		checksum: "a".repeat(64),
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
	};
}

async function expiringReference() {
	const value = reference();
	const result = await observer.query<{ now: Date }>("SELECT clock_timestamp() AS now");
	const deadline = result.rows[0]!.now.getTime() + 700;
	value.createdAt = new Date(deadline - 86_400_000).toISOString();
	value.expiresAt = new Date(deadline).toISOString();
	return value;
}

function reserve(
	value: TemporaryReference,
	db: MediaTransactionClient = client,
	maximumBytes = 100n,
) {
	return reserveTemporaryReference(
		{
			ownerId: value.ownerId,
			assetId: value.assetId,
			bytes: value.bytes,
			expiresAt: new Date(value.expiresAt),
			maximumBytes,
		},
		db,
	);
}

function commit(
	value: TemporaryReference,
	reservationId: string,
	db: MediaTransactionClient = client,
) {
	return commitTemporaryReferenceVerificationTransaction(
		{
			ownerId: value.ownerId,
			reference: value,
			reservationId,
			verification,
		},
		db,
	);
}

function observedTransactions(
	isolation: string[],
	onFirstPid?: (pid: number) => void,
): MediaTransactionClient {
	return new Proxy(client, {
		get(target, key, receiver) {
			if (key === "$transaction")
				return async (
					operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
					options: {
						isolationLevel?: Prisma.TransactionIsolationLevel;
						timeout?: number;
						maxWait?: number;
					},
				) => {
					isolation.push(options.isolationLevel ?? "default");
					return target.$transaction(async (tx) => {
						if (isolation.length === 1 && onFirstPid) {
							const [state] = await tx.$queryRaw<
								Array<{ pid: number }>
							>`SELECT pg_backend_pid() AS pid`;
							onFirstPid(state!.pid);
						}
						return operation(tx);
					}, options);
				};
			return Reflect.get(target, key, receiver);
		},
	}) as MediaTransactionClient;
}

async function waitForLock(pid: number) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const state = await observer.query<{ wait_event_type: string }>(
			"SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
			[pid],
		);
		if (state.rows[0]?.wait_event_type === "Lock") return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Expected temporary-reference transaction ${pid} to wait for its lock`);
}

async function afterDatabaseDeadline(value: string) {
	const deadline = Date.parse(value);
	while (true) {
		const result = await observer.query<{ now: Date }>("SELECT clock_timestamp() AS now");
		if (result.rows[0]!.now.getTime() >= deadline) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function behindLock<T>(
	hold: (tx: Prisma.TransactionClient) => Promise<unknown>,
	run: (db: MediaTransactionClient) => Promise<T>,
	whileBlocked?: () => Promise<void>,
) {
	const ready = deferred<void>();
	const release = deferred<void>();
	const pid = deferred<number>();
	const isolation: string[] = [];
	const holder = runReadCommitted(client, async (tx) => {
		await hold(tx);
		ready.resolve();
		await release.promise;
	});
	const holderOutcome = Promise.allSettled([holder]);
	let contender: Promise<PromiseSettledResult<T>[]> | undefined;
	try {
		await Promise.race([
			ready.promise,
			holder.then(() => {
				throw new Error("LOCK_BARRIER_NOT_REACHED");
			}),
		]);
		contender = Promise.allSettled([run(observedTransactions(isolation, pid.resolve))]);
		const waiterPid = await Promise.race([
			pid.promise,
			contender.then(() => {
				throw new Error("WAITER_TRANSACTION_NOT_STARTED");
			}),
		]);
		await waitForLock(waiterPid);
		await whileBlocked?.();
	} finally {
		release.resolve();
		await Promise.all([holderOutcome, contender]);
	}
	const [held] = await holderOutcome;
	if (held!.status === "rejected") throw held!.reason;
	return { result: (await contender!)[0]!, isolation };
}

async function expectNoPreparedReview(value: TemporaryReference, reservationId: string) {
	expect(
		await client.storageUsageReservation.findUnique({ where: { id: reservationId } }),
	).toMatchObject({ status: "ACTIVE" });
	expect(await client.mediaAsset.findUnique({ where: { id: value.assetId } })).toBeNull();
	expect(await client.outboxEvent.count({ where: { aggregateId: value.assetId } })).toBe(0);
}

describe("temporary reference transactions with real PostgreSQL contention", () => {
	beforeEach(() => vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "true"));
	afterEach(() => vi.unstubAllEnvs());
	beforeAll(async () => {
		const connectionString = isolatedUrl();
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 60 }) });
		observer = new Pool({ connectionString, max: 1 });
		await client.$connect();
	});
	afterAll(async () => {
		// Preserve unique isolated fixtures, including any failed run's durable evidence.
		await client?.$disconnect();
		await observer?.end();
	});

	it("reserves and prepares all 50 independent owners once without serialization retries", async () => {
		const references = Array.from({ length: 50 }, () => reference());
		const isolation: string[][] = references.map(() => []);
		const results = await Promise.allSettled(
			references.map(async (value, index) => {
				const db = observedTransactions(isolation[index]!);
				const reserved = await reserve(value, db);
				return { reserved, prepared: await commit(value, reserved.id, db) };
			}),
		);
		expect(
			results
				.filter((result) => result.status === "rejected")
				.map((result) => String(result.reason)),
		).toEqual([]);
		for (const [index, result] of results.entries()) {
			if (result.status !== "fulfilled") throw result.reason;
			const value = references[index]!;
			expect(result.value.prepared.continuationEventIds).toHaveLength(1);
			expect(
				await client.storageUsageReservation.findMany({
					where: { ownerType: "USER", ownerId: value.ownerId },
				}),
			).toMatchObject([{ id: result.value.reserved.id, status: "COMMITTED", bytes: 60n }]);
			expect(
				await client.mediaAsset.findMany({ where: { ownerType: "USER", ownerId: value.ownerId } }),
			).toMatchObject([
				{
					id: value.assetId,
					status: "VERIFYING",
					objectKey: temporaryReferenceObjectKey(value),
					checksum: value.checksum,
					verificationGeneration: 1,
				},
			]);
			expect(
				await client.outboxEvent.findMany({ where: { aggregateId: value.assetId } }),
			).toMatchObject([
				{ id: result.value.prepared.continuationEventIds[0], eventType: "MEDIA_ASSET_VERIFY" },
			]);
			expect(isolation[index]).toEqual(["ReadCommitted", "ReadCommitted"]);
		}
	});

	it("observes quota committed while waiting for its owner lock without restarting", async () => {
		const first = reference();
		const second = reference(first.ownerId);
		const race = await behindLock(
			async (tx) => {
				await lockOwnerStorageUsage({ ownerType: "USER", ownerId: first.ownerId }, tx);
				await tx.storageUsageReservation.create({
					data: {
						ownerType: "USER",
						ownerId: first.ownerId,
						bytes: 60n,
						referenceKey: `temporary-reference:${first.assetId}`,
						expiresAt: new Date(first.expiresAt),
					},
				});
			},
			(db) => reserve(second, db),
		);
		expect(race.result.status).toBe("rejected");
		if (race.result.status === "rejected")
			expect(race.result.reason.message).toBe("STORAGE_QUOTA_EXCEEDED");
		expect(race.isolation).toEqual(["ReadCommitted"]);
		expect(await client.storageUsageReservation.count({ where: { ownerId: first.ownerId } })).toBe(
			1,
		);
	});

	it("preserves the five active uploads per owner bound under six concurrent reservations", async () => {
		const ownerId = reference().ownerId;
		const results = await Promise.allSettled(
			Array.from({ length: 6 }, () => reserve(reference(ownerId, 1))),
		);
		expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(5);
		expect(
			results.filter((value) => value.status === "rejected").map((value) => value.reason.message),
		).toEqual(["ACTIVE_UPLOAD_SESSION_LIMIT_EXCEEDED"]);
		expect(
			await client.storageUsageReservation.aggregate({ where: { ownerId }, _sum: { bytes: true } }),
		).toMatchObject({ _sum: { bytes: 5n } });
	});

	it("commits concurrent duplicate uploads into exactly one immutable asset and review intent", async () => {
		const value = reference();
		const reserved = await reserve(value);
		const results = await Promise.allSettled(
			Array.from({ length: 6 }, () => commit(value, reserved.id)),
		);
		expect(results.filter((item) => item.status === "rejected")).toEqual([]);
		expect(
			results.flatMap((item) =>
				item.status === "fulfilled" ? item.value.continuationEventIds : [],
			),
		).toHaveLength(1);
		expect(await client.mediaAsset.count({ where: { id: value.assetId } })).toBe(1);
		expect(await client.outboxEvent.count({ where: { aggregateId: value.assetId } })).toBe(1);
		await client.mediaAsset.update({
			where: { id: value.assetId },
			data: { verificationProviderTaskId: "same-accepted-task", verificationAttemptCount: 1 },
		});
		expect(await commit(value, reserved.id)).toMatchObject({ continuationEventIds: [] });
		expect(await client.mediaAsset.findUnique({ where: { id: value.assetId } })).toMatchObject({
			verificationGeneration: 1,
			verificationProviderTaskId: "same-accepted-task",
			verificationAttemptCount: 1,
		});
	});

	it("does not reserve a deadline that expired while waiting for the owner lock", async () => {
		const value = await expiringReference();
		const race = await behindLock(
			(tx) => lockOwnerStorageUsage({ ownerType: "USER", ownerId: value.ownerId }, tx),
			(db) => reserve(value, db),
			() => afterDatabaseDeadline(value.expiresAt),
		);
		expect(race.result.status).toBe("rejected");
		if (race.result.status === "rejected")
			expect(race.result.reason.message).toBe("TEMPORARY_REFERENCE_EXPIRED");
		expect(await client.storageUsageReservation.count({ where: { ownerId: value.ownerId } })).toBe(
			0,
		);
	});

	it.each(["asset binding", "reservation row"] as const)(
		"rejects an upload that expires during the %s lock wait",
		async (lock) => {
			const value = await expiringReference();
			const reserved = await reserve(value);
			const race = await behindLock(
				async (tx) => {
					if (lock === "asset binding") await lockMediaAssetGenerationBindings([value.assetId], tx);
					else
						await tx.$queryRaw`SELECT id FROM storage_usage_reservation WHERE id = ${reserved.id} FOR UPDATE`;
				},
				(db) => commit(value, reserved.id, db),
				() => afterDatabaseDeadline(value.expiresAt),
			);
			expect(race.result.status).toBe("rejected");
			if (race.result.status === "rejected")
				expect(race.result.reason.message).toBe("TEMPORARY_REFERENCE_EXPIRED");
			await expectNoPreparedReview(value, reserved.id);
		},
	);

	it.each(["COMMITTED", "RELEASED", "EXPIRED"] as const)(
		"observes legacy ACTIVE finalization to %s after its reservation row wait",
		async (status) => {
			const value = reference();
			const reserved = await reserve(value);
			const race = await behindLock(
				(tx) =>
					tx.storageUsageReservation.updateMany({
						where: { id: reserved.id, status: "ACTIVE" },
						data: { status },
					}),
				(db) => commit(value, reserved.id, db),
			);
			expect(race.isolation).toEqual(["ReadCommitted"]);
			expect(
				await client.storageUsageReservation.findUnique({ where: { id: reserved.id } }),
			).toMatchObject({ status });
			if (status === "COMMITTED") {
				expect(race.result.status).toBe("fulfilled");
				expect(await client.outboxEvent.count({ where: { aggregateId: value.assetId } })).toBe(1);
			} else {
				expect(race.result.status).toBe("rejected");
				if (race.result.status === "rejected")
					expect(race.result.reason.message).toBe("TEMPORARY_REFERENCE_INVALID");
				expect(await client.mediaAsset.findUnique({ where: { id: value.assetId } })).toBeNull();
				expect(await client.outboxEvent.count({ where: { aggregateId: value.assetId } })).toBe(0);
			}
		},
	);

	it("forces an old Serializable quota waiter to retry after the fresh reservation commits", async () => {
		const first = reference();
		const firstDone = deferred<void>();
		const release = deferred<void>();
		const waiterPid = deferred<number>();
		let attempts = 0;
		const holdingClient = new Proxy(client, {
			get(target, key, receiver) {
				if (key === "$transaction")
					return (
						operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
						options: { isolationLevel?: Prisma.TransactionIsolationLevel },
					) =>
						target.$transaction(
							async (tx) => {
								const result = await operation(tx);
								firstDone.resolve();
								await release.promise;
								return result;
							},
							{ ...options, timeout: 20_000 },
						);
				return Reflect.get(target, key, receiver);
			},
		}) as MediaTransactionClient;
		const holder = reserve(first, holdingClient);
		const holderOutcome = Promise.allSettled([holder]);
		let waiting: Promise<PromiseSettledResult<bigint>[]> | undefined;
		try {
			await Promise.race([
				firstDone.promise,
				holder.then(() => {
					throw new Error("RESERVE_BARRIER_NOT_REACHED");
				}),
			]);
			waiting = Promise.allSettled([
				runSerializable(client, async (tx) => {
					attempts += 1;
					if (attempts === 1) {
						const [state] = await tx.$queryRaw<
							Array<{ pid: number }>
						>`SELECT pg_backend_pid() AS pid`;
						waiterPid.resolve(state!.pid);
					}
					await lockOwnerStorageUsage({ ownerType: "USER", ownerId: first.ownerId }, tx);
					return (
						(
							await tx.storageUsageReservation.aggregate({
								where: { ownerId: first.ownerId, status: { in: ["ACTIVE", "COMMITTED"] } },
								_sum: { bytes: true },
							})
						)._sum.bytes ?? 0n
					);
				}),
			]);
			await waitForLock(await waiterPid.promise);
		} finally {
			release.resolve();
			await Promise.all([holderOutcome, waiting]);
		}
		expect((await holderOutcome)[0]!.status).toBe("fulfilled");
		expect((await waiting!)[0]).toMatchObject({ status: "fulfilled", value: 60n });
		expect(attempts).toBe(2);
	});
});
