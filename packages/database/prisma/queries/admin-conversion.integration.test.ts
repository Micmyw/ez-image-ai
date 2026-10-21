import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	recordAggregateTrafficWithQuery,
	readAggregateTraffic,
} from "../../shared/aggregate-traffic";
import { readConversionObservations } from "../../shared/conversion-funnel";
import { recordGrowthEventWithQuery, type GrowthEventInput } from "../../shared/growth-events";

const connectionString =
	process.env.ADMIN_ANALYTICS_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const target = connectionString ? new URL(connectionString) : null;
const enabled =
	target?.hostname === "127.0.0.1" &&
	["55432", "55439", "55441", "55442"].includes(target.port) &&
	/^\/(?:ezpic|admin|ai_media)_[a-z0-9_]*test$/.test(target.pathname);
if (connectionString && !enabled) throw new Error("ISOLATED_CONVERSION_DATABASE_REQUIRED");
const pool = enabled ? new Pool({ connectionString, max: 1 }) : null;
let client: PoolClient;
const schema = `conversion_${randomUUID().replaceAll("-", "")}`;
let created = false;
const query = async <T>(statement: string, parameters: readonly unknown[]): Promise<T[]> =>
	(await client.query(statement, [...parameters])).rows;
const event = (id = randomUUID()): GrowthEventInput => ({
	id,
	sessionHash: "sha256:" + "a".repeat(64),
	userId: "customer",
	internal: false,
	name: "purchase_clicked",
	path: "/pricing",
	source: "chatgpt.com",
	medium: "ai-assistant",
	campaign: null,
	device: "mobile",
	productKind: "PLAN",
	errorCategory: null,
});

describe.skipIf(!enabled)("conversion migration and SQL in isolated PostgreSQL", () => {
	beforeAll(async () => {
		client = await pool!.connect();
		await client.query(`CREATE SCHEMA "${schema}"`);
		created = true;
		await client.query(`SET search_path TO "${schema}"`);
		await client.query(`CREATE TABLE "user" (id text PRIMARY KEY);
			INSERT INTO "user" VALUES ('customer');
			CREATE TABLE rate_limit_bucket (id text, action text, "subjectHash" text, "windowStart" timestamptz, "windowEnd" timestamptz, count int, "updatedAt" timestamptz, UNIQUE(action,"subjectHash","windowStart"));
			CREATE TABLE generation_job (id text, "submittedByUserId" text, "createdAt" timestamptz, "terminalAt" timestamptz, status text, "failureCode" text);
			CREATE TABLE generation_job_asset ("jobId" text, "assetId" text, "assetChecksum" text, role text);
			CREATE TABLE asset_moderation_result (id text, "assetId" text, "assetChecksum" text, status text, "createdAt" timestamptz);`);
		await client.query(
			await readFile(
				new URL("../migrations/20261021100000_growth_event_funnel/migration.sql", import.meta.url),
				"utf8",
			),
		);
		await client.query(
			await readFile(
				new URL(
					"../migrations/20261021120000_anonymous_traffic_diagnostics/migration.sql",
					import.meta.url,
				),
				"utf8",
			),
		);
	});
	it("increments anonymous hourly buckets without creating individual visitor records", async () => {
		await client.query("BEGIN");
		try {
			const page = { path: "/create", source: "chatgpt.com", device: "mobile" };
			await recordAggregateTrafficWithQuery(query, page);
			await recordAggregateTrafficWithQuery(query, page);
			const report = await readAggregateTraffic(query, { range: "24h" });
			expect(report.views).toBe(2);
			expect(report.sources).toEqual([{ source: "chatgpt.com", views: 2 }]);
			expect(await query("SELECT * FROM traffic_aggregate", [])).toHaveLength(1);
			expect((await readAggregateTraffic(query, { range: "24h", device: "desktop" })).views).toBe(
				0,
			);
			// A detailed source filter cannot select a finer origin from anonymous categories.
			expect(
				await readAggregateTraffic(query, {
					range: "24h",
					source: "www.google.com",
					device: "mobile",
				}),
			).toEqual(report);
			await client.query(
				`INSERT INTO traffic_aggregate VALUES (now()-interval '91 days','/','direct','desktop',9)`,
			);
			await recordAggregateTrafficWithQuery(query, page);
			expect(await query("SELECT * FROM traffic_aggregate", [])).toHaveLength(1);
			const [rls] = await query<{ enabled: boolean }>(
				"SELECT relrowsecurity AS enabled FROM pg_class WHERE oid='traffic_aggregate'::regclass",
				[],
			);
			expect(rls?.enabled).toBe(true);
			await client.query(
				`UPDATE rate_limit_bucket SET count=12000 WHERE action='analytics:aggregate'`,
			);
			expect(await recordAggregateTrafficWithQuery(query, page)).toEqual({ accepted: false });
		} finally {
			await client.query("ROLLBACK");
		}
	});
	afterAll(async () => {
		if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
		client?.release();
		await pool?.end();
	});
	it("persists once, throttles repeated ingestion, purges expired observations and reads actual queries", async () => {
		expect(
			(
				await query<{ enabled: boolean }>(
					`SELECT relrowsecurity AS enabled FROM pg_class WHERE oid='growth_event'::regclass`,
					[],
				)
			)[0]?.enabled,
		).toBe(true);
		const input = event();
		await client.query("BEGIN");
		try {
			await recordGrowthEventWithQuery(query, input);
			await recordGrowthEventWithQuery(query, input);
			expect(
				(await query<{ count: number }>("SELECT count(*)::int AS count FROM growth_event", []))[0]
					?.count,
			).toBe(1);
			await client.query(
				`INSERT INTO growth_event (id,"sessionHash",name,device,"createdAt") VALUES ('old','old','page_viewed','mobile',now()-interval '91 days')`,
			);
			await recordGrowthEventWithQuery(query, event());
			expect(await query("SELECT id FROM growth_event WHERE id='old'", [])).toHaveLength(0);
			await client.query("UPDATE rate_limit_bucket SET count=90");
			expect(await recordGrowthEventWithQuery(query, event())).toEqual({ accepted: false });
			const observations = await readConversionObservations(query, {
				range: "7d",
				now: new Date(Date.now() + 1000),
			});
			expect(observations.events).toHaveLength(2);
			expect(observations.events[0]).toMatchObject({ source: "chatgpt.com", device: "mobile" });
			await client.query(`INSERT INTO generation_job VALUES ('j','customer',now()-interval '1 hour',now(),'FAILED','NO_USABLE_OUTPUT');
				INSERT INTO generation_job_asset VALUES ('j','asset','checksum','INPUT');
				INSERT INTO asset_moderation_result VALUES ('reject','asset','checksum','REJECTED',now()-interval '30 minutes'), ('approve','asset','checksum','APPROVED',now()-interval '20 minutes');`);
			const reviewed = await readConversionObservations(query, {
				range: "7d",
				now: new Date(Date.now() + 1000),
			});
			expect(reviewed.jobs[0]?.inputRejected).toBe(false);
			await client.query(`DELETE FROM "user" WHERE id='customer'`);
			expect(await query("SELECT id FROM growth_event", [])).toHaveLength(0);
		} finally {
			await client.query("ROLLBACK");
		}
	});
});
