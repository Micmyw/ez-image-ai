import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { expect, type Page } from "@playwright/test";
import { Client } from "pg";

export interface EffectsAdminFixture {
	email: string;
	password: string;
	cleanup: () => Promise<void>;
}

/** An explicit local opt-in; this helper never promotes or reuses an existing account. */
function localDatabaseUrl(baseURL: string): string {
	if (process.env.E2E_EFFECTS_ADMIN_PREVIEW !== "true") {
		throw new Error("The Effects administrator fixture requires E2E_EFFECTS_ADMIN_PREVIEW=true.");
	}
	const connectionString = process.env.E2E_EFFECTS_DATABASE_URL;
	const applicationDatabase = process.env.DATABASE_URL;
	if (!connectionString || !applicationDatabase) {
		throw new Error("Explicit E2E_EFFECTS_DATABASE_URL and DATABASE_URL are required.");
	}
	const application = new URL(baseURL);
	const database = new URL(connectionString);
	const configuredDatabase = new URL(applicationDatabase);
	const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
	const isLocal = (url: URL) => localHosts.has(url.hostname.replace(/^\[|\]$/g, ""));
	if (
		application.protocol !== "http:" ||
		!isLocal(application) ||
		!["postgres:", "postgresql:"].includes(database.protocol) ||
		!isLocal(database) ||
		!isLocal(configuredDatabase) ||
		database.host !== configuredDatabase.host ||
		database.pathname !== configuredDatabase.pathname ||
		!/^\/(?:supastarter|ezpic_effects_e2e[a-z0-9_]*)$/.test(database.pathname)
	) {
		throw new Error("Effects fixtures are restricted to the matching local application database.");
	}
	return connectionString;
}

export async function createEffectsAdminFixture(baseURL: string): Promise<EffectsAdminFixture> {
	const connectionString = localDatabaseUrl(baseURL);
	const id = `effects-e2e-${randomUUID()}`;
	const email = `${id}@example.test`;
	const password = `Local-only-${randomUUID()}-Aa1!`;
	// auth.ts uses Better Auth's default hasher. Resolve that package through its owning
	// workspace without importing the server auth/Prisma graph into Playwright's CJS runner.
	const authRequire = createRequire(resolve(__dirname, "../../../../packages/auth/package.json"));
	const { hashPassword } = authRequire("better-auth/crypto") as {
		hashPassword: (value: string) => Promise<string>;
	};
	const hashedPassword = await hashPassword(password);
	const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
	await client.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "role", "onboardingComplete", "isAnonymous")
			 VALUES ($1, $2, $3, TRUE, NOW(), NOW(), 'admin', TRUE, FALSE)`,
			[id, "Local Effects browser verification", email],
		);
		await client.query(
			`INSERT INTO "account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
			 VALUES ($1, $2, 'credential', $2, $3, NOW(), NOW())`,
			[`${id}-credential`, id, hashedPassword],
		);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		await client.end();
	}
	return {
		email,
		password,
		async cleanup() {
			// Recheck the environment before a write, and delete only this unique fixture.
			localDatabaseUrl(baseURL);
			const cleanupClient = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
			await cleanupClient.connect();
			try {
				const removed = await cleanupClient.query(
					'DELETE FROM "user" WHERE "id" = $1 AND "email" = $2 AND "role" = $3 RETURNING "id"',
					[id, email, "admin"],
				);
				if (removed.rowCount !== 1) throw new Error("The unique Effects fixture was not removed.");
				// Account and session foreign keys cascade from this exact user, never from a pattern.
				const remaining = await cleanupClient.query<{ count: string }>(
					'SELECT COUNT(*)::text AS count FROM "account" WHERE "userId" = $1',
					[id],
				);
				if (remaining.rows[0]?.count !== "0") throw new Error("Effects credential cleanup failed.");
			} finally {
				await cleanupClient.end();
			}
		},
	};
}

export async function loginEffectsAdmin(page: Page, fixture: EffectsAdminFixture) {
	await page.goto("/login?redirectTo=%2Feffects-preview%2F1980s-ai-photo");
	await page.getByRole("tab", { name: "Password", exact: true }).click();
	await page.getByLabel(/email/i).fill(fixture.email);
	await page.locator('input[autocomplete="current-password"]').fill(fixture.password);
	const signIn = page.getByRole("button", { name: "Sign in", exact: true });
	await expect(signIn).toBeEnabled();
	await signIn.click();
	await expect(page).toHaveURL(/\/effects-preview\/1980s-ai-photo(?:\?|$)/, { timeout: 60_000 });
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		"1980s AI Photo Prompts & Retro Photo Maker",
	);
}
