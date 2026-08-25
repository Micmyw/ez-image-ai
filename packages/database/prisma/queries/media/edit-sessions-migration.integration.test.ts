import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const LEGACY_QUOTE_ID = "pr5-legacy-quote";
const LEGACY_JOB_ID = "pr5-legacy-job";

describe("image edit session nullable migration", () => {
	let client: PrismaClient;

	beforeAll(async () => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl(TEST_DATABASE_URL) }),
		});
		await client.$executeRaw`
			INSERT INTO "generation_quote" (
				"id", "ownerType", "ownerId", "submittedByUserId", "productKey",
				"catalogVersion", "pricingVersion", "credits", "costMicros",
				"inputSnapshot", "pricingSnapshot", "createdAt", "expiresAt"
			) VALUES (
				${LEGACY_QUOTE_ID}, 'USER'::"OwnerType", 'pr5-legacy-user', 'pr5-legacy-user',
				'image-fast', 'legacy-catalog', 'legacy-pricing', 4, 0,
				'{"kind":"image-to-image","prompt":"legacy edit","sourceAssetId":"legacy-asset"}'::jsonb,
				'{}'::jsonb, NOW(), '2099-01-01T00:00:00.000Z'::timestamptz
			)
			ON CONFLICT ("id") DO NOTHING`;
		await client.$executeRaw`
			INSERT INTO "generation_job" (
				"id", "ownerType", "ownerId", "submittedByUserId", "quoteId", "idempotencyKey",
				"productKey", "catalogVersion", "pricingVersion", "creditsReserved",
				"inputSnapshot", "pricingSnapshot", "createdAt", "updatedAt"
			) VALUES (
				${LEGACY_JOB_ID}, 'USER'::"OwnerType", 'pr5-legacy-user', 'pr5-legacy-user',
				${LEGACY_QUOTE_ID}, 'pr5-legacy-idempotency', 'image-fast', 'legacy-catalog',
				'legacy-pricing', 4,
				'{"kind":"image-to-image","prompt":"legacy edit","sourceAssetId":"legacy-asset"}'::jsonb,
				'{}'::jsonb, NOW(), NOW()
			)
			ON CONFLICT ("id") DO NOTHING`;
	});

	afterAll(async () => {
		if (!client) return;
		const columns = await editMetadataColumns(client);
		if (columns.length === 2) {
			await client.$executeRaw`DELETE FROM "generation_job" WHERE "id" = ${LEGACY_JOB_ID}`;
			await client.$executeRaw`DELETE FROM "generation_quote" WHERE "id" = ${LEGACY_QUOTE_ID}`;
		}
		await client.$disconnect();
	});

	it("adds the session table and both nullable job relation columns", async () => {
		const [table] = await client.$queryRaw<Array<{ exists: boolean }>>`
			SELECT EXISTS (
				SELECT 1 FROM information_schema.tables
				WHERE table_schema = 'public' AND table_name = 'image_edit_session'
			) AS "exists"`;

		expect(table?.exists).toBe(true);
		expect(await editMetadataColumns(client)).toEqual(["editSessionId", "parentJobId"]);
	});

	it("preserves a job created before the migration with null edit metadata", async () => {
		const [legacy] = await client.$queryRaw<Array<{ row: Record<string, unknown> }>>`
			SELECT to_jsonb(job) AS "row"
			FROM "generation_job" job
			WHERE job."id" = ${LEGACY_JOB_ID}`;

		expect(legacy?.row).toMatchObject({
			id: LEGACY_JOB_ID,
			editSessionId: null,
			parentJobId: null,
		});
	});
});

async function editMetadataColumns(client: PrismaClient): Promise<string[]> {
	const rows = await client.$queryRaw<Array<{ columnName: string }>>`
		SELECT column_name AS "columnName"
		FROM information_schema.columns
		WHERE table_schema = 'public'
		  AND table_name = 'generation_job'
		  AND column_name IN ('editSessionId', 'parentJobId')
		ORDER BY column_name`;
	return rows.map(({ columnName }) => columnName);
}

function safeTestDatabaseUrl(value: string | undefined): string {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	if (
		!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
		parsed.port !== "55432" ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(parsed.pathname.slice(1).toLowerCase())
	) {
		throw new Error("TEST_DATABASE_URL must target the disposable PR 5 database");
	}
	return value;
}
