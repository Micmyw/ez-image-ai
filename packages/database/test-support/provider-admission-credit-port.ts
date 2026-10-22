import { randomUUID } from "node:crypto";

import { sqltag } from "@prisma/client/runtime/client";
import { Pool, type PoolClient } from "pg";

import type { Prisma } from "../prisma/generated/client";
import type { MediaTransactionClient } from "../prisma/queries/media/types";

type Row = Record<string, unknown>;
const bigintColumns = new Set([
	"spendableCredits",
	"reservedCredits",
	"creditDebt",
	"credits",
	"costMicros",
	"creditsReserved",
	"grantedAmount",
	"remainingAmount",
	"expiredUnrefundedAmount",
	"reservedAmount",
	"amount",
	"settledAmount",
	"releasedAmount",
	"revokedAmount",
	"revokedSettledAmount",
	"revokedReleasedAmount",
	"total",
	"bytes",
]);

/** SQL-only adapter for the bounded text-job/credit paths under test. This maps
 * ORM row operations to PostgreSQL; all balance, replay and admission decisions
 * execute the production functions. It neither constructs a PrismaClient nor
 * certifies generated-ORM mapping, full application migrations or provider I/O. */
export class CreditAdmissionPostgresFixture {
	readonly schema = `admission_credits_${randomUUID().replaceAll("-", "")}`;
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
		this.pool = new Pool({ connectionString: raw, max: 12 });
		await this.pool.query(`CREATE SCHEMA "${this.schema}"`);
		await this.pool.query(`
			CREATE TYPE "${this.schema}"."OwnerType" AS ENUM ('USER', 'ORGANIZATION');
			CREATE TABLE ${this.table("media_owner_storage_fence")} (
				"ownerType" "${this.schema}"."OwnerType" NOT NULL, "ownerId" text NOT NULL,
				revision bigint NOT NULL DEFAULT 0,
				PRIMARY KEY ("ownerType", "ownerId")
			);
			CREATE TABLE ${this.table("credit_account")} (
				id text PRIMARY KEY, "ownerType" text NOT NULL, "ownerId" text NOT NULL,
				"spendableCredits" bigint NOT NULL DEFAULT 0 CHECK ("spendableCredits">=0),
				"reservedCredits" bigint NOT NULL DEFAULT 0 CHECK ("reservedCredits">=0),
				"creditDebt" bigint NOT NULL DEFAULT 0 CHECK ("creditDebt">=0), version integer NOT NULL DEFAULT 0,
				UNIQUE ("ownerType", "ownerId")
			);
			CREATE TABLE ${this.table("credit_lot")} (
				id text PRIMARY KEY, "accountId" text NOT NULL REFERENCES ${this.table("credit_account")}(id),
				"grantReferenceKey" text NOT NULL, "grantedAmount" bigint NOT NULL,
				"remainingAmount" bigint NOT NULL, "reservedAmount" bigint NOT NULL DEFAULT 0,
				"expiredUnrefundedAmount" bigint NOT NULL DEFAULT 0, "expiresAt" timestamptz,
				"createdAt" timestamptz NOT NULL DEFAULT now()
			);
			CREATE TABLE ${this.table("generation_quote")} (
				id text PRIMARY KEY, "ownerType" text NOT NULL, "ownerId" text NOT NULL,
				"submittedByUserId" text NOT NULL, "productKey" text NOT NULL,
				"catalogVersion" text NOT NULL, "pricingVersion" text NOT NULL,
				credits bigint NOT NULL, "costMicros" bigint NOT NULL, "inputSnapshot" jsonb NOT NULL,
				"pricingSnapshot" jsonb NOT NULL, "expiresAt" timestamptz NOT NULL,
				"moderationDecision" text NOT NULL, "moderationProvider" text NOT NULL,
				"moderationRuleVersion" text NOT NULL, "moderationReasonCode" text NOT NULL,
				"inputFingerprint" text NOT NULL
			);
			CREATE TABLE ${this.table("generation_job")} (
				id text PRIMARY KEY, "ownerType" text NOT NULL, "ownerId" text NOT NULL,
				"submittedByUserId" text NOT NULL, "quoteId" text NOT NULL UNIQUE REFERENCES ${this.table("generation_quote")}(id),
				"idempotencyKey" text NOT NULL, "productKey" text NOT NULL,
				"catalogVersion" text NOT NULL, "pricingVersion" text NOT NULL,
				"fundingSource" text NOT NULL DEFAULT 'CREDITS',
				"creditsReserved" bigint NOT NULL, "inputSnapshot" jsonb NOT NULL, "pricingSnapshot" jsonb NOT NULL,
				"editSessionId" text, "parentJobId" text, status text NOT NULL DEFAULT 'RESERVED',
				version integer NOT NULL DEFAULT 0, "executionEngine" text NOT NULL DEFAULT 'legacy',
				"serviceClass" text NOT NULL DEFAULT 'STANDARD', "createdAt" timestamptz NOT NULL DEFAULT now(),
				UNIQUE ("ownerType", "ownerId", "idempotencyKey")
			);
			CREATE TABLE ${this.table("credit_reservation")} (
				id text PRIMARY KEY, "accountId" text NOT NULL REFERENCES ${this.table("credit_account")}(id),
				"jobId" text NOT NULL UNIQUE REFERENCES ${this.table("generation_job")}(id),
				amount bigint NOT NULL, "settledAmount" bigint NOT NULL DEFAULT 0,
				"releasedAmount" bigint NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'ACTIVE',
				"createdAt" timestamptz NOT NULL DEFAULT now()
			);
			CREATE TABLE ${this.table("credit_reservation_allocation")} (
				id text PRIMARY KEY, "reservationId" text NOT NULL REFERENCES ${this.table("credit_reservation")}(id),
				"lotId" text NOT NULL REFERENCES ${this.table("credit_lot")}(id), amount bigint NOT NULL,
				"settledAmount" bigint NOT NULL DEFAULT 0, "releasedAmount" bigint NOT NULL DEFAULT 0,
				"revokedAmount" bigint NOT NULL DEFAULT 0, "revokedSettledAmount" bigint NOT NULL DEFAULT 0,
				"revokedReleasedAmount" bigint NOT NULL DEFAULT 0
			);
			CREATE TABLE ${this.table("credit_ledger_entry")} (
				id text PRIMARY KEY, "accountId" text NOT NULL REFERENCES ${this.table("credit_account")}(id),
				"reservationId" text REFERENCES ${this.table("credit_reservation")}(id),
				"lotId" text REFERENCES ${this.table("credit_lot")}(id), type text NOT NULL,
				amount bigint NOT NULL, "referenceKey" text NOT NULL UNIQUE, metadata jsonb NOT NULL
			);
			CREATE TABLE ${this.table("generation_job_asset")} ("jobId" text, "assetId" text, role text);
			CREATE TABLE ${this.table("subscription")} (id text PRIMARY KEY, "ownerType" text, "ownerId" text);
			CREATE TABLE ${this.table("storage_usage_reservation")} (
				id text PRIMARY KEY, "ownerType" text, "ownerId" text, bytes bigint,
				status text, "referenceKey" text, "expiresAt" timestamptz
			);
			CREATE TABLE ${this.table("outbox_event")} (
				id text PRIMARY KEY, "eventType" text NOT NULL, "aggregateType" text NOT NULL,
				"aggregateId" text NOT NULL, "dedupeKey" text NOT NULL UNIQUE, payload jsonb NOT NULL,
				status text NOT NULL DEFAULT 'PENDING', "availableAt" timestamptz NOT NULL DEFAULT now()
			);
		`);
	}

	async reset() {
		await this.pool.query(
			`TRUNCATE ${this.table("credit_account")}, ${this.table("generation_quote")}, ${this.table("outbox_event")}, ${this.table("generation_job_asset")}, ${this.table("subscription")}, ${this.table("storage_usage_reservation")}, ${this.table("media_owner_storage_fence")} CASCADE`,
		);
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
		return (await this.pool.query(text, values)).rows.map(normalizeRow) as T[];
	}

	async transaction<T>(
		operation: (tx: Prisma.TransactionClient, connection: PoolClient) => Promise<T>,
		isolationLevel: "ReadCommitted" | "Serializable" = "ReadCommitted",
	): Promise<T> {
		const connection = await this.pool.connect();
		try {
			await connection.query(
				isolationLevel === "Serializable"
					? "BEGIN ISOLATION LEVEL SERIALIZABLE"
					: "BEGIN ISOLATION LEVEL READ COMMITTED",
			);
			await connection.query(`SET LOCAL search_path TO "${this.schema}"`);
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
			$transaction: <T>(
				operation: (tx: Prisma.TransactionClient) => Promise<T>,
				options?: { isolationLevel: "ReadCommitted" | "Serializable" },
			) => this.transaction(operation, options?.isolationLevel),
		} as unknown as MediaTransactionClient;
	}

	private port(connection: Pick<PoolClient, "query">) {
		const query = async (text: string, values: unknown[] = []) =>
			(await connection.query(text, values)).rows.map(normalizeRow);
		const whereSql = (where: Row, values: unknown[]) => {
			const flat = (where.ownerType_ownerId ??
				where.ownerType_ownerId_idempotencyKey ??
				where) as Row;
			return Object.entries(flat)
				.map(([key, value]) => {
					values.push(value);
					return `"${key}"=$${values.length}`;
				})
				.join(" AND ");
		};
		const model = (name: string) => {
			const find = async ({ where }: { where: Row }) => {
				const values: unknown[] = [];
				return (
					(
						await query(
							`SELECT * FROM ${this.table(name)} WHERE ${whereSql(where, values)} LIMIT 1`,
							values,
						)
					)[0] ?? null
				);
			};
			const create = async ({ data }: { data: Row }) => {
				const entries = Object.entries({ id: randomUUID(), ...data }).filter(
					([, value]) => value !== undefined,
				);
				return (
					await query(
						`INSERT INTO ${this.table(name)} (${entries.map(([key]) => `"${key}"`).join(",")}) VALUES (${entries.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
						entries.map(([, value]) => value),
					)
				)[0];
			};
			return {
				findUnique: find,
				findFirst: find,
				findUniqueOrThrow: async (args: { where: Row }) => {
					const row = await find(args);
					if (!row) throw new Error("TEST_ROW_NOT_FOUND");
					return row;
				},
				create,
				createMany: async ({ data }: { data: Row[] }) => {
					for (const row of data) await create({ data: row });
					return { count: data.length };
				},
				update: async ({ where, data }: { where: Row; data: Row }) => {
					const values: unknown[] = [];
					const assignments = Object.entries(data).map(([key, value]) => {
						const delta = value && typeof value === "object" ? (value as Row) : null;
						values.push(delta ? (delta.increment ?? delta.decrement) : value);
						return `"${key}"=${delta ? `"${key}"${delta.increment !== undefined ? "+" : "-"}` : ""}$${values.length}`;
					});
					return (
						await query(
							`UPDATE ${this.table(name)} SET ${assignments.join(",")} WHERE ${whereSql(where, values)} RETURNING *`,
							values,
						)
					)[0];
				},
			};
		};
		const jobs = model("generation_job");
		return {
			$queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
				const statement = sqltag(strings, ...values);
				return query(statement.text, statement.values);
			},
			$executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
				const statement = sqltag(strings, ...values);
				return (await connection.query(statement.text, statement.values)).rowCount ?? 0;
			},
			creditAccount: model("credit_account"),
			creditLot: model("credit_lot"),
			creditReservation: model("credit_reservation"),
			creditReservationAllocation: model("credit_reservation_allocation"),
			creditLedgerEntry: model("credit_ledger_entry"),
			// These bounded admission suites exercise owners without subscriptions.
			// Subscription eligibility and generated ORM relations have separate tests.
			subscription: {
				findMany: ({ where }: { where: { ownerType: string; ownerId: string } }) =>
					query(
						`SELECT * FROM ${this.table("subscription")} WHERE "ownerType"=$1 AND "ownerId"=$2`,
						[where.ownerType, where.ownerId],
					),
			},
			billingPeriod: { fields: { paidAmount: "paidAmount" } },
			storageUsageReservation: {
				aggregate: async ({
					where,
				}: {
					where: {
						ownerType: string;
						ownerId: string;
						status: { in: string[] };
						OR: [{ NOT: { referenceKey: { startsWith: string } } }, { expiresAt: { gt: Date } }];
					};
				}) => {
					const [row] = await query(
						`SELECT COALESCE(SUM(bytes),0)::bigint AS bytes FROM ${this.table("storage_usage_reservation")} WHERE "ownerType"=$1 AND "ownerId"=$2 AND status=ANY($3::text[]) AND (left("referenceKey",length($4)) <> $4 OR "expiresAt">$5)`,
						[
							where.ownerType,
							where.ownerId,
							where.status.in,
							where.OR[0].NOT.referenceKey.startsWith,
							where.OR[1].expiresAt.gt,
						],
					);
					return { _sum: { bytes: row?.bytes ?? 0n } };
				},
			},
			generationQuote: model("generation_quote"),
			generationJob: {
				...jobs,
				findUnique: async (args: { where: Row; include?: Row }) => {
					const job = await jobs.findUnique(args);
					if (!job || !args.include) return job;
					return {
						...job,
						reservation: await model("credit_reservation").findUnique({ where: { jobId: job.id } }),
						editSession: null,
					};
				},
				count: async ({
					where,
				}: {
					where: { ownerType?: string; ownerId?: string; status: { in: string[] } };
				}) => {
					const rows = await query(
						`SELECT count(*)::int AS count FROM ${this.table("generation_job")} WHERE status=ANY($1::text[]) AND ($2::text IS NULL OR "ownerType"=$2) AND ($3::text IS NULL OR "ownerId"=$3)`,
						[where.status.in, where.ownerType ?? null, where.ownerId ?? null],
					);
					return rows[0]?.count;
				},
			},
			generationJobAsset: {
				findMany: ({ where }: { where: { jobId: string; role: string } }) =>
					query(
						`SELECT "assetId" FROM ${this.table("generation_job_asset")} WHERE "jobId"=$1 AND role=$2`,
						[where.jobId, where.role],
					),
			},
			outboxEvent: {
				...model("outbox_event"),
				findMany: ({ where }: { where: { AND: Array<Row> } }) => {
					const scope = where.AND[0] as {
						aggregateType: string;
						aggregateId: string;
						eventType: { in: string[] };
					};
					return query(
						`SELECT id FROM ${this.table("outbox_event")} WHERE "aggregateType"=$1 AND "aggregateId"=$2 AND "eventType"=ANY($3::text[]) AND status IN ('PENDING','LEASED') ORDER BY "availableAt",id LIMIT 100`,
						[scope.aggregateType, scope.aggregateId, scope.eventType.in],
					);
				},
			},
		};
	}
}

function normalizeRow(row: Row): Row {
	return Object.fromEntries(
		Object.entries(row).map(([key, value]) => [
			key,
			bigintColumns.has(key) && typeof value === "string" ? BigInt(value) : value,
		]),
	);
}
