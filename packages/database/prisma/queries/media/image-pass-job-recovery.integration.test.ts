import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({}));
import { createDatabaseFinalizingGenerationRecoveryStore } from "../../../../jobs/src/handlers/finalization-recovery-store";

// This validates the production recovery SQL only; generated ORM mappings and
// complete cancellation callers remain covered by the full lifecycle suite.
const schema = `pass_recovery_${randomUUID().replaceAll("-", "")}`;
let pool: Pool;
const now = new Date("2026-10-19T12:00:00Z");
beforeAll(async () => {
	const raw = process.env.TEST_DATABASE_URL;
	if (!raw) throw new Error("TEST_DATABASE_URL_REQUIRED");
	const url = new URL(raw);
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("test"))
		throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
	pool = new Pool({ connectionString: raw });
	await pool.query(`CREATE SCHEMA "${schema}"`);
	await pool.query(
		`CREATE TABLE "${schema}".generation_job (id text PRIMARY KEY, "executionEngine" text, "fundingSource" text, status text, "nextFinalizeAt" timestamptz, "updatedAt" timestamptz, "finalizationRetryCount" integer DEFAULT 0, "finalizationErrorCode" text)`,
	);
	await pool.query(
		`CREATE TABLE "${schema}".credit_reservation ("jobId" text PRIMARY KEY, status text)`,
	);
	await pool.query(
		`CREATE TABLE "${schema}".image_pass_reservation ("jobId" text PRIMARY KEY, status text)`,
	);
	for (const [id, fundingSource, status, credit, pass, executionEngine] of [
		["pass-active", "IMAGE_PASS", "CANCELED", null, "ACTIVE", "legacy"],
		["pass-released", "IMAGE_PASS", "CANCELED", null, "RELEASED", "legacy"],
		["pass-settled", "IMAGE_PASS", "CANCELED", null, "SETTLED", "legacy"],
		["credit-active", "CREDITS", "CANCELED", "ACTIVE", null, "legacy"],
		["credit-released", "CREDITS", "CANCELED", "RELEASED", null, "legacy"],
		["wrong-credit-binding", "IMAGE_PASS", "CANCELED", "ACTIVE", "RELEASED", "legacy"],
		["wrong-pass-binding", "CREDITS", "CANCELED", "RELEASED", "ACTIVE", "legacy"],
		["pass-native", "IMAGE_PASS", "CANCELED", null, "ACTIVE", "video-workflow-v1"],
		["pass-finalizing", "IMAGE_PASS", "FINALIZING", null, "ACTIVE", "legacy"],
	] as const) {
		await pool.query(
			`INSERT INTO "${schema}".generation_job (id,"executionEngine","fundingSource",status,"updatedAt") VALUES ($1,$2,$3,$4,$5)`,
			[id, executionEngine, fundingSource, status, new Date(0)],
		);
		if (credit)
			await pool.query(`INSERT INTO "${schema}".credit_reservation VALUES ($1,$2)`, [id, credit]);
		if (pass)
			await pool.query(`INSERT INTO "${schema}".image_pass_reservation VALUES ($1,$2)`, [id, pass]);
	}
});
afterAll(async () => {
	if (!pool) return;
	await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
	await pool.end();
});

describe("independent pass settlement recovery SQL", () => {
	it("recovers canceled active pass holds without admitting released, settled, foreign-funding or native records", async () => {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(`SET LOCAL search_path TO "${schema}", public`);
			const database = {
				$queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
					const text = strings.reduce((sql, part, i) => sql + (i ? `$${i}` : "") + part, "");
					return (await client.query(text, values)).rows;
				},
			};
			const found = await createDatabaseFinalizingGenerationRecoveryStore(
				database as never,
			).listCandidates({ limit: 20, now, staleBefore: now });
			expect(found.map(({ jobId }) => jobId).sort()).toEqual([
				"credit-active",
				"pass-active",
				"pass-finalizing",
			]);
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});
});
