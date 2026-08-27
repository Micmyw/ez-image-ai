import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const DRIZZLE_SCHEMA_DIRECTORY =
	process.env.ANONYMOUS_STANDARD_DRIZZLE_SCHEMA_DIRECTORY ??
	resolve(process.cwd(), "drizzle", "schema");

let client: Client;

describe("anonymous Standard trial persistent schema contract", () => {
	beforeAll(async () => {
		client = new Client({ connectionString: safeTestDatabaseUrl() });
		await client.connect();
	});

	afterAll(async () => {
		await client?.end();
	});

	it("preserves additive defaults and keeps trial eligibility separate from link state", async () => {
		const columns = await client.query<{
			columnName: string;
			columnDefault: string | null;
			isNullable: "YES" | "NO";
			tableName: string;
			udtName: string;
		}>(`
			SELECT
				table_name AS "tableName",
				column_name AS "columnName",
				column_default AS "columnDefault",
				is_nullable AS "isNullable",
				udt_name AS "udtName"
			FROM information_schema.columns
			WHERE table_schema = 'public'
			  AND (table_name, column_name) IN (
				('user', 'isAnonymous'),
				('generation_job', 'serviceClass'),
				('media_asset', 'retentionClass')
			  )
			ORDER BY table_name, column_name
		`);
		const byColumn = new Map(
			columns.rows.map((column) => [`${column.tableName}.${column.columnName}`, column]),
		);

		expect(byColumn.get("user.isAnonymous")).toMatchObject({
			columnDefault: "false",
			isNullable: "NO",
			udtName: "bool",
		});
		expect(byColumn.get("generation_job.serviceClass")).toMatchObject({
			columnDefault: `'STANDARD'::"GenerationServiceClass"`,
			isNullable: "NO",
			udtName: "GenerationServiceClass",
		});
		expect(byColumn.get("media_asset.retentionClass")).toMatchObject({
			columnDefault: `'ACCOUNT'::"MediaRetentionClass"`,
			isNullable: "NO",
			udtName: "MediaRetentionClass",
		});

		const enums = await client.query<{ enumLabel: string; typeName: string }>(`
			SELECT type.typname AS "typeName", enum.enumlabel AS "enumLabel"
			FROM pg_type type
			JOIN pg_enum enum ON enum.enumtypid = type.oid
			JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
			WHERE namespace.nspname = 'public'
			  AND type.typname IN ('GuestTrialEligibility', 'GuestLinkState')
			ORDER BY type.typname, enum.enumsortorder
		`);
		const labels = (typeName: string) =>
			enums.rows.filter((row) => row.typeName === typeName).map((row) => row.enumLabel);

		expect(labels("GuestTrialEligibility")).toEqual([
			"AVAILABLE",
			"IN_FLIGHT",
			"CONSUMED",
			"EXPIRED",
		]);
		expect(labels("GuestLinkState")).toEqual(["NONE", "LINKING", "LINKED"]);
	});

	it("persists bootstrap proof before binding the Better Auth anonymous owner", async () => {
		const columns = await client.query<{
			columnName: string;
			isNullable: "YES" | "NO";
		}>(`
			SELECT column_name AS "columnName", is_nullable AS "isNullable"
			FROM information_schema.columns
			WHERE table_schema = 'public'
			  AND (
				(table_name = 'guest_session_bootstrap' AND column_name = 'ownerId')
				OR (table_name = 'media_upload_session' AND column_name IN (
					'guestCapabilityVersion',
					'guestOriginHash',
					'guestExpectedSha256',
					'guestCompletionConsumedAt'
				))
			  )
		`);
		const byColumn = new Map(columns.rows.map((column) => [column.columnName, column] as const));

		expect(byColumn.get("ownerId")?.isNullable).toBe("YES");
		for (const column of [
			"guestCapabilityVersion",
			"guestOriginHash",
			"guestExpectedSha256",
			"guestCompletionConsumedAt",
		]) {
			expect(byColumn.get(column)?.isNullable).toBe("YES");
		}
	});

	it("retains the critical unique and foreign-key constraints", async () => {
		const uniqueIndexes = await client.query<{ indexName: string }>(`
			SELECT index_class.relname AS "indexName"
			FROM pg_index index
			JOIN pg_class index_class ON index_class.oid = index.indexrelid
			JOIN pg_class table_class ON table_class.oid = index.indrelid
			JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
			WHERE namespace.nspname = 'public'
			  AND index.indisunique
			  AND table_class.relname LIKE 'guest_%'
		`);
		expect(uniqueIndexes.rows.map(({ indexName }) => indexName)).toEqual(
			expect.arrayContaining([
				"guest_session_bootstrap_claimHash_key",
				"guest_session_bootstrap_idempotencyKey_key",
				"guest_session_bootstrap_ownerId_promotionPeriod_key",
				"guest_media_trial_currentJobId_key",
				"guest_media_trial_consumedJobId_key",
				"guest_media_trial_ownerId_promotionPeriod_key",
				"guest_link_intent_tokenHash_key",
				"guest_link_intent_idempotencyKey_key",
				"guest_result_access_grant_guestJobId_registeredUserId_key",
				"guest_abuse_bucket_scope_subjectHash_windowStart_key",
				"guest_risk_budget_bucket_promotionPeriod_subjectHash_key",
			]),
		);

		const foreignKeys = await client.query<{
			constraintName: string;
			referencedTable: string;
			tableName: string;
		}>(`
			SELECT
				constraint_row.conname AS "constraintName",
				table_row.relname AS "tableName",
				referenced_table.relname AS "referencedTable"
			FROM pg_constraint constraint_row
			JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
			JOIN pg_class referenced_table ON referenced_table.oid = constraint_row.confrelid
			JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
			WHERE namespace.nspname = 'public' AND constraint_row.contype = 'f'
		`);
		const byConstraint = new Map(foreignKeys.rows.map((row) => [row.constraintName, row] as const));

		expect(byConstraint.get("guest_session_bootstrap_ownerId_fkey")).toMatchObject({
			tableName: "guest_session_bootstrap",
			referencedTable: "user",
		});
		expect(byConstraint.get("guest_media_trial_ownerId_fkey")).toMatchObject({
			tableName: "guest_media_trial",
			referencedTable: "user",
		});
		expect(byConstraint.get("generation_job_guestTrialId_fkey")).toMatchObject({
			tableName: "generation_job",
			referencedTable: "guest_media_trial",
		});
		expect(byConstraint.get("guest_link_intent_trialId_fkey")).toMatchObject({
			tableName: "guest_link_intent",
			referencedTable: "guest_media_trial",
		});
		expect(byConstraint.get("guest_result_access_grant_guestJobId_fkey")).toMatchObject({
			tableName: "guest_result_access_grant",
			referencedTable: "generation_job",
		});
		expect(byConstraint.get("guest_result_access_grant_registeredUserId_fkey")).toMatchObject({
			tableName: "guest_result_access_grant",
			referencedTable: "user",
		});
	});

	it("retains the critical guest-domain checks", async () => {
		const checks = await client.query<{ constraintName: string; definition: string }>(`
			SELECT
				constraint_row.conname AS "constraintName",
				pg_get_constraintdef(constraint_row.oid) AS "definition"
			FROM pg_constraint constraint_row
			JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
			JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
			WHERE namespace.nspname = 'public'
			  AND constraint_row.contype = 'c'
			  AND table_row.relname LIKE 'guest_%'
		`);
		const byConstraint = new Map(
			checks.rows.map((row) => [row.constraintName, row.definition] as const),
		);

		expect(byConstraint.get("guest_session_bootstrap_expiry_check")).toContain(
			'"expiresAt" > "createdAt"',
		);
		expect(byConstraint.get("guest_media_trial_sponsor_credits_check")).toContain(
			'"sponsorCredits" = 4',
		);
		expect(byConstraint.get("guest_media_trial_job_separation_check")).toContain(
			'"currentJobId" <> "consumedJobId"',
		);
		expect(byConstraint.get("guest_abuse_bucket_counts_check")).toContain('"requestCount" >= 0');
		expect(byConstraint.get("guest_risk_budget_limit_check")).toMatch(
			/\("reservedMicros" \+ "consumedMicros"\) <= "hardLimitMicros"/,
		);
	});

	it.each([
		["postgres.ts", /boolean\("isAnonymous"\)\.default\(false\)\.notNull\(\)/],
		["mysql.ts", /boolean\("isAnonymous"\)\.default\(false\)\.notNull\(\)/],
		["sqlite.ts", /integer\("isAnonymous", \{ mode: "boolean" \}\)\.default\(false\)\.notNull\(\)/],
	] as const)(
		"mirrors only User.isAnonymous in the %s Drizzle auth schema",
		async (file, field) => {
			const source = await readFile(resolve(DRIZZLE_SCHEMA_DIRECTORY, file), "utf8");
			const userTable = /export const user =[\s\S]*?\n\}\);/.exec(source)?.[0];

			expect(userTable, `${file} must export the Better Auth user table`).toBeDefined();
			expect(userTable).toMatch(field);
			expect(source.match(/\bisAnonymous\b/g)).toHaveLength(2);
			expect(source).not.toMatch(
				/guest(SessionBootstrap|MediaTrial|LinkIntent|ResultAccessGrant|AbuseBucket|RiskBudgetBucket)/i,
			);
		},
	);
});

function safeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) {
		throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	}
	if (DATABASE_URL && TEST_DATABASE_URL === DATABASE_URL) {
		throw new Error("UNSAFE_TEST_DATABASE: TEST_DATABASE_URL must not equal DATABASE_URL");
	}
	const parsed = new URL(TEST_DATABASE_URL);
	const databaseName = parsed.pathname.slice(1).toLowerCase();
	if (
		!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(databaseName)
	) {
		throw new Error("UNSAFE_TEST_DATABASE: expected a disposable loopback test database");
	}
	return TEST_DATABASE_URL;
}
