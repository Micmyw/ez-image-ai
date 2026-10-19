import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type { Prisma } from "../prisma/generated/client";
import type { MediaTransactionClient } from "../prisma/queries/media/types";

type Row = Record<string, any>;
const bigintColumns = new Set([
	"byteSize",
	"bytes",
	"paidAmount",
	"refundedAmount",
	"spendableCredits",
	"reservedCredits",
]);
const normalize = (row: Row): Row =>
	Object.fromEntries(
		Object.entries(row).map(([key, value]) => [
			key,
			bigintColumns.has(key) && typeof value === "string" ? BigInt(value) : value,
		]),
	);

/** Bounded SQL row adapter, not a PrismaClient substitute. The production copy,
 * entitlement, effective-subscription, quota and approval helpers all execute.
 * Only the subscription/billing-period and storage-reservation ORM transport is
 * translated here. Minimal tables document precisely the SQL surface exercised;
 * generated ORM mapping, migrations, draft-claim orchestration and storage I/O
 * remain separate integration gates. Every table belongs to this random schema.
 */
export class AccountInputCopyPostgresPort {
	readonly schema = `account_copy_${randomUUID().replaceAll("-", "")}`;
	private pool!: Pool;

	table(name: string) {
		if (!/^[a-z_]+$/.test(name)) throw new Error("INVALID_TEST_TABLE");
		return `"${this.schema}"."${name}"`;
	}

	async initialize() {
		const raw = process.env.TEST_DATABASE_URL;
		if (!raw) throw new Error("TEST_DATABASE_URL_REQUIRED");
		const url = new URL(raw);
		if (
			!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
			!url.pathname.includes("test")
		)
			throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
		this.pool = new Pool({
			connectionString: raw,
			max: 16,
			application_name: this.schema,
			options: `-c search_path=${this.schema}`,
		});
		await this.pool.query(`CREATE SCHEMA "${this.schema}"`);
		await this.pool.query(`
			CREATE TABLE ${this.table("user")} (id text PRIMARY KEY, "isAnonymous" boolean);
			CREATE TABLE ${this.table("media_asset")} (
				id text PRIMARY KEY, "ownerType" text NOT NULL, "ownerId" text NOT NULL,
				kind text NOT NULL, status text NOT NULL, "retentionClass" text NOT NULL,
				"objectKey" text NOT NULL UNIQUE, "mimeType" text NOT NULL, "byteSize" bigint NOT NULL,
				checksum text, "deletedAt" timestamptz, "deleteAfter" timestamptz,
				"storageEtag" text, "storageVersionId" text, "finalizedAt" timestamptz,
				"verificationGeneration" integer NOT NULL DEFAULT 0,
				"verificationAttemptCount" integer NOT NULL DEFAULT 0,
				"verificationEngine" text NOT NULL DEFAULT 'legacy', "verificationProvider" text,
				"verificationProviderTaskId" text, "verificationRuleVersion" text,
				"verificationPolicyVersion" text, "verificationValidUntil" timestamptz,
				"verificationLeaseToken" text, "verificationLeasedUntil" timestamptz,
				"verificationNextAttemptAt" timestamptz, "verificationDeadlineAt" timestamptz,
				"updatedAt" timestamptz NOT NULL DEFAULT now()
			);
			CREATE TABLE ${this.table("asset_moderation_result")} (
				id text PRIMARY KEY, "assetId" text NOT NULL, status text NOT NULL,
				"reasonCode" text NOT NULL, "assetChecksum" text NOT NULL,
				"verificationGeneration" integer NOT NULL, "attemptNumber" integer NOT NULL,
				"evidenceKind" text NOT NULL, provider text NOT NULL, "providerTaskId" text NOT NULL,
				"ruleVersion" text NOT NULL, "policyVersion" text NOT NULL, "validUntil" timestamptz,
				"createdAt" timestamptz NOT NULL DEFAULT now()
			);
			CREATE TABLE ${this.table("generation_draft")} (
				id text PRIMARY KEY, "ownerId" text NOT NULL, "submittedByUserId" text NOT NULL,
				"assetId" text NOT NULL, "productKey" text NOT NULL, status text NOT NULL,
				"expiresAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL DEFAULT now()
			);
			CREATE TABLE ${this.table("guest_media_trial")} ("sourceDraftId" text, "sourceAssetId" text);
			CREATE TABLE ${this.table("generation_job_asset")} ("jobId" text, "assetId" text);
			CREATE TABLE ${this.table("outbox_event")} (
				id text PRIMARY KEY, "eventType" text NOT NULL, "aggregateType" text NOT NULL,
				"aggregateId" text NOT NULL, "dedupeKey" text NOT NULL UNIQUE, payload jsonb NOT NULL,
				status text NOT NULL DEFAULT 'PENDING', "processedAt" timestamptz,
				"availableAt" timestamptz NOT NULL DEFAULT now(),
				"createdAt" timestamptz NOT NULL DEFAULT now()
			);
			CREATE TABLE ${this.table("storage_usage_reservation")} (
				id text PRIMARY KEY, "ownerType" text NOT NULL, "ownerId" text NOT NULL,
				bytes bigint NOT NULL, "referenceKey" text NOT NULL UNIQUE,
				status text NOT NULL DEFAULT 'ACTIVE', "expiresAt" timestamptz, "releasedAt" timestamptz
			);
			CREATE TABLE ${this.table("plan")} (id text PRIMARY KEY, name text, metadata jsonb, "productKind" text);
			CREATE TABLE ${this.table("subscription")} (
				id text PRIMARY KEY, "planId" text NOT NULL, provider text NOT NULL,
				"ownerType" text NOT NULL, "ownerId" text NOT NULL, status text NOT NULL,
				"refundTerminationRequestedAt" timestamptz, "currentPeriodStart" timestamptz,
				"currentPeriodEnd" timestamptz, "graceEndsAt" timestamptz, "updatedAt" timestamptz DEFAULT now()
			);
			CREATE TABLE ${this.table("billing_period")} (
				id text PRIMARY KEY, "subscriptionId" text NOT NULL, "startsAt" timestamptz NOT NULL,
				"endsAt" timestamptz NOT NULL, "paidAmount" bigint NOT NULL,
				"refundedAmount" bigint NOT NULL DEFAULT 0, status text NOT NULL,
				"providerInvoiceId" text
			);
			CREATE TABLE ${this.table("credit_account")} (
				id text PRIMARY KEY, "spendableCredits" bigint NOT NULL, "reservedCredits" bigint NOT NULL
			);
			CREATE TABLE ${this.table("credit_ledger_entry")} (id text PRIMARY KEY, amount bigint NOT NULL);
			CREATE TABLE ${this.table("credit_reservation")} (id text PRIMARY KEY, amount bigint NOT NULL);
			CREATE TABLE ${this.table("generation_job")} (id text PRIMARY KEY);
		`);
	}

	async reset() {
		const names = [
			"user",
			"media_asset",
			"asset_moderation_result",
			"generation_draft",
			"guest_media_trial",
			"generation_job_asset",
			"outbox_event",
			"storage_usage_reservation",
			"plan",
			"subscription",
			"billing_period",
			"credit_account",
			"credit_ledger_entry",
			"credit_reservation",
			"generation_job",
		];
		await this.pool.query(`TRUNCATE ${names.map((name) => this.table(name)).join(",")}`);
	}
	async close() {
		if (!this.pool) return;
		try {
			await this.pool.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`);
		} finally {
			await this.pool.end();
		}
	}
	async rows<T extends Row = Row>(text: string, values: unknown[] = []): Promise<T[]> {
		return (await this.pool.query(text, values)).rows.map(normalize) as T[];
	}
	async transaction<T>(
		operation: (tx: Prisma.TransactionClient, connection: PoolClient) => Promise<T>,
	): Promise<T> {
		const connection = await this.pool.connect();
		try {
			await connection.query("BEGIN ISOLATION LEVEL READ COMMITTED");
			await connection.query("SET LOCAL statement_timeout='10s'");
			const result = await operation(
				this.port(connection) as unknown as Prisma.TransactionClient,
				connection,
			);
			await connection.query("COMMIT");
			return result;
		} catch (error) {
			await connection.query("ROLLBACK");
			throw error;
		} finally {
			connection.release();
		}
	}
	client(): MediaTransactionClient {
		return {
			...this.port(this.pool),
			$transaction: <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) =>
				this.transaction(operation),
		} as unknown as MediaTransactionClient;
	}

	private port(connection: Pick<PoolClient, "query">) {
		const query = async (text: string, values: unknown[] = []) =>
			(await connection.query(text, values)).rows.map(normalize);
		// Generic predicate translation preserves the production ORM where tree,
		// including billingPeriod.fields.paidAmount and relation SOME semantics.
		const predicate = (where: Row, values: unknown[], alias: string): string => {
			const bind = (value: unknown) => {
				values.push(value);
				return `$${values.length}`;
			};
			return (
				Object.entries(where)
					.map(([key, value]) => {
						if (key === "OR" || key === "AND")
							return `(${(value as Row[]).map((part) => predicate(part, values, alias)).join(` ${key} `)})`;
						if (key === "NOT") return `NOT (${predicate(value, values, alias)})`;
						if (key === "periods")
							return `EXISTS (SELECT 1 FROM ${this.table("billing_period")} bp WHERE bp."subscriptionId"=${alias}.id AND ${predicate(value.some, values, "bp")})`;
						if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key))
							throw new Error(`UNSUPPORTED_TEST_COLUMN:${key}`);
						const column = `${alias}."${key}"`;
						if (value === null) return `${column} IS NULL`;
						if (typeof value !== "object" || value instanceof Date)
							return `${column}=${bind(value)}`;
						return Object.entries(value)
							.map(([op, operand]) => {
								if (op === "in") return `${column}=ANY(${bind(operand)}::text[])`;
								if (op === "startsWith") return `${column} LIKE ${bind(`${String(operand)}%`)}`;
								const operator = ({ gt: ">", gte: ">=", lt: "<", lte: "<=", not: "<>" } as Row)[op];
								if (!operator) throw new Error(`UNSUPPORTED_TEST_PREDICATE:${op}`);
								const rhs = operand === paidAmountField ? `${alias}."paidAmount"` : bind(operand);
								return `${column}${operator}${rhs}`;
							})
							.join(" AND ");
					})
					.join(" AND ") || "TRUE"
			);
		};
		const paidAmountField = Object.freeze({ column: "paidAmount" });
		const tag = (strings: TemplateStringsArray, values: unknown[]) => ({
			text: strings.reduce((sql, part, i) => sql + (i ? `$${i}` : "") + part, ""),
			values,
		});
		return {
			$queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
				const statement = tag(strings, values);
				return query(statement.text, statement.values);
			},
			$executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
				const statement = tag(strings, values);
				return (await connection.query(statement.text, statement.values)).rowCount ?? 0;
			},
			storageUsageReservation: {
				aggregate: async ({ where }: { where: Row }) => {
					const values: unknown[] = [];
					const [row] = await query(
						`SELECT sum(bytes)::text AS bytes FROM ${this.table("storage_usage_reservation")} r WHERE ${predicate(where, values, "r")}`,
						values,
					);
					return { _sum: { bytes: row?.bytes ?? null } };
				},
				create: async ({ data }: { data: Row }) => {
					const entries = Object.entries({ id: randomUUID(), ...data });
					return (
						await query(
							`INSERT INTO ${this.table("storage_usage_reservation")} (${entries.map(([key]) => `"${key}"`).join(",")}) VALUES (${entries.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
							entries.map(([, value]) => value),
						)
					)[0];
				},
				updateMany: async ({ where, data }: { where: Row; data: Row }) => {
					const values: unknown[] = Object.values(data);
					const sql = `UPDATE ${this.table("storage_usage_reservation")} r SET ${Object.keys(data)
						.map((key, i) => `"${key}"=$${i + 1}`)
						.join(",")} WHERE ${predicate(where, values, "r")}`;
					return { count: (await connection.query(sql, values)).rowCount ?? 0 };
				},
			},
			subscription: {
				findMany: async ({ where, select }: { where: Row; select: Row }) => {
					const values: unknown[] = [];
					const rows = await query(
						`SELECT s.*, to_jsonb(p) AS plan FROM ${this.table("subscription")} s JOIN ${this.table("plan")} p ON p.id=s."planId" WHERE ${predicate(where, values, "s")} ORDER BY s."updatedAt" DESC,s.id DESC`,
						values,
					);
					for (const row of rows) {
						const periodValues: unknown[] = [row.id];
						row.periods = await query(
							`SELECT * FROM ${this.table("billing_period")} bp WHERE bp."subscriptionId"=$1 AND ${predicate(select.periods.where, periodValues, "bp")} ORDER BY bp."startsAt" DESC LIMIT 1`,
							periodValues,
						);
					}
					return rows;
				},
			},
			billingPeriod: {
				fields: { paidAmount: paidAmountField },
				aggregate: async ({ where }: { where: Row }) => {
					const values: unknown[] = [];
					const [row] = await query(
						`SELECT min("paidAmount")::text AS "paidAmount",max("refundedAmount")::text AS "refundedAmount" FROM ${this.table("billing_period")} bp WHERE ${predicate(where, values, "bp")}`,
						values,
					);
					return {
						_min: { paidAmount: row?.paidAmount ?? null },
						_max: { refundedAmount: row?.refundedAmount ?? null },
					};
				},
			},
		};
	}
}
