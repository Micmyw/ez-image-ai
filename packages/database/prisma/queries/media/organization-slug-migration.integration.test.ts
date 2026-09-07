import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "pg";
import { describe, expect, it } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MIGRATION_NAME = "20260907143000_reserve_static_organization_slugs";
const TOP_LEVEL_STATIC_ROUTE_SEGMENTS = [
	"admin",
	"api",
	"assets",
	"blog",
	"changelog",
	"chatbot",
	"checkout-return",
	"choose-plan",
	"contact",
	"create",
	"credit-pack-checkout-return",
	"dashboard",
	"docs",
	"draft",
	"edits",
	"forgot-password",
	"history",
	"icon.png",
	"image-proxy",
	"llms-full.txt",
	"llms.mdx",
	"llms.txt",
	"login",
	"new-organization",
	"og",
	"onboarding",
	"opengraph-image",
	"organization-invitation",
	"pricing",
	"privacy",
	"reset-password",
	"robots.txt",
	"settings",
	"signup",
	"sitemap.xml",
	"terms",
	"try",
	"verify",
] as const;

function safeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	const parsed = new URL(TEST_DATABASE_URL);
	const databaseName = parsed.pathname.slice(1).toLowerCase();
	if (
		!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(databaseName)
	) {
		throw new Error("UNSAFE_TEST_DATABASE");
	}
	return TEST_DATABASE_URL;
}

async function migrationSql(): Promise<string> {
	return readFile(
		resolve(process.cwd(), "prisma", "migrations", MIGRATION_NAME, "migration.sql"),
		"utf8",
	);
}

async function createHarness(): Promise<{ client: Client; schema: string }> {
	const client = new Client({ connectionString: safeTestDatabaseUrl() });
	const schema = `organization_slug_migration_${randomUUID().replaceAll("-", "")}`;
	await client.connect();
	await client.query(`CREATE SCHEMA "${schema}"`);
	await client.query(`SET search_path TO "${schema}", public`);
	await client.query(`
		CREATE TABLE "organization" (
			"id" TEXT PRIMARY KEY,
			"slug" TEXT
		)
	`);
	return { client, schema };
}

async function destroyHarness(client: Client, schema: string): Promise<void> {
	await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
	await client.end();
}

describe("reserved organization slug migration", () => {
	it("fails closed and preserves an existing colliding slug", async () => {
		const { client, schema } = await createHarness();
		try {
			await client.query(
				`INSERT INTO "organization" ("id", "slug") VALUES ('legacy-pricing', ' Pricing ')`,
			);

			await expect(client.query(await migrationSql())).rejects.toThrow(
				/ORGANIZATION_SLUG_ROUTE_CONFLICT/,
			);
			await expect(
				client.query(`SELECT "slug" FROM "organization" WHERE "id" = 'legacy-pricing'`),
			).resolves.toMatchObject({ rows: [{ slug: " Pricing " }] });
		} finally {
			await destroyHarness(client, schema);
		}
	});

	it("prevents future inserts and updates from taking every current static route", async () => {
		const { client, schema } = await createHarness();
		try {
			await client.query(await migrationSql());
			await client.query(
				`INSERT INTO "organization" ("id", "slug") VALUES ('design-team', 'design-team')`,
			);

			for (const slug of TOP_LEVEL_STATIC_ROUTE_SEGMENTS) {
				await expect(
					client.query(`INSERT INTO "organization" ("id", "slug") VALUES ($1, $2)`, [
						`insert-${slug}`,
						` ${slug.toUpperCase()} `,
					]),
				).rejects.toThrow(/organization_slug_no_static_route_conflict/);
				await expect(
					client.query(`UPDATE "organization" SET "slug" = $1 WHERE "id" = 'design-team'`, [slug]),
				).rejects.toThrow(/organization_slug_no_static_route_conflict/);
			}

			await expect(
				client.query(`SELECT "slug" FROM "organization" WHERE "id" = 'design-team'`),
			).resolves.toMatchObject({ rows: [{ slug: "design-team" }] });
		} finally {
			await destroyHarness(client, schema);
		}
	});
});
