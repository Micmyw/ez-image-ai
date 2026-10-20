import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { expect, type Page } from "@playwright/test";
import { Client } from "pg";

import { submitPasswordSignIn } from "./password-sign-in";

export interface AdminCapabilitiesIdentity {
	id: string;
	email: string;
	password: string;
}

export interface AdminCapabilitiesFixture {
	admin: AdminCapabilitiesIdentity;
	customer: AdminCapabilitiesIdentity;
	ticketId: (subject: string) => Promise<string>;
	credits: () => Promise<{ spendable: string; entries: number }>;
	serviceAccount: (name: string) => Promise<{
		scope: { kind: string; userId?: string };
		permissions: string[];
		keys: Array<{ name: string; revoked: boolean }>;
	}>;
	cleanup: () => Promise<void>;
}

function localDatabaseUrl(baseURL: string): string {
	if (process.env.E2E_ADMIN_CAPABILITIES !== "true")
		throw new Error("Admin capability fixtures require E2E_ADMIN_CAPABILITIES=true.");
	const connectionString =
		process.env.E2E_ADMIN_CAPABILITIES_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
	if (!connectionString || connectionString !== process.env.DATABASE_URL)
		throw new Error("The explicit admin E2E database URL must match DATABASE_URL.");
	const database = new URL(connectionString);
	const application = new URL(baseURL);
	const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
	const local = (url: URL) => localHosts.has(url.hostname.replace(/^\[|\]$/g, ""));
	if (
		application.protocol !== "http:" ||
		!local(application) ||
		!["postgres:", "postgresql:"].includes(database.protocol) ||
		!local(database) ||
		database.port !== "55432" ||
		database.pathname !== "/ezpic_admin_capabilities_test"
	)
		throw new Error("Admin E2E fixtures only support the explicit local port 55432 test database.");
	return connectionString;
}

/** Unique accounts only; no existing identity is promoted and no shared state is reset. */
export async function createAdminCapabilitiesFixture(
	baseURL: string,
): Promise<AdminCapabilitiesFixture> {
	const connectionString = localDatabaseUrl(baseURL);
	const createIdentity = (role: string): AdminCapabilitiesIdentity => {
		const id = `admin-ui-${role}-${randomUUID()}`;
		return { id, email: `${id}@example.test`, password: `Local-only-${randomUUID()}-Aa1!` };
	};
	const admin = createIdentity("admin");
	const customer = createIdentity("customer");
	const identities = [admin, customer];
	const authRequire = createRequire(resolve(__dirname, "../../../../packages/auth/package.json"));
	const { hashPassword } = authRequire("better-auth/crypto") as {
		hashPassword: (value: string) => Promise<string>;
	};

	async function withClient<T>(run: (client: Client) => Promise<T>) {
		localDatabaseUrl(baseURL);
		const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
		await client.connect();
		try {
			return await run(client);
		} finally {
			await client.end();
		}
	}

	await withClient(async (client) => {
		const unsafeNotifications = await client.query<{ enabled: boolean }>(
			`SELECT EXISTS (
				SELECT 1 FROM admin_bot_config
				WHERE COALESCE((payload->>'paymentEnabled')::boolean, false)
				   OR COALESCE((payload->>'ticketEnabled')::boolean, false)
			) AS enabled`,
		);
		if (unsafeNotifications.rows[0]?.enabled)
			throw new Error("Admin E2E requires payment/ticket bot notifications to be disabled.");
		await client.query("BEGIN");
		try {
			for (const identity of identities) {
				await client.query(
					`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, "onboardingComplete", "isAnonymous", locale)
					 VALUES ($1, $2, $3, TRUE, NOW() AT TIME ZONE 'UTC', NOW() AT TIME ZONE 'UTC', $4, TRUE, FALSE, 'en')`,
					[
						identity.id,
						`Local admin capability ${identity === admin ? "administrator" : "customer"}`,
						identity.email,
						identity === admin ? "admin" : "user",
					],
				);
				await client.query(
					`INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
					 VALUES ($1, $2, 'credential', $2, $3, NOW() AT TIME ZONE 'UTC', NOW() AT TIME ZONE 'UTC')`,
					[`${identity.id}-credential`, identity.id, await hashPassword(identity.password)],
				);
			}
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		}
	});

	return {
		admin,
		customer,
		async ticketId(subject) {
			return withClient(async (client) => {
				const result = await client.query<{ id: string }>(
					'SELECT id FROM support_ticket WHERE "createdByUserId" = $1 AND subject = $2',
					[customer.id, subject],
				);
				if (result.rows.length !== 1) throw new Error("Expected exactly one owned E2E ticket.");
				return result.rows[0].id;
			});
		},
		async credits() {
			return withClient(async (client) => {
				const result = await client.query<{ spendable: string; entries: number }>(
					`SELECT a."spendableCredits"::text AS spendable,
					 (SELECT COUNT(*)::int FROM credit_ledger_entry e WHERE e."accountId" = a.id) AS entries
					 FROM credit_account a WHERE a."ownerType" = 'USER' AND a."ownerId" = $1`,
					[customer.id],
				);
				if (result.rows.length !== 1) throw new Error("Expected the customer's credit account.");
				return result.rows[0];
			});
		},
		async serviceAccount(name) {
			return withClient(async (client) => {
				const accounts = await client.query<{
					id: string;
					scope: { kind: string; userId?: string };
					permissions: string[];
				}>(
					'SELECT id, scope, permissions FROM admin_service_account WHERE "createdByUserId" = $1 AND name = $2',
					[admin.id, name],
				);
				if (accounts.rows.length !== 1) throw new Error("Expected one owned E2E service account.");
				const keys = await client.query<{ name: string; revoked: boolean }>(
					'SELECT name, ("revokedAt" IS NOT NULL) AS revoked FROM admin_api_key WHERE "serviceAccountId" = $1',
					[accounts.rows[0].id],
				);
				return {
					scope: accounts.rows[0].scope,
					permissions: accounts.rows[0].permissions,
					keys: keys.rows,
				};
			});
		},
		async cleanup() {
			await withClient(async (client) => {
				await client.query("BEGIN");
				try {
					const ids = identities.map((identity) => identity.id);
					// Exact ownership predicates precede every dependent delete.
					await client.query(
						`DELETE FROM admin_bot_receipt WHERE "eventKey" IN
						 (SELECT 'ticket:' || m.id FROM support_ticket_message m
						  JOIN support_ticket t ON t.id = m."ticketId" WHERE t."createdByUserId" = ANY($1::text[]))`,
						[ids],
					);
					await client.query('DELETE FROM admin_execution WHERE "actorId" = ANY($1::text[])', [
						ids,
					]);
					await client.query(
						'DELETE FROM admin_execution WHERE "actorId" IN (SELECT id FROM admin_service_account WHERE "createdByUserId" = $1)',
						[admin.id],
					);
					await client.query(
						'DELETE FROM admin_api_key WHERE "serviceAccountId" IN (SELECT id FROM admin_service_account WHERE "createdByUserId" = $1)',
						[admin.id],
					);
					await client.query('DELETE FROM admin_service_account WHERE "createdByUserId" = $1', [
						admin.id,
					]);
					// Financial records are intentionally retained until the disposable test
					// database is destroyed. The ledger is immutable even during fixture cleanup;
					// never delete its entries, disable its trigger, or remove associated lots/accounts.
					// CreditAccount.ownerId is a scalar (not a User foreign key), so deleting these
					// exact test users removes their login/session/support rows without touching finance.
					const removed = await client.query(
						'DELETE FROM "user" WHERE id = ANY($1::text[]) RETURNING id',
						[ids],
					);
					if (removed.rowCount !== identities.length)
						throw new Error("Unique E2E user cleanup was incomplete.");
					const remaining = await client.query<{ count: string }>(
						`SELECT (
							(SELECT COUNT(*) FROM account WHERE "userId" = ANY($1::text[])) +
							(SELECT COUNT(*) FROM session WHERE "userId" = ANY($1::text[])) +
							(SELECT COUNT(*) FROM admin_api_key WHERE "createdByUserId" = ANY($1::text[])) +
							(SELECT COUNT(*) FROM admin_service_account WHERE "createdByUserId" = ANY($1::text[]))
						)::text AS count`,
						[ids],
					);
					if (remaining.rows[0]?.count !== "0")
						throw new Error("E2E login or service credential cleanup failed.");
					const retained = await client.query<{ accounts: number; lots: number; entries: number }>(
						`WITH owned_accounts AS (
							SELECT id FROM credit_account WHERE "ownerType" = 'USER' AND "ownerId" = ANY($1::text[])
						)
						SELECT
							(SELECT COUNT(*)::int FROM owned_accounts) AS accounts,
							(SELECT COUNT(*)::int FROM credit_lot WHERE "accountId" IN (SELECT id FROM owned_accounts)) AS lots,
							(SELECT COUNT(*)::int FROM credit_ledger_entry WHERE "accountId" IN (SELECT id FROM owned_accounts)) AS entries`,
						[ids],
					);
					await client.query("COMMIT");
					const financial = retained.rows[0];
					console.info(
						`Admin E2E mutable identity cleanup complete; retained ${financial.accounts} credit accounts, ${financial.lots} lots and ${financial.entries} immutable ledger entries until the isolated test database is destroyed.`,
					);
				} catch (error) {
					await client.query("ROLLBACK");
					throw error;
				}
			});
		},
	};
}

export async function loginAdminCapabilities(
	page: Page,
	identity: AdminCapabilitiesIdentity,
	destination: "/admin/analytics" | "/settings/support",
) {
	await page.goto(`/login?redirectTo=${encodeURIComponent(destination)}`);
	const declineOptional = page.getByRole("button", { name: "Decline optional", exact: true });
	if (await declineOptional.isVisible()) await declineOptional.click();
	await page.getByRole("tab", { name: "Password", exact: true }).click();
	await page.getByLabel(/email/i).fill(identity.email);
	await page.locator('input[autocomplete="current-password"]').fill(identity.password);
	await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
	await submitPasswordSignIn(page);
	await expect(page).toHaveURL(new RegExp(`${destination}(?:\\?|$)`), { timeout: 60_000 });
}
