import { PrismaPg } from "@prisma/adapter-pg";
import {
	createCreditGrant,
	createGenerationJobTransaction,
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dispatchCreatedJobBestEffort } from "./dispatch-created-job";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
let client: PrismaClient;

describe("committed generation fast dispatch", () => {
	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: assertSafeTestDatabaseUrl(TEST_DATABASE_URL) }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("leaves JOB_CREATED pending after immediate delivery fails", async () => {
		const created = await createCommittedJob(client);

		await dispatchCreatedJobBestEffort(
			{ jobId: created.job.id, version: created.job.version, replayed: created.replayed },
			{
				resolveRoute: async () => ({
					taskId: "media-dispatch-image-replicate",
					provider: "replicate",
					providerModelId: "black-forest-labs/flux-schnell",
				}),
				trigger: async () => {
					throw new Error("Trigger unavailable");
				},
			},
		);

		await expect(
			client.outboxEvent.findUniqueOrThrow({
				where: { dedupeKey: `job:${created.job.id}:created` },
			}),
		).resolves.toMatchObject({ status: "PENDING", attempts: 0 });
		await expect(
			client.generationJob.findUniqueOrThrow({ where: { id: created.job.id } }),
		).resolves.toMatchObject({
			status: "RESERVED",
		});
	});
});

async function createCommittedJob(database: PrismaClient) {
	const suffix = crypto.randomUUID();
	const ownerId = `fast-dispatch-${suffix}`;
	const account = await database.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{ accountId: account.id, amount: 10n, referenceKey: `fast-dispatch-grant:${suffix}` },
		database,
	);
	const quoteInput = {
		ownerType: "USER",
		ownerId,
		submittedByUserId: ownerId,
		productKey: "image-fast",
		catalogVersion: "2026-08-13.1",
		pricingVersion: "2026-08-13.1",
		credits: 4n,
		costMicros: 3_000n,
		inputSnapshot: { kind: "text-to-image", prompt: "fast path" },
		pricingSnapshot: { credits: 4 },
		expiresAt: new Date(Date.now() + 60_000),
	} as const;
	const quote = await createModeratedGenerationQuoteTransaction(
		{
			...quoteInput,
			moderation: {
				decision: "ALLOW",
				provider: "test",
				ruleVersion: "TEST_ALLOW_FAST_DISPATCH_V1",
				reasonCode: "TEST_ALLOW_FAST_DISPATCH",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
			},
		},
		database,
	);
	return createGenerationJobTransaction(
		{
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: `fast-dispatch-job:${suffix}`,
			inputAssetIds: [],
			expectedModerationRuleVersion: "TEST_ALLOW_FAST_DISPATCH_V1",
		},
		database,
	);
}

function assertSafeTestDatabaseUrl(value: string | undefined): string {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	const databaseName = decodeURIComponent(parsed.pathname.slice(1));
	if (
		!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) ||
		!/test|testing/i.test(databaseName)
	) {
		throw new Error("TEST_DATABASE_URL must use a loopback test database");
	}
	return value;
}
