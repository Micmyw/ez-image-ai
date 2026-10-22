import { PrismaPg } from "@prisma/adapter-pg";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lockOwnerStorageUsage as lockDrizzleOwnerStorageUsage } from "../../../drizzle/queries/media-storage-locks";
import * as drizzleSchema from "../../../drizzle/schema/postgres";
import { PrismaClient, type Prisma } from "../../generated/client";
import { lockOwnerStorageUsage } from "./storage-usage-locks";
import { runReadCommitted, runSerializable, type SerializableAttemptEvent } from "./types";

let client: PrismaClient;
let observer: Pool;
let drizzlePool: Pool;
let drizzleClient: NodePgDatabase<typeof drizzleSchema>;
const prefix = `storage-fence-${crypto.randomUUID()}`;
type Owner = { ownerType: "USER" | "ORGANIZATION"; ownerId: string };

function isolatedUrl(): string {
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
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function owner(): Owner {
	return { ownerType: "USER", ownerId: `${prefix}-${crypto.randomUUID()}` };
}

async function reserveWithinQuota(
	tx: Prisma.TransactionClient,
	scope: Owner,
	referenceKey: string,
) {
	// This must be a statement after the completed owner fence, never a CTE in
	// the lock statement, whose ReadCommitted snapshot can predate the wait.
	const usage = await tx.storageUsageReservation.aggregate({
		where: { ...scope, status: { in: ["ACTIVE", "COMMITTED"] } },
		_sum: { bytes: true },
	});
	const observedBytes = usage._sum.bytes ?? 0n;
	if (observedBytes + 60n > 100n) return { accepted: false, observedBytes };
	await tx.storageUsageReservation.create({
		data: {
			...scope,
			bytes: 60n,
			referenceKey,
			expiresAt: new Date(Date.now() + 60_000),
		},
	});
	return { accepted: true, observedBytes };
}

async function waitForAdvisoryWait(pid: number) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const state = await observer.query<{ wait_event_type: string; wait_event: string }>(
			"SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1",
			[pid],
		);
		if (state.rows[0]?.wait_event_type === "Lock" && state.rows[0]?.wait_event === "advisory")
			return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Storage fence waiter ${pid} never reached its advisory wait`);
}

async function raceQuotaWriters(
	seedFence: boolean,
	waiterIsolation: "Serializable" | "ReadCommitted",
	options: { holder?: "Serializable" | "Drizzle"; rollback?: boolean } = {},
) {
	const scope = owner();
	if (seedFence) await client.mediaOwnerStorageFence.create({ data: scope });
	const holderReady = deferred<void>();
	const releaseHolder = deferred<void>();
	const waiterPid = deferred<number>();
	const attempts: SerializableAttemptEvent[] = [];
	let entered = 0;
	let holderCommitted = false;
	const rollback = new Error("fixture holder rollback");
	const hold = async () => {
		holderReady.resolve();
		await releaseHolder.promise;
		if (options.rollback) throw rollback;
	};
	const prismaHolder = async (tx: Prisma.TransactionClient) => {
		await lockOwnerStorageUsage(scope, tx);
		const result = await reserveWithinQuota(tx, scope, `${scope.ownerId}:holder`);
		await hold();
		return result;
	};
	const executeHolder = () => {
		if (options.holder === "Drizzle")
			return drizzleClient.transaction(async (tx) => {
				await lockDrizzleOwnerStorageUsage(scope, tx);
				await tx.execute(sql`
					INSERT INTO storage_usage_reservation
						(id, "ownerType", "ownerId", bytes, "referenceKey", "expiresAt")
					VALUES (${crypto.randomUUID()}, ${scope.ownerType}::"OwnerType", ${scope.ownerId},
						60, ${`${scope.ownerId}:holder`}, NOW() + INTERVAL '1 minute')
				`);
				await hold();
				return { accepted: true, observedBytes: 0n };
			});
		return options.holder === "Serializable"
			? runSerializable(client, prismaHolder)
			: runReadCommitted(client, prismaHolder);
	};
	const holder = executeHolder().then((result) => {
		holderCommitted = true;
		return result;
	});
	// Observe failures immediately, including while another transaction awaits
	// a gate, without allowing unhandled rejections to obscure the real error.
	const holderOutcome = holder.then(
		(result) => ({ result, error: null }),
		(error: unknown) => {
			holderReady.resolve();
			return { result: null, error };
		},
	);
	await holderReady.promise;
	const operation = async (tx: Prisma.TransactionClient) => {
		entered += 1;
		if (entered === 1) {
			const [snapshot] = await tx.$queryRaw<Array<{ pid: number; snapshot: string }>>`
				SELECT pg_backend_pid() AS pid, txid_current_snapshot()::text AS snapshot
			`;
			waiterPid.resolve(snapshot!.pid);
		}
		await lockOwnerStorageUsage(scope, tx);
		return reserveWithinQuota(tx, scope, `${scope.ownerId}:waiter`);
	};
	const waiter =
		waiterIsolation === "Serializable"
			? runSerializable(client, operation, { onAttempt: (event) => attempts.push(event) })
			: runReadCommitted(client, operation);
	void waiter.catch(() => waiterPid.resolve(-1));
	try {
		const pid = await waiterPid.promise;
		await waitForAdvisoryWait(pid);
		expect(holderCommitted).toBe(false);
		releaseHolder.resolve();
		const holderResult = await holderOutcome;
		if (options.rollback) expect(holderResult.error).toBe(rollback);
		else
			expect(holderResult).toEqual({ result: { accepted: true, observedBytes: 0n }, error: null });
		expect(await waiter).toEqual({
			accepted: Boolean(options.rollback),
			observedBytes: options.rollback ? 0n : 60n,
		});
		const shouldRetry = waiterIsolation === "Serializable" && !options.rollback;
		expect(entered).toBe(shouldRetry ? 2 : 1);
		if (shouldRetry)
			expect(attempts).toEqual([
				{ attempt: 1, outcome: "STARTED" },
				{ attempt: 1, outcome: "SERIALIZATION_CONFLICT" },
				{ attempt: 2, outcome: "STARTED" },
			]);
		expect(await client.storageUsageReservation.count({ where: scope })).toBe(1);
		expect(
			await client.mediaOwnerStorageFence.findUniqueOrThrow({
				where: { ownerType_ownerId: scope },
			}),
		).toMatchObject({ revision: options.rollback ? 1n : 2n });
	} finally {
		releaseHolder.resolve();
		await Promise.allSettled([holder, waiter]);
	}
}

describe("owner storage fence with real PostgreSQL isolation", () => {
	beforeAll(async () => {
		const connectionString = isolatedUrl();
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 8 }) });
		observer = new Pool({ connectionString, max: 1 });
		drizzlePool = new Pool({ connectionString, max: 1 });
		drizzleClient = drizzle(drizzlePool, { schema: drizzleSchema });
		await client.$connect();
	});

	afterAll(async () => {
		if (client) {
			await client.storageUsageReservation.deleteMany({
				where: { ownerId: { startsWith: prefix } },
			});
			// Fixture teardown only: production must not reset a live owner's fence.
			await client.mediaOwnerStorageFence.deleteMany({
				where: { ownerId: { startsWith: prefix } },
			});
			await client.$disconnect();
		}
		await observer?.end();
		await drizzlePool?.end();
	});

	it("retries an old Serializable snapshot after a ReadCommitted owner writer commits first", async () => {
		await raceQuotaWriters(true, "Serializable");
	});

	it("also retries when both writers first observe an owner with no committed fence row", async () => {
		await raceQuotaWriters(false, "Serializable");
	});

	it("reads the winner's quota in a fresh statement after a ReadCommitted owner lock wait", async () => {
		await raceQuotaWriters(false, "ReadCommitted");
	});

	it("reads the Serializable winner's quota when a ReadCommitted writer waits behind it", async () => {
		await raceQuotaWriters(false, "ReadCommitted", { holder: "Serializable" });
	});

	it("makes a Prisma Serializable waiter conflict with the alternate Drizzle writer", async () => {
		await raceQuotaWriters(false, "Serializable", { holder: "Drizzle" });
	});

	it.each([false, true])(
		"continues the waiting Serializable transaction after its holder rolls back (existing=%s)",
		async (existing) => {
			await raceQuotaWriters(existing, "Serializable", { rollback: true });
		},
	);

	it.each(["owner-id", "owner-type"] as const)(
		"allows different %s fences to commit while another owner still holds its fence",
		async (difference) => {
			const first = owner();
			const second =
				difference === "owner-id" ? owner() : { ...first, ownerType: "ORGANIZATION" as const };
			const held = deferred<void>();
			const release = deferred<void>();
			let firstCommitted = false;
			const holder = runReadCommitted(client, async (tx) => {
				await lockOwnerStorageUsage(first, tx);
				held.resolve();
				await release.promise;
			}).then(() => {
				firstCommitted = true;
			});
			void holder.catch(() => held.resolve());
			await held.promise;
			try {
				const other = await client.$transaction(
					async (tx) => {
						await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
						await lockOwnerStorageUsage(second, tx);
						return reserveWithinQuota(tx, second, `${second.ownerType}:${second.ownerId}:other`);
					},
					{ isolationLevel: "Serializable", timeout: 10_000 },
				);
				expect(other.accepted).toBe(true);
				expect(firstCommitted).toBe(false);
			} finally {
				release.resolve();
				await holder;
			}
		},
	);

	it.each([false, true])(
		"rolls back quota and %s preexisting fence changes together",
		async (existing) => {
			const scope = owner();
			if (existing)
				await client.mediaOwnerStorageFence.create({ data: { ...scope, revision: 7n } });
			const failure = new Error("fixture failure after quota reservation");
			await expect(
				runReadCommitted(client, async (tx) => {
					await lockOwnerStorageUsage(scope, tx);
					await reserveWithinQuota(tx, scope, `${scope.ownerId}:rollback`);
					throw failure;
				}),
			).rejects.toBe(failure);
			expect(await client.storageUsageReservation.count({ where: scope })).toBe(0);
			const afterRollback = await client.mediaOwnerStorageFence.findUnique({
				where: { ownerType_ownerId: scope },
			});
			if (existing) expect(afterRollback?.revision).toBe(7n);
			else expect(afterRollback).toBeNull();
			await runReadCommitted(client, async (tx) => {
				await lockOwnerStorageUsage(scope, tx);
				await reserveWithinQuota(tx, scope, `${scope.ownerId}:after-rollback`);
			});
			expect(
				await client.mediaOwnerStorageFence.findUniqueOrThrow({
					where: { ownerType_ownerId: scope },
				}),
			).toMatchObject({ revision: existing ? 8n : 1n });
		},
	);

	it("applies row-level security even when the optional deployment roles are absent", async () => {
		const state = await observer.query<{ relrowsecurity: boolean; public_access: boolean }>(`
			SELECT c.relrowsecurity,
				EXISTS (
					SELECT 1 FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
					WHERE acl.grantee = 0
				) AS public_access
			FROM pg_class c WHERE c.oid = 'public.media_owner_storage_fence'::regclass
		`);
		expect(state.rows).toEqual([{ relrowsecurity: true, public_access: false }]);
	});

	it("revokes API-role access while retaining backend writes when deployment roles exist", async () => {
		const connection = await observer.connect();
		const source = await readFile(
			new URL(
				"../../migrations/20261021191853_media_owner_storage_fence_private/migration.sql",
				import.meta.url,
			),
			"utf8",
		);
		// Replaying the migration body inside our own transaction lets us exercise
		// its existing-role branch without leaving cluster-wide fixture roles.
		const body = source
			.trim()
			.replace(/^BEGIN;/, "")
			.replace(/COMMIT;$/, "");
		try {
			await connection.query("BEGIN");
			await connection.query(`
				DO $fixture_roles$ DECLARE fixture_role TEXT; BEGIN
					FOREACH fixture_role IN ARRAY ARRAY['ezpic_app', 'anon', 'authenticated', 'service_role'] LOOP
						IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = fixture_role) THEN
							EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER', fixture_role);
						END IF;
					END LOOP;
				END $fixture_roles$;
				GRANT USAGE ON SCHEMA public TO ezpic_app, anon, authenticated, service_role;
				GRANT ALL ON TABLE public.media_owner_storage_fence TO PUBLIC, anon, authenticated, service_role;
				DROP POLICY IF EXISTS media_owner_storage_fence_app ON public.media_owner_storage_fence;
			`);
			const superusers = await connection.query(`
				SELECT rolname FROM pg_roles WHERE rolname IN ('ezpic_app', 'anon', 'authenticated', 'service_role')
				AND rolsuper
			`);
			expect(superusers.rows).toEqual([]);
			await connection.query(body);
			for (const role of ["anon", "authenticated", "service_role"]) {
				for (const statement of [
					"SELECT revision FROM public.media_owner_storage_fence LIMIT 1",
					"INSERT INTO public.media_owner_storage_fence (\"ownerType\", \"ownerId\", revision) VALUES ('USER', 'forbidden-api-fixture', 1)",
				]) {
					await connection.query("SAVEPOINT api_access");
					await connection.query(`SET LOCAL ROLE "${role}"`);
					await expect(connection.query(statement)).rejects.toMatchObject({ code: "42501" });
					await connection.query("ROLLBACK TO SAVEPOINT api_access");
				}
			}
			await connection.query("SET LOCAL ROLE ezpic_app");
			const scope = owner();
			for (let write = 0; write < 2; write += 1)
				await connection.query(
					`INSERT INTO public.media_owner_storage_fence ("ownerType", "ownerId", revision)
					 VALUES ($1::"OwnerType", $2, 1)
					 ON CONFLICT ("ownerType", "ownerId")
					 DO UPDATE SET revision = media_owner_storage_fence.revision + 1`,
					[scope.ownerType, scope.ownerId],
				);
			expect(
				(
					await connection.query(
						`SELECT revision FROM public.media_owner_storage_fence WHERE "ownerType" = $1::"OwnerType" AND "ownerId" = $2`,
						[scope.ownerType, scope.ownerId],
					)
				).rows,
			).toEqual([{ revision: "2" }]);
		} finally {
			await connection.query("ROLLBACK");
			connection.release();
		}
	});
});
import { readFile } from "node:fs/promises";
