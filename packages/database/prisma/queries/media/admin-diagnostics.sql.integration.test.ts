import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSafeDatabaseUrl } from "../../../../../tests/load/assert-safe-target";
import { createRuntimeDatabaseClient, db, runWithDatabaseClient } from "../../client";
import { getAdminGuestDiagnostics } from "./admin-diagnostics";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("guest diagnostics PostgreSQL aggregates", () => {
	let database: pg.Client;
	beforeAll(async () => {
		assertSafeDatabaseUrl(databaseUrl);
		database = new pg.Client({
			connectionString: databaseUrl,
			types: { getTypeParser: (oid) => (oid === 20 ? BigInt : pg.types.getTypeParser(oid)) },
		});
		await database.connect();
		// Temporary tables shadow production names and disappear with this connection.
		await database.query(`
			CREATE TEMP TABLE guest_abuse_bucket (scope text, "rejectionCount" bigint);
			CREATE TYPE pg_temp."GuestRiskState" AS ENUM ('HELD','COMMITTED','RELEASED');
			CREATE TYPE pg_temp."GenerationServiceClass" AS ENUM ('GUEST_SLOW');
			CREATE TYPE pg_temp."MediaRetentionClass" AS ENUM ('GUEST_TRIAL');
			CREATE TYPE pg_temp."CreditLedgerEntryType" AS ENUM ('GRANT');
			CREATE TEMP TABLE guest_media_trial (id text, "promotionPeriod" text, "frozenQuotedRiskMicros" bigint, "riskState" "GuestRiskState");
			CREATE TEMP TABLE generation_job (id text, "guestTrialId" text, "serviceClass" "GenerationServiceClass", status text, "createdAt" timestamptz, "failureCode" text);
			CREATE TEMP TABLE generation_attempt ("jobId" text, status text, "createdAt" timestamptz, "uncertainSubmission" boolean, "providerCostMicros" bigint);
			CREATE TEMP TABLE media_asset (id text, kind text, status text, "watermarkVersion" text, "watermarkedAt" timestamptz, "cleanStagingDeletedAt" timestamptz, "deleteAfter" timestamptz, "deletedAt" timestamptz, "retentionClass" "MediaRetentionClass");
			CREATE TEMP TABLE generation_job_asset ("assetId" text, "jobId" text);
			CREATE TEMP TABLE asset_moderation_result (id text, "assetId" text, status text, "verificationGeneration" int, "attemptNumber" int, "createdAt" timestamptz);
			CREATE TEMP TABLE credit_ledger_entry (amount bigint, "referenceKey" text, type "CreditLedgerEntryType");
			CREATE TEMP TABLE credit_reservation ("jobId" text, amount bigint, "settledAmount" bigint, "releasedAmount" bigint);
			CREATE TEMP TABLE guest_result_access_grant ("trialId" text, "consumedAt" timestamptz, "expiresAt" timestamptz);
			CREATE TEMP TABLE outbox_event ("aggregateId" text, status text, "eventType" text);
			INSERT INTO guest_media_trial VALUES ('trial','current',100,'HELD');
			INSERT INTO generation_job VALUES
			 ('valid','trial','GUEST_SLOW','RUNNING','2026-11-05 00:00:00Z',NULL),
			 ('invalid','trial','GUEST_SLOW','RUNNING','2026-11-05 00:00:00Z',NULL),
			 ('waiting','trial','GUEST_SLOW','RESERVED','2026-11-05 00:00:00Z',NULL);
			INSERT INTO generation_attempt VALUES
			 ('valid','RUNNING','2026-11-05 00:00:02Z',false,NULL),
			 ('valid','RUNNING','2026-11-05 00:00:09Z',false,NULL),
			 ('invalid','RUNNING','2026-11-04 23:59:59Z',false,NULL);
		`);
	});
	afterAll(async () => {
		await database?.end();
	});

	async function read(period: string) {
		const client = {
			$queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
				const sql = parts.reduce(
					(text, part, index) => text + (index ? `$${index}` : "") + part,
					"",
				);
				return (await database.query(sql, values)).rows;
			},
			runtimeConfigOverride: { findFirst: async () => null },
		};
		return getAdminGuestDiagnostics(client as never, new Date("2026-11-05T00:01:00Z"), {
			guestPromotionPeriod: period,
			guestRiskBudgetMicros: null,
		});
	}
	it("uses one first-attempt sample per job, excludes negatives, and retains waiting jobs", async () => {
		const result = await read("current");
		expect(result.queue.waitMs).toEqual({
			p50: 2_000,
			p95: 2_000,
			sampleCount: 1,
			invalidSampleCount: 1,
		});
		expect(result.queue.depth).toBe(1);
		expect(result.queue.oldestAgeSeconds).toBe(60);
	});
	it("returns null percentiles when a promotion has no samples", async () => {
		expect((await read("empty")).queue.waitMs).toEqual({
			p50: null,
			p95: null,
			sampleCount: 0,
			invalidSampleCount: 0,
		});
	});
	it.each([1, 2] as const)(
		"honors a request-owned pool of %s real connections",
		async (maxConnections) => {
			const client = createRuntimeDatabaseClient(databaseUrl!, undefined, { maxConnections });
			try {
				const results = await runWithDatabaseClient(client, () =>
					Promise.all(
						Array.from(
							{ length: 4 },
							() =>
								db.$queryRaw<
									Array<{ pid: number }>
								>`SELECT pg_backend_pid() AS pid FROM pg_sleep(0.1)`,
						),
					),
				);
				expect(new Set(results.map((rows) => rows[0]!.pid)).size).toBe(maxConnections);
			} finally {
				await client.$disconnect();
			}
		},
	);
});
