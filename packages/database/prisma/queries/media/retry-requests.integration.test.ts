import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { createCreditGrant } from "./credits";
import { createGenerationJobTransaction } from "./jobs";
import {
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "./quotes";
import {
	claimGenerationRetryRequest,
	completeGenerationRetryRequest,
	createGenerationRetryQuoteCheckpoint,
	failGenerationRetryRequest,
	resumeGenerationRetryRequest,
	type GenerationRetryOperation,
} from "./retry-requests";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEXT_RULE = "text-rule-v2";
const ASSET_RULE = "asset-rule-v2";
const ASSET_POLICY = "asset-policy-v2";

describe("generation retry request idempotency", () => {
	let client: PrismaClient;

	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl(TEST_DATABASE_URL) }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("allows one moderation owner and replays a completed real job", async () => {
		const fixture = await createRetryFixture(client);
		const claims = await Promise.all([
			claimGenerationRetryRequest(fixture.claimInput, client),
			claimGenerationRetryRequest(fixture.claimInput, client),
		]);
		const claimed = claims.find((result) => result.outcome === "CLAIMED");
		expect(claims.map((result) => result.outcome).sort()).toEqual(["CLAIMED", "IN_PROGRESS"]);
		if (!claimed || claimed.outcome !== "CLAIMED") throw new Error("Expected a retry claim");
		const quote = await checkpointQuote(client, fixture, claimed);
		const created = await createResultJob(client, fixture, quote.id);

		await completeGenerationRetryRequest(
			{
				requestId: claimed.requestId,
				leaseToken: claimed.leaseToken,
				quoteId: quote.id,
				resultJobId: created.job.id,
			},
			client,
		);

		await expect(resumeGenerationRetryRequest(fixture.resumeInput, client)).resolves.toMatchObject({
			outcome: "SUCCEEDED",
			resultJobId: created.job.id,
		});
	});

	it("rejects reuse of an idempotency key for a different source job", async () => {
		const fixture = await createRetryFixture(client);
		const secondSourceId = `source-job-${crypto.randomUUID()}`;
		await createSourceJob(client, fixture.ownerId, secondSourceId, "second source prompt");
		await claimGenerationRetryRequest(fixture.claimInput, client);

		await expect(
			claimGenerationRetryRequest(
				{
					...fixture.claimInput,
					operation: { ...fixture.operation, sourceJobId: secondSourceId },
				},
				client,
			),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
	});

	it("rejects the same retry key when normalized parameters or input checksums change", async () => {
		const fixture = await createRetryFixture(client);
		await claimGenerationRetryRequest(fixture.claimInput, client);

		await expect(
			claimGenerationRetryRequest(
				{
					...fixture.claimInput,
					operation: {
						...fixture.operation,
						normalizedInput: {
							kind: "text-to-image",
							prompt: fixture.prompt,
							outputCount: 2,
						},
					},
				},
				client,
			),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");

		await expect(
			claimGenerationRetryRequest(
				{
					...fixture.claimInput,
					operation: {
						...fixture.operation,
						inputAssets: [{ assetId: "asset-1", assetChecksum: "b".repeat(64) }],
					},
				},
				client,
			),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
	});

	it("repairs a post-job crash after current moderation configuration drifts", async () => {
		const fixture = await createRetryFixture(client, {
			operation: {
				moderationProvider: "retired-safety-provider",
				moderationRuleVersion: "retired-text-rule",
				assetModerationRuleVersion: "retired-asset-rule",
				assetModerationPolicyVersion: "retired-asset-policy",
			},
		});
		const claimed = await claimGenerationRetryRequest(fixture.claimInput, client);
		if (claimed.outcome !== "CLAIMED") throw new Error("Expected a retry claim");
		const quote = await checkpointQuote(client, fixture, claimed);
		const created = await createResultJob(client, fixture, quote.id);

		await expect(resumeGenerationRetryRequest(fixture.resumeInput, client)).resolves.toMatchObject({
			outcome: "SUCCEEDED",
			resultJobId: created.job.id,
		});
		expect(await client.creditReservation.count({ where: { jobId: created.job.id } })).toBe(1);
	});

	it("does not recover an exact-looking job without its credit reservation", async () => {
		const fixture = await createRetryFixture(client);
		const claimed = await claimGenerationRetryRequest(fixture.claimInput, client);
		if (claimed.outcome !== "CLAIMED") throw new Error("Expected a retry claim");
		const quote = await checkpointQuote(client, fixture, claimed);
		const job = await client.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId: fixture.ownerId,
				submittedByUserId: fixture.ownerId,
				quoteId: quote.id,
				idempotencyKey: fixture.idempotencyKey,
				productKey: fixture.operation.productKey,
				catalogVersion: fixture.operation.catalogVersion,
				pricingVersion: fixture.operation.pricingVersion,
				creditsReserved: BigInt(fixture.operation.credits),
				inputSnapshot: fixture.operation.normalizedInput,
				pricingSnapshot: fixture.operation.pricingSnapshot,
				status: "RESERVED",
			},
		});

		await expect(
			resumeGenerationRetryRequest(
				{ ...fixture.resumeInput, now: new Date(fixture.now.getTime() + 6 * 60_000) },
				client,
			),
		).resolves.toMatchObject({ outcome: "FAILED", errorCode: "IDEMPOTENCY_CONFLICT" });
		expect(await client.creditReservation.count({ where: { jobId: job.id } })).toBe(0);
	});

	it("does not recover an unrelated job with the same prompt but a different product", async () => {
		const fixture = await createRetryFixture(client, {
			prompt: "same prompt is not the same retry operation",
		});
		const claimed = await claimGenerationRetryRequest(fixture.claimInput, client);
		if (claimed.outcome !== "CLAIMED") throw new Error("Expected a retry claim");
		await checkpointQuote(client, fixture, claimed);
		const unrelatedOperation = buildOperation({
			sourceJobId: fixture.sourceJobId,
			prompt: fixture.prompt,
			productKey: "image-quality",
			credits: "8",
			costMicros: "12000",
		});
		const unrelatedQuote = await createApprovedQuote(client, fixture.ownerId, unrelatedOperation);
		await createGenerationJobTransaction(
			{
				ownerType: "USER",
				ownerId: fixture.ownerId,
				submittedByUserId: fixture.ownerId,
				quoteId: unrelatedQuote.id,
				idempotencyKey: fixture.idempotencyKey,
				inputAssetIds: [],
				expectedInputAssets: [],
				expectedModerationRuleVersion: TEXT_RULE,
			},
			client,
		);

		await expect(
			resumeGenerationRetryRequest(
				{ ...fixture.resumeInput, now: new Date(fixture.now.getTime() + 6 * 60_000) },
				client,
			),
		).resolves.toMatchObject({ outcome: "FAILED", errorCode: "IDEMPOTENCY_CONFLICT" });
	});

	it("reclaims the same durable quote checkpoint without creating another quote", async () => {
		const fixture = await createRetryFixture(client);
		const claimed = await claimGenerationRetryRequest(fixture.claimInput, client);
		if (claimed.outcome !== "CLAIMED") throw new Error("Expected a retry claim");
		const quote = await checkpointQuote(client, fixture, claimed);
		const quoteCount = await client.generationQuote.count({ where: { id: quote.id } });

		await expect(
			resumeGenerationRetryRequest(
				{ ...fixture.resumeInput, now: new Date(fixture.now.getTime() + 6 * 60_000) },
				client,
			),
		).resolves.toMatchObject({
			outcome: "CLAIMED",
			requestId: claimed.requestId,
			quoteId: quote.id,
			operation: fixture.operation,
		});
		expect(await client.generationQuote.count({ where: { id: quote.id } })).toBe(quoteCount);
	});

	it("reclaims an expired request when moderation never persisted a quote", async () => {
		const fixture = await createRetryFixture(client);
		const first = await claimGenerationRetryRequest(fixture.claimInput, client);
		if (first.outcome !== "CLAIMED") throw new Error("Expected the initial retry claim");

		const reclaimed = await resumeGenerationRetryRequest(
			{ ...fixture.resumeInput, now: new Date(fixture.now.getTime() + 6 * 60_000) },
			client,
		);
		expect(reclaimed).toMatchObject({
			outcome: "CLAIMED",
			requestId: first.requestId,
			operation: fixture.operation,
		});
		if (reclaimed?.outcome !== "CLAIMED") throw new Error("Expected an expired retry claim");
		expect(reclaimed.leaseToken).not.toBe(first.leaseToken);
		expect(reclaimed.quoteId).toBeUndefined();
	});

	it("replays the stored failure code without another operation claim", async () => {
		const fixture = await createRetryFixture(client);
		const claimed = await claimGenerationRetryRequest(fixture.claimInput, client);
		if (claimed.outcome !== "CLAIMED") throw new Error("Expected a retry claim");
		await failGenerationRetryRequest(
			{
				requestId: claimed.requestId,
				leaseToken: claimed.leaseToken,
				errorCode: "CONTENT_NOT_ALLOWED",
			},
			client,
		);

		await expect(resumeGenerationRetryRequest(fixture.resumeInput, client)).resolves.toMatchObject({
			outcome: "FAILED",
			errorCode: "CONTENT_NOT_ALLOWED",
		});
	});

	it("rejects completion with a dangling or unrelated result job", async () => {
		const fixture = await createRetryFixture(client);
		const claimed = await claimGenerationRetryRequest(fixture.claimInput, client);
		if (claimed.outcome !== "CLAIMED") throw new Error("Expected a retry claim");
		const quote = await checkpointQuote(client, fixture, claimed);

		await expect(
			completeGenerationRetryRequest(
				{
					requestId: claimed.requestId,
					leaseToken: claimed.leaseToken,
					quoteId: quote.id,
					resultJobId: `missing-result-${crypto.randomUUID()}`,
				},
				client,
			),
		).rejects.toThrow("GENERATION_RETRY_RESULT_MISMATCH");
		expect(
			await client.generationRetryRequest.findUniqueOrThrow({ where: { id: claimed.requestId } }),
		).toMatchObject({ status: "PROCESSING", resultJobId: null, quoteId: quote.id });
	});

	it("rejects a retry key that already belongs to an ordinary generation job", async () => {
		const fixture = await createRetryFixture(client);
		const quote = await createApprovedQuote(client, fixture.ownerId, fixture.operation);
		await createGenerationJobTransaction(
			{
				ownerType: "USER",
				ownerId: fixture.ownerId,
				submittedByUserId: fixture.ownerId,
				quoteId: quote.id,
				idempotencyKey: fixture.idempotencyKey,
				inputAssetIds: [],
				expectedInputAssets: [],
				expectedModerationRuleVersion: TEXT_RULE,
			},
			client,
		);

		await expect(claimGenerationRetryRequest(fixture.claimInput, client)).rejects.toThrow(
			"IDEMPOTENCY_CONFLICT",
		);
	});
});

async function createRetryFixture(
	client: PrismaClient,
	overrides: {
		prompt?: string;
		operation?: Partial<GenerationRetryOperation>;
	} = {},
) {
	const suffix = crypto.randomUUID();
	const ownerId = `retry-owner-${suffix}`;
	const sourceJobId = `source-job-${suffix}`;
	const idempotencyKey = `retry-operation-${suffix}`;
	const prompt = overrides.prompt ?? "recover the exact retry operation";
	const now = new Date();
	await createSourceJob(client, ownerId, sourceJobId, prompt);
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{ accountId: account.id, amount: 100n, referenceKey: `retry-grant-${suffix}` },
		client,
	);
	const operation = { ...buildOperation({ sourceJobId, prompt }), ...overrides.operation };
	return {
		ownerId,
		sourceJobId,
		idempotencyKey,
		prompt,
		now,
		operation,
		claimInput: {
			ownerType: "USER" as const,
			ownerId,
			submittedByUserId: ownerId,
			idempotencyKey,
			operation,
			now,
		},
		resumeInput: {
			ownerType: "USER" as const,
			ownerId,
			submittedByUserId: ownerId,
			sourceJobId,
			idempotencyKey,
			now,
		},
	};
}

function buildOperation(input: {
	sourceJobId: string;
	prompt: string;
	productKey?: string;
	credits?: string;
	costMicros?: string;
}): GenerationRetryOperation {
	return {
		sourceJobId: input.sourceJobId,
		productKey: input.productKey ?? "image-fast",
		normalizedInput: { kind: "text-to-image", prompt: input.prompt },
		inputAssets: [],
		catalogVersion: "2026-08-23.1",
		pricingVersion: "2026-08-23.1",
		credits: input.credits ?? "4",
		costMicros: input.costMicros ?? "3000",
		pricingSnapshot: { credits: Number(input.credits ?? "4") },
		moderationProvider: "test",
		moderationRuleVersion: TEXT_RULE,
		assetModerationRuleVersion: ASSET_RULE,
		assetModerationPolicyVersion: ASSET_POLICY,
	};
}

async function createSourceJob(
	client: PrismaClient,
	ownerId: string,
	sourceJobId: string,
	prompt: string,
) {
	const operation = buildOperation({ sourceJobId, prompt });
	const quote = await createApprovedQuote(client, ownerId, operation);
	return client.generationJob.create({
		data: {
			id: sourceJobId,
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: `source-operation-${crypto.randomUUID()}`,
			productKey: operation.productKey,
			catalogVersion: operation.catalogVersion,
			pricingVersion: operation.pricingVersion,
			creditsReserved: BigInt(operation.credits),
			inputSnapshot: operation.normalizedInput,
			pricingSnapshot: operation.pricingSnapshot,
			status: "FAILED",
			terminalAt: new Date(),
		},
	});
}

async function checkpointQuote(
	client: PrismaClient,
	fixture: Awaited<ReturnType<typeof createRetryFixture>>,
	claim: Extract<Awaited<ReturnType<typeof claimGenerationRetryRequest>>, { outcome: "CLAIMED" }>,
) {
	const quoteInput = quoteInputFor(fixture.ownerId, fixture.operation);
	return createGenerationRetryQuoteCheckpoint(
		{
			requestId: claim.requestId,
			leaseToken: claim.leaseToken,
			quote: {
				...quoteInput,
				moderation: {
					decision: "ALLOW",
					provider: fixture.operation.moderationProvider,
					ruleVersion: fixture.operation.moderationRuleVersion,
					reasonCode: "TEST_ALLOW",
					inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
				},
			},
		},
		client,
	);
}

async function createApprovedQuote(
	client: PrismaClient,
	ownerId: string,
	operation: GenerationRetryOperation,
) {
	const quoteInput = quoteInputFor(ownerId, operation);
	return createModeratedGenerationQuoteTransaction(
		{
			...quoteInput,
			moderation: {
				decision: "ALLOW",
				provider: operation.moderationProvider,
				ruleVersion: operation.moderationRuleVersion,
				reasonCode: "TEST_ALLOW",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
			},
		},
		client,
	);
}

function quoteInputFor(ownerId: string, operation: GenerationRetryOperation) {
	return {
		ownerType: "USER" as const,
		ownerId,
		submittedByUserId: ownerId,
		productKey: operation.productKey,
		catalogVersion: operation.catalogVersion,
		pricingVersion: operation.pricingVersion,
		credits: BigInt(operation.credits),
		costMicros: BigInt(operation.costMicros),
		inputSnapshot: operation.normalizedInput,
		pricingSnapshot: operation.pricingSnapshot,
		expiresAt: new Date(Date.now() + 10 * 60_000),
	};
}

async function createResultJob(
	client: PrismaClient,
	fixture: Awaited<ReturnType<typeof createRetryFixture>>,
	quoteId: string,
) {
	return createGenerationJobTransaction(
		{
			ownerType: "USER",
			ownerId: fixture.ownerId,
			submittedByUserId: fixture.ownerId,
			quoteId,
			idempotencyKey: fixture.idempotencyKey,
			inputAssetIds: [],
			expectedInputAssets: [],
			expectedModerationRuleVersion: fixture.operation.moderationRuleVersion,
			expectedAssetModerationRuleVersion: fixture.operation.assetModerationRuleVersion,
			expectedAssetModerationPolicyVersion: fixture.operation.assetModerationPolicyVersion,
		},
		client,
	);
}

function safeTestDatabaseUrl(value: string | undefined): string {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	if (
		!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
		!["55432", "55439"].includes(parsed.port) ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(parsed.pathname.slice(1).toLowerCase())
	) {
		throw new Error("TEST_DATABASE_URL must target a disposable local test database");
	}
	return value;
}
