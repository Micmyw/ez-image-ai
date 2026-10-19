import { randomUUID } from "node:crypto";

import { sqltag } from "@prisma/client/runtime/client";
import { Pool } from "pg";

import type { Prisma } from "../prisma/generated/client";
import type { MediaTransactionClient } from "../prisma/queries/media/types";

type Row = Record<string, unknown>;
const bigintColumns = new Set([
	"spendableCredits",
	"reservedCredits",
	"creditDebt",
	"amount",
	"grantedAmount",
	"remainingAmount",
	"reservedAmount",
	"expiredUnrefundedAmount",
	"settledAmount",
	"releasedAmount",
	"revokedAmount",
	"revokedSettledAmount",
	"revokedReleasedAmount",
]);

/** A PostgreSQL row port for the actual login/ledger functions, not a generated
 * PrismaClient substitute. Only transport/mapping lives here; no grant, balance,
 * replay or retry decisions are reimplemented. Generated ORM coverage stays a
 * separate integration requirement. Each suite owns and drops its own schema. */
export class LoginBonusPostgresPort {
	readonly schema = `login_bonus_${randomUUID().replaceAll("-", "")}`;
	private pool!: Pool;
	table(name: string) {
		if (!/^[a-z_]+$/.test(name)) throw new Error("INVALID_TEST_TABLE");
		return `"${this.schema}"."${name}"`;
	}
	async initialize() {
		const target = new URL(process.env.TEST_DATABASE_URL ?? "");
		if (
			!["postgres:", "postgresql:"].includes(target.protocol) ||
			!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
			!target.pathname.includes("test")
		)
			throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
		this.pool = new Pool({ connectionString: target.toString(), max: 12 });
		await this.pool.query(`CREATE SCHEMA "${this.schema}"`);
		await this.pool.query(`
			CREATE TABLE ${this.table("user")} (id text PRIMARY KEY, "isAnonymous" boolean);
			CREATE TABLE ${this.table("credit_account")} (id text PRIMARY KEY, "ownerType" text NOT NULL, "ownerId" text NOT NULL,
				"spendableCredits" bigint NOT NULL DEFAULT 0 CHECK ("spendableCredits">=0), "reservedCredits" bigint NOT NULL DEFAULT 0 CHECK ("reservedCredits">=0), "creditDebt" bigint NOT NULL DEFAULT 0 CHECK ("creditDebt">=0), version integer NOT NULL DEFAULT 0, UNIQUE ("ownerType", "ownerId"));
			CREATE TABLE ${this.table("credit_lot")} (id text PRIMARY KEY, "accountId" text NOT NULL REFERENCES ${this.table("credit_account")}(id),
				"grantReferenceKey" text NOT NULL, "grantedAmount" bigint NOT NULL, "remainingAmount" bigint NOT NULL, "reservedAmount" bigint NOT NULL DEFAULT 0,
				"expiredUnrefundedAmount" bigint NOT NULL DEFAULT 0, "expiresAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now());
			CREATE TABLE ${this.table("credit_reservation")} (id text PRIMARY KEY, "accountId" text NOT NULL REFERENCES ${this.table("credit_account")}(id), "jobId" text NOT NULL UNIQUE,
				amount bigint NOT NULL, "settledAmount" bigint NOT NULL DEFAULT 0, "releasedAmount" bigint NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'ACTIVE', "createdAt" timestamptz NOT NULL DEFAULT now());
			CREATE TABLE ${this.table("credit_reservation_allocation")} (id text PRIMARY KEY, "reservationId" text NOT NULL REFERENCES ${this.table("credit_reservation")}(id),
				"lotId" text NOT NULL REFERENCES ${this.table("credit_lot")}(id), amount bigint NOT NULL, "settledAmount" bigint NOT NULL DEFAULT 0,
				"releasedAmount" bigint NOT NULL DEFAULT 0, "revokedAmount" bigint NOT NULL DEFAULT 0, "revokedSettledAmount" bigint NOT NULL DEFAULT 0, "revokedReleasedAmount" bigint NOT NULL DEFAULT 0);
			CREATE TABLE ${this.table("credit_ledger_entry")} (id text PRIMARY KEY, "accountId" text NOT NULL REFERENCES ${this.table("credit_account")}(id),
				"reservationId" text REFERENCES ${this.table("credit_reservation")}(id), "lotId" text REFERENCES ${this.table("credit_lot")}(id), type text NOT NULL, amount bigint NOT NULL,
				"referenceKey" text NOT NULL UNIQUE, metadata jsonb NOT NULL);
		`);
	}
	async reset() {
		await this.pool.query(
			`TRUNCATE ${this.table("user")}, ${this.table("credit_account")} CASCADE`,
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
	async rows(text: string, values: unknown[] = []) {
		return (await this.pool.query(text, values)).rows.map(normalizeRow);
	}
	async transaction<T>(
		operation: (tx: Prisma.TransactionClient) => Promise<T>,
		isolationLevel = "Serializable",
	): Promise<T> {
		if (!["Serializable", "ReadCommitted"].includes(isolationLevel))
			throw new Error("UNSUPPORTED_TEST_ISOLATION");
		const connection = await this.pool.connect();
		const query = async (text: string, values: unknown[] = []) => {
			try {
				return (await connection.query(text, values)).rows.map(normalizeRow);
			} catch (error) {
				// Match the official pg adapter's SQLSTATE projection used by the
				// production retry classifier, retaining the actual PostgreSQL error.
				if (
					error instanceof Error &&
					"code" in error &&
					["40001", "23505"].includes(String(error.code))
				)
					Object.defineProperty(error, "cause", {
						value: { originalCode: error.code },
						configurable: true,
					});
				throw error;
			}
		};
		const model = (name: string) => {
			const whereSql = (where: Row, values: unknown[]) =>
				Object.entries((where.ownerType_ownerId ?? where) as Row)
					.map(([key, value]) => {
						values.push(value);
						return `"${key}"=$${values.length}`;
					})
					.join(" AND ");
			const find = async ({ where, include }: { where: Row; include?: Row }) => {
				const values: unknown[] = [];
				const row =
					(
						await query(
							`SELECT * FROM ${this.table(name)} WHERE ${whereSql(where, values)} LIMIT 1`,
							values,
						)
					)[0] ?? null;
				if (row && include?.account)
					row.account = (
						await query(
							`SELECT "ownerType", "ownerId" FROM ${this.table("credit_account")} WHERE id=$1`,
							[row.accountId],
						)
					)[0];
				return row;
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
		const tx = {
			$queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
				const sql = sqltag(strings, ...values);
				return query(sql.text, sql.values);
			},
			user: model("user"),
			creditLot: model("credit_lot"),
			creditReservation: model("credit_reservation"),
			creditReservationAllocation: model("credit_reservation_allocation"),
			creditLedgerEntry: model("credit_ledger_entry"),
			creditAccount: {
				...model("credit_account"),
				upsert: ({ create }: { create: Row }) =>
					query(
						`INSERT INTO ${this.table("credit_account")} (id,"ownerType","ownerId") VALUES ($1,$2,$3) ON CONFLICT ("ownerType","ownerId") DO UPDATE SET "ownerId"=EXCLUDED."ownerId" RETURNING *`,
						[randomUUID(), create.ownerType, create.ownerId],
					).then((rows) => rows[0]),
			},
		};
		try {
			await connection.query(
				isolationLevel === "Serializable"
					? "BEGIN ISOLATION LEVEL SERIALIZABLE"
					: "BEGIN ISOLATION LEVEL READ COMMITTED",
			);
			await connection.query(`SET LOCAL search_path TO "${this.schema}"`);
			const result = await operation(tx as unknown as Prisma.TransactionClient);
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
			$transaction: <T>(
				operation: (tx: Prisma.TransactionClient) => Promise<T>,
				options?: { isolationLevel: string },
			) => this.transaction(operation, options?.isolationLevel),
		} as unknown as MediaTransactionClient;
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
