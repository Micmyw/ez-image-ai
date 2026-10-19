import { randomUUID } from "node:crypto";

import { sqltag } from "@prisma/client/runtime/client";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// Only connection construction is stopped. SQL composition is the real installed
// Prisma runtime; the production claim predicate, locking and ACK run in PostgreSQL.
vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("UNEXPECTED_DEFAULT_DATABASE_CLIENT");
	},
}));
vi.mock("#prisma-runtime-client", async () => {
	const { sqltag, join, empty } = await import("@prisma/client/runtime/client");
	return { Prisma: { sql: sqltag, join, empty } };
});

import { claimOutboxBatch, completeOutboxEvent } from "./outbox";
import type { MediaTransactionClient } from "./types";

const schema = `provider_continuation_${randomUUID().replaceAll("-", "")}`;
let pool: Pool;
beforeAll(async () => {
	const raw = process.env.TEST_DATABASE_URL;
	if (!raw) throw new Error("TEST_DATABASE_URL_REQUIRED");
	const url = new URL(raw);
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("test"))
		throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
	pool = new Pool({ connectionString: raw, max: 4 });
	await pool.query(`CREATE SCHEMA "${schema}"`);
	await pool.query(`CREATE TABLE "${schema}".outbox_event (
  id text PRIMARY KEY, "eventType" text NOT NULL, "aggregateType" text NOT NULL,
  "aggregateId" text NOT NULL, "dedupeKey" text UNIQUE NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING', attempts integer NOT NULL DEFAULT 0,
  "availableAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
  "leaseOwner" text, "leaseToken" text, "leasedUntil" timestamptz, "processedAt" timestamptz
 )`);
});
afterAll(async () => {
	if (!pool) return;
	await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
	await pool.end();
});

// This exercises the database contract when an old Workflow ignores notBefore;
// it does not claim that a running, pinned old Workflow has gained a send fence.
it("keeps a future continuation pending through old immediate delivery, then recovers once when due", async () => {
	const now = new Date("2026-01-01T00:00:00Z");
	const due = new Date(now.getTime() + 5000);
	await pool.query(
		`INSERT INTO "${schema}".outbox_event (id,"eventType","aggregateType","aggregateId","dedupeKey",payload,"availableAt") VALUES ('due','GENERATION_DISPATCH','GENERATION_JOB','job','capacity-due','{"jobId":"job","version":1}',$1)`,
		[due],
	);
	const client = port();
	const claim = { limit: 100, leaseSeconds: 60, now };
	expect(
		await claimOutboxBatch({ ...claim, workerId: "old-flow", eventIds: ["due"] }, client),
	).toEqual([]);
	expect(await completeOutboxEvent("due", "old-flow", "old-token", client)).toEqual({ count: 0 });
	expect(
		(await pool.query(`SELECT status,attempts,"leaseToken" FROM "${schema}".outbox_event`)).rows,
	).toEqual([{ status: "PENDING", attempts: 0, leaseToken: null }]);
	const results = await Promise.all([
		claimOutboxBatch({ ...claim, now: due, workerId: "cron" }, client),
		claimOutboxBatch({ ...claim, now: due, workerId: "old-replay", eventIds: ["due"] }, client),
	]);
	const winner = results.flat();
	expect(winner).toHaveLength(1);
	const owner = results[0]!.length ? "cron" : "old-replay";
	expect(winner[0]).toMatchObject({ id: "due", attempts: 1 });
	expect(await completeOutboxEvent("due", "old-flow", "old-token", client)).toEqual({ count: 0 });
	expect(await completeOutboxEvent("due", owner, winner[0]!.leaseToken, client)).toEqual({
		count: 1,
	});
	expect(
		await claimOutboxBatch(
			{ ...claim, now: due, workerId: "response-lost-replay", eventIds: ["due"] },
			client,
		),
	).toEqual([]);
	expect((await pool.query(`SELECT status,attempts FROM "${schema}".outbox_event`)).rows).toEqual([
		{ status: "PROCESSED", attempts: 1 },
	]);
});

function port(): MediaTransactionClient {
	const connection = async <T>(operation: (client: PoolClient) => Promise<T>) => {
		const client = await pool.connect();
		try {
			await client.query(`SET search_path TO "${schema}"`);
			return await operation(client);
		} finally {
			client.release();
		}
	};
	return {
		$transaction: async <T>(
			operation: (tx: unknown) => Promise<T>,
			options: { isolationLevel: string },
		) =>
			connection(async (client) => {
				expect(options.isolationLevel).toBe("Serializable");
				await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
				try {
					const result = await operation({
						$queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
							const sql = sqltag(strings, ...values);
							return (await client.query(sql.text, sql.values)).rows;
						},
					});
					await client.query("COMMIT");
					return result;
				} catch (error) {
					await client.query("ROLLBACK");
					throw error;
				}
			}),
		outboxEvent: {
			updateMany: async ({
				where,
			}: {
				where: { id: string; status: string; leaseOwner: string; leaseToken: string };
			}) =>
				connection(async (client) => {
					const result = await client.query(
						`UPDATE outbox_event SET status='PROCESSED',"processedAt"=now(),"leaseOwner"=NULL,"leaseToken"=NULL,"leasedUntil"=NULL WHERE id=$1 AND status=$2 AND "leaseOwner"=$3 AND "leaseToken"=$4`,
						[where.id, where.status, where.leaseOwner, where.leaseToken],
					);
					return { count: result.rowCount };
				}),
		},
	} as unknown as MediaTransactionClient;
}
