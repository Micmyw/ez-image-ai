import { PrismaPg } from "@prisma/adapter-pg";
import { getCatalogEntry, isCatalogInputSupported } from "@repo/ai";
import {
	createCreditGrant,
	createGenerationJobTransaction,
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isExplicitVideoVerificationTarget } from "../../../../../tests/load/video-verification-target";
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

	it("keeps retry identity on the quote without passing it to the model", async () => {
		const created = await createCommittedJob(client, "image-nano-banana-2-lite");
		const job = await client.generationJob.findUniqueOrThrow({
			where: { id: created.job.id },
			include: { quote: true },
		});
		expect(job.quote.inputSnapshot).toHaveProperty("submissionFingerprint", "a".repeat(64));
		expect(
			isCatalogInputSupported(getCatalogEntry("image-nano-banana-2-lite"), job.inputSnapshot),
		).toBe(true);
		expect(job.inputSnapshot).not.toHaveProperty("submissionFingerprint");
	});

	it("leaves JOB_CREATED pending after immediate delivery fails", async () => {
		const created = await createCommittedJob(client);

		await dispatchCreatedJobBestEffort(
			{
				jobId: created.job.id,
				version: created.job.version,
				replayed: created.replayed,
				serviceClass: "STANDARD",
			},
			{
				resolveRoute: async () => ({
					taskId: "media-dispatch-image-replicate",
					provider: "replicate",
					providerModelId: "black-forest-labs/flux-schnell",
				}),
				dispatch: async () => {
					throw new Error("Workflows unavailable");
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

async function createCommittedJob(database: PrismaClient, productKey = "image-fast") {
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
		productKey,
		catalogVersion: "2026-08-13.1",
		pricingVersion: "2026-08-13.1",
		credits: 4n,
		costMicros: 3_000n,
		inputSnapshot: {
			kind: "text-to-image",
			prompt: "fast path",
			submissionFingerprint: "a".repeat(64),
		},
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
	const safeDatabase =
		parsed.pathname === "/ai_media_foundation_test" ||
		/^\/ezpic_[a-z0-9_]+_test$/.test(parsed.pathname);
	if (
		parsed.hostname !== "127.0.0.1" ||
		(parsed.port !== "55432" && !isExplicitVideoVerificationTarget(parsed)) ||
		!safeDatabase
	) {
		throw new Error(
			"TEST_DATABASE_URL must target 127.0.0.1:55432/ai_media_foundation_test or a dedicated ezpic_*_test database",
		);
	}
	return value;
}
