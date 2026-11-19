import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
	recordAggregateTrafficWithQuery,
	readAggregateTraffic,
} from "../../shared/aggregate-traffic";
import { readConversionObservations } from "../../shared/conversion-funnel";
import { recordGrowthEventWithQuery, type GrowthEventInput } from "../../shared/growth-events";
import { createRuntimeDatabaseClient, runWithDatabaseClient } from "../client";
import { recordAggregateTraffic } from "./aggregate-traffic";
import { purgeExpiredAnalytics } from "./analytics-retention";
import { recordGrowthEvent } from "./growth-events";

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
let prisma: ReturnType<typeof createRuntimeDatabaseClient>;
let writerUrl: string;
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
			CREATE TABLE rate_limit_bucket (id text PRIMARY KEY, action text, "subjectHash" text, "windowStart" timestamptz, "windowEnd" timestamptz, count bigint, "updatedAt" timestamptz, UNIQUE(action,"subjectHash","windowStart"));
			CREATE INDEX ON rate_limit_bucket ("windowEnd");
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
		const scopedUrl = new URL(connectionString!);
		scopedUrl.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=5000`);
		writerUrl = scopedUrl.href;
		prisma = createRuntimeDatabaseClient(writerUrl);
	});
	afterEach(async () => {
		await client.query("TRUNCATE growth_event, traffic_aggregate, rate_limit_bucket");
	});
	afterAll(async () => {
		await prisma?.$disconnect();
		if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
		client?.release();
		await pool?.end();
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
			expect(await query("SELECT * FROM traffic_aggregate", [])).toHaveLength(2);
			const [rls] = await query<{ enabled: boolean }>(
				"SELECT relrowsecurity AS enabled FROM pg_class WHERE oid='traffic_aggregate'::regclass",
				[],
			);
			expect(rls?.enabled).toBe(true);
			await client.query(
				`UPDATE rate_limit_bucket SET count=11999 WHERE action='analytics:aggregate'`,
			);
			expect(await recordAggregateTrafficWithQuery(query, page)).toEqual({ accepted: true });
			expect(await recordAggregateTrafficWithQuery(query, page)).toEqual({ accepted: false });
			expect(await query("SELECT views FROM traffic_aggregate WHERE path='/create'", [])).toEqual([
				{ views: 4 },
			]);
		} finally {
			await client.query("ROLLBACK");
		}
	});
	it("persists once, throttles repeated ingestion and reads actual queries", async () => {
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
			expect(await query("SELECT id FROM growth_event WHERE id='old'", [])).toEqual([
				{ id: "old" },
			]);
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
			expect(await query("SELECT id FROM growth_event", [])).toEqual([{ id: "old" }]);
		} finally {
			await client.query("ROLLBACK");
		}
	});

	it("preserves atomic rate admission, counters and event deduplication through Prisma and Drizzle", async () => {
		vi.stubEnv("DATABASE_URL", writerUrl);
		const { db: drizzle } = await import("../../drizzle/client");
		try {
			const { recordAggregateTraffic: drizzleTraffic } =
				await import("../../drizzle/queries/aggregate-traffic");
			const { recordGrowthEvent: drizzleGrowth } =
				await import("../../drizzle/queries/growth-events");
			const page = { path: "/create", source: "chatgpt.com", device: "mobile" };
			const input = { ...event(), diagnostics: { uploadCount: 1, mode: "image", guest: false } };
			const results = await Promise.all([
				runWithDatabaseClient(prisma, () => recordAggregateTraffic(page)),
				drizzleTraffic(page),
				runWithDatabaseClient(prisma, () => recordGrowthEvent(input)),
				drizzleGrowth(input),
			]);
			expect(results).toEqual(Array.from({ length: 4 }, () => ({ accepted: true })));
			expect(await query("SELECT sum(views)::int AS views FROM traffic_aggregate", [])).toEqual([
				{ views: 2 },
			]);
			expect(await query("SELECT id, diagnostics FROM growth_event", [])).toEqual([
				{ id: input.id, diagnostics: input.diagnostics },
			]);

			await client.query(`ALTER TABLE traffic_aggregate ADD CHECK (path <> '/reject')`);
			const invalidAggregate = { ...page, path: "/reject" };
			const invalidEvent = { ...event(), userId: "missing-user" };
			await expect(
				runWithDatabaseClient(prisma, () => recordAggregateTraffic(invalidAggregate)),
			).rejects.toThrow();
			await expect(drizzleTraffic(invalidAggregate)).rejects.toThrow();
			await expect(
				runWithDatabaseClient(prisma, () => recordGrowthEvent(invalidEvent)),
			).rejects.toThrow();
			await expect(drizzleGrowth(invalidEvent)).rejects.toThrow();
			expect(
				await query(
					"SELECT action, sum(count)::int AS attempts FROM rate_limit_bucket GROUP BY action ORDER BY action",
					[],
				),
			).toEqual([
				{ action: "analytics:aggregate", attempts: 2 },
				{ action: "analytics:ingest", attempts: 2 },
			]);
		} finally {
			await drizzle.$client.end();
			vi.unstubAllEnvs();
		}
	});

	it("prunes oldest expired analytics in bounded batches during idle periods and revisits locked rows", async () => {
		await client.query(`
			INSERT INTO growth_event (id, "sessionHash", name, device, "createdAt")
			SELECT 'history-' || n, 'old', 'page_viewed', 'mobile', now() - interval '91 days' - n * interval '1 minute'
			FROM generate_series(1, 1002) AS n;
			INSERT INTO growth_event (id, "sessionHash", name, device, "createdAt")
			VALUES ('recent', 'new', 'page_viewed', 'mobile', now() - interval '89 days');
			INSERT INTO traffic_aggregate (hour, path, source, device, views)
			SELECT date_trunc('hour', now()) - interval '91 days' - n * interval '1 hour', '/', 'direct', 'desktop', 1
			FROM generate_series(1, 1002) AS n;
			INSERT INTO traffic_aggregate (hour, path, source, device, views)
			VALUES (date_trunc('hour', now()) - interval '89 days', '/', 'direct', 'desktop', 9);
			INSERT INTO rate_limit_bucket (id, action, "subjectHash", "windowStart", "windowEnd", count, "updatedAt")
			SELECT 'history-' || n, CASE WHEN n % 2 = 0 THEN 'analytics:aggregate' ELSE 'analytics:ingest' END,
				'old', now() - interval '2 days' - n * interval '1 minute',
				now() - interval '2 days' - (n - 1) * interval '1 minute', 1, now()
			FROM generate_series(1, 1002) AS n;
			INSERT INTO rate_limit_bucket (id, action, "subjectHash", "windowStart", "windowEnd", count, "updatedAt")
			VALUES ('recent', 'analytics:ingest', 'active', now() - interval '4 minutes', now() - interval '3 minutes', 1, now()),
				('unrelated', 'media:upload', 'old', now() - interval '10 days', now() - interval '10 days' + interval '1 minute', 1, now())`);

		await client.query("BEGIN");
		try {
			await client.query(`SELECT id FROM growth_event WHERE id = 'history-1002' FOR UPDATE`);
			expect(await runWithDatabaseClient(prisma, purgeExpiredAnalytics)).toEqual({
				growthEvents: 1000,
				trafficCounters: 1000,
				rateLimitBuckets: 1000,
			});
			expect(await query("SELECT id FROM growth_event ORDER BY id", [])).toEqual([
				{ id: "history-1" },
				{ id: "history-1002" },
				{ id: "recent" },
			]);
		} finally {
			await client.query("ROLLBACK");
		}
		expect(await runWithDatabaseClient(prisma, purgeExpiredAnalytics)).toEqual({
			growthEvents: 2,
			trafficCounters: 2,
			rateLimitBuckets: 2,
		});
		expect(await query("SELECT id FROM growth_event", [])).toEqual([{ id: "recent" }]);
		expect(await query("SELECT views FROM traffic_aggregate", [])).toEqual([{ views: 9 }]);
		expect(await query("SELECT id FROM rate_limit_bucket ORDER BY id", [])).toEqual([
			{ id: "recent" },
			{ id: "unrelated" },
		]);
	});
});
