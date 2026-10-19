import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("Unexpected implicit database connection");
	},
}));
vi.mock("./credits", () => ({
	releaseCreditsInTransaction: vi.fn(),
	reserveCreditsInTransaction: vi.fn(),
}));

import { expireGuestMediaTransaction } from "./guest-retention";

const schema = `guest_queue_${randomUUID().replaceAll("-", "")}`;
const now = new Date("2026-10-19T12:00:00Z");
let pool: Pool;
beforeAll(async () => {
	const raw = process.env.TEST_DATABASE_URL;
	if (!raw) throw new Error("TEST_DATABASE_URL_REQUIRED");
	const url = new URL(raw);
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("test"))
		throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
	pool = new Pool({ connectionString: raw });
	await pool.query(`CREATE SCHEMA "${schema}"`);
	await pool.query(
		`CREATE TABLE "${schema}".generation_job (id text PRIMARY KEY, "serviceClass" public."GenerationServiceClass", status public."GenerationJobStatus", "createdAt" timestamptz, "guestTrialId" text)`,
	);
	await pool.query(
		`CREATE TABLE "${schema}".guest_media_trial (id text PRIMARY KEY, "expiresAt" timestamptz, "sourceAssetId" text)`,
	);
	await pool.query(
		`CREATE TABLE "${schema}".media_asset (id text PRIMARY KEY, "deleteAfter" timestamptz, "deletedAt" timestamptz, status public."MediaAssetStatus")`,
	);
	await pool.query(
		`CREATE TABLE "${schema}".generation_attempt (id text PRIMARY KEY, "jobId" text)`,
	);
	for (const [id, ageMinutes, trialMinutes, fileMinutes] of [
		["waiting-valid", 30, 60, 60],
		["expired-trial", 30, -1, 60],
		["expired-file", 5, 60, -1],
		["unknown-fenced", 30, -1, -1],
	] as const) {
		await pool.query(
			`INSERT INTO "${schema}".generation_job VALUES ($1,'GUEST_SLOW','DISPATCH_QUEUED',$2,$1)`,
			[id, new Date(now.getTime() - ageMinutes * 60_000)],
		);
		await pool.query(`INSERT INTO "${schema}".guest_media_trial VALUES ($1,$2,$1)`, [
			id,
			new Date(now.getTime() + trialMinutes * 60_000),
		]);
		await pool.query(`INSERT INTO "${schema}".media_asset VALUES ($1,$2,NULL,'READY')`, [
			id,
			new Date(now.getTime() + fileMinutes * 60_000),
		]);
	}
	await pool.query(
		`INSERT INTO "${schema}".generation_attempt VALUES ('unknown-attempt','unknown-fenced')`,
	);
});
afterAll(async () => {
	if (pool) {
		await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
		await pool.end();
	}
});

describe("guest provider queue expiry", () => {
	it("selects real trial or file expiry, keeps a valid 30-minute wait, and excludes any send-fenced request", async () => {
		const client = await pool.connect();
		const selected: string[] = [];
		const noCleanup = { deleteMany: vi.fn(async () => ({ count: 0 })) };
		try {
			await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
			await client.query(`SET LOCAL search_path TO "${schema}", public`);
			const tx = {
				$queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
					const text = strings.reduce((sql, part, i) => sql + (i ? `$${i}` : "") + part, "");
					if (!text.includes('FROM "generation_job" job')) return [];
					const result = await client.query<{ id: string }>(text, values);
					selected.push(...result.rows.map((row) => row.id));
					return result.rows;
				},
				// Stop after exercising the real expiry selector. Settlement/cancellation
				// is covered by the existing full Prisma lifecycle integration suite.
				generationJob: { findUnique: vi.fn(async () => null) },
				guestResultAccessGrant: noCleanup,
				guestLinkIntent: noCleanup,
				guestSessionBootstrap: noCleanup,
				session: noCleanup,
				guestAbuseBucket: noCleanup,
				guestRiskBudgetBucket: noCleanup,
			};
			await expireGuestMediaTransaction({ now, limit: 10 }, {
				$transaction: async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx),
			} as never);
			expect(selected.sort()).toEqual(["expired-file", "expired-trial"]);
			await client.query("ROLLBACK");
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});
});
