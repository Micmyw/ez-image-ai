import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type { Prisma } from "../prisma/generated/client";

/** Executes the production tagged SQL on PostgreSQL, without constructing a PrismaClient.
 * The random schema contains only the columns read by paid-credit-funding.ts. This verifies
 * receipt qualification; generated ORM mappings, migrations and ledger allocation have their
 * own integration tests. The supplied database must be explicitly local and test-only.
 */
export class PaidCreditFundingPostgresPort {
	readonly schema = `paid_funding_${randomUUID().replaceAll("-", "")}`;
	private pool: Pool | null = null;

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
			!/(^|[_-])test([_-]|$)/.test(url.pathname.slice(1))
		)
			throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
		this.pool = new Pool({
			connectionString: raw,
			max: 2,
			application_name: this.schema,
			options: `-c search_path=${this.schema}`,
		});
		await this.pool.query(`CREATE SCHEMA "${this.schema}"`);
		await this.pool.query(`
			CREATE TABLE ${this.table("credit_account")} (
				id text PRIMARY KEY, "ownerType" text NOT NULL, "ownerId" text NOT NULL
			);
			CREATE TABLE ${this.table("credit_lot")} (
				id text PRIMARY KEY, "accountId" text NOT NULL, "grantReferenceKey" text NOT NULL,
				"remainingAmount" bigint NOT NULL, "grantedAmount" bigint NOT NULL
			);
			CREATE TABLE ${this.table("credit_pack_fulfillment")} (
				id text PRIMARY KEY, "grantReferenceKey" text NOT NULL,
				"ownerType" text NOT NULL, "ownerId" text NOT NULL, currency text NOT NULL,
				status text NOT NULL, "paidAmountMicros" bigint NOT NULL,
				"refundedAmountMicros" bigint NOT NULL, "grantedCredits" bigint NOT NULL,
				"baseCredits" bigint NOT NULL, "bonusCredits" bigint NOT NULL
			);
			CREATE TABLE ${this.table("billing_plan")} (
				id text PRIMARY KEY, provider text NOT NULL, currency text NOT NULL
			);
			CREATE TABLE ${this.table("subscription")} (
				id text PRIMARY KEY, "planId" text NOT NULL, provider text NOT NULL,
				"ownerType" text NOT NULL, "ownerId" text NOT NULL
			);
			CREATE TABLE ${this.table("billing_period")} (
				id text PRIMARY KEY, "subscriptionId" text NOT NULL, "grantReferenceKey" text NOT NULL,
				"creditAmount" bigint NOT NULL, status text NOT NULL,
				"providerInvoicePaymentId" text NOT NULL,
				"paidAmount" bigint NOT NULL, "refundedAmount" bigint NOT NULL
			);
		`);
	}

	async reset() {
		await this.rows(
			`TRUNCATE ${[
				"credit_account",
				"credit_lot",
				"credit_pack_fulfillment",
				"billing_plan",
				"subscription",
				"billing_period",
			]
				.map((name) => this.table(name))
				.join(",")}`,
		);
	}

	async rows(text: string, values: unknown[] = []) {
		if (!this.pool) throw new Error("POSTGRES_PORT_NOT_INITIALIZED");
		return (await this.pool.query(text, values)).rows;
	}

	async read<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
		if (!this.pool) throw new Error("POSTGRES_PORT_NOT_INITIALIZED");
		const connection = await this.pool.connect();
		try {
			await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
			await connection.query("SET LOCAL statement_timeout='10s'");
			const result = await operation(this.transport(connection));
			await connection.query("COMMIT");
			return result;
		} catch (error) {
			await connection.query("ROLLBACK");
			throw error;
		} finally {
			connection.release();
		}
	}

	private transport(connection: PoolClient): Prisma.TransactionClient {
		return {
			$queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
				const text = strings.reduce(
					(sql, part, index) => sql + (index ? `$${index}` : "") + part,
					"",
				);
				return (await connection.query(text, values)).rows;
			},
		} as unknown as Prisma.TransactionClient;
	}

	async close() {
		if (!this.pool) return;
		try {
			await this.pool.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`);
		} finally {
			await this.pool.end();
			this.pool = null;
		}
	}
}
