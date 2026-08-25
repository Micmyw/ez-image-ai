import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { createCreditGrant, reserveCredits } from "./credits";
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

	it("recovers a root edit retry in the original session after a lost completion acknowledgement", async () => {
		const fixture = await createRootEditRetryFixture(client);
		const claimed = await claimGenerationRetryRequest(fixture.claimInput, client);
		if (claimed.outcome !== "CLAIMED") throw new Error("Expected a root retry claim");
		const quote = await checkpointQuote(client, fixture, claimed);
		const created = await createGenerationJobTransaction(
			{
				ownerType: "USER",
				ownerId: fixture.ownerId,
				submittedByUserId: fixture.ownerId,
				quoteId: quote.id,
				idempotencyKey: fixture.idempotencyKey,
				inputAssetIds: [fixture.assetId],
				expectedInputAssets: [{ assetId: fixture.assetId, assetChecksum: fixture.assetChecksum }],
				expectedModerationRuleVersion: TEXT_RULE,
				expectedAssetModerationRuleVersion: ASSET_RULE,
				expectedAssetModerationPolicyVersion: ASSET_POLICY,
				edit: fixture.operation.editContext,
			} as never,
			client,
		);

		await expect(
			resumeGenerationRetryRequest(
				{ ...fixture.resumeInput, now: new Date(fixture.now.getTime() + 6 * 60_000) },
				client,
			),
		).resolves.toMatchObject({ outcome: "SUCCEEDED", resultJobId: created.job.id });
		const [storedQuote, storedJob] = await Promise.all([
			client.generationQuote.findUniqueOrThrow({ where: { id: quote.id } }),
			client.generationJob.findUniqueOrThrow({ where: { id: created.job.id } }),
		]);
		expect(storedQuote.inputSnapshot).toMatchObject({ editContext: fixture.operation.editContext });
		expect(storedJob).toMatchObject({
			editSessionId: fixture.editSessionId,
			parentJobId: null,
		});
		expect(storedJob.inputSnapshot).toEqual(fixture.operation.normalizedInput);
		expect(await client.imageEditSession.count({ where: { ownerId: fixture.ownerId } })).toBe(1);
	});

	it("does not recover an edit retry result that detached from the frozen session", async () => {
		const fixture = await createRootEditRetryFixture(client);
		const claimed = await claimGenerationRetryRequest(fixture.claimInput, client);
		if (claimed.outcome !== "CLAIMED") throw new Error("Expected a root retry claim");
		const quote = await checkpointQuote(client, fixture, claimed);
		const detached = await client.generationJob.create({
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
			},
		});
		await reserveCredits(
			{
				accountId: fixture.accountId,
				jobId: detached.id,
				amount: BigInt(fixture.operation.credits),
				referenceKey: `detached-root-retry:${detached.id}:reserve`,
			},
			client,
		);
		await client.generationJobAsset.create({
			data: {
				jobId: detached.id,
				assetId: fixture.assetId,
				assetChecksum: fixture.assetChecksum,
				role: "INPUT",
				position: 0,
			},
		});

		await expect(
			resumeGenerationRetryRequest(
				{ ...fixture.resumeInput, now: new Date(fixture.now.getTime() + 6 * 60_000) },
				client,
			),
		).resolves.toMatchObject({ outcome: "FAILED", errorCode: "IDEMPOTENCY_CONFLICT" });
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

async function createRootEditRetryFixture(client: PrismaClient) {
	const suffix = crypto.randomUUID();
	const ownerId = `root-retry-owner-${suffix}`;
	const idempotencyKey = `root-retry-operation-${suffix}`;
	const now = new Date();
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{ accountId: account.id, amount: 40n, referenceKey: `root-retry-grant-${suffix}` },
		client,
	);
	const asset = await createRetryImageAsset(client, ownerId);
	const normalizedInput = {
		kind: "image-to-image" as const,
		prompt: `retry the failed root ${suffix}`,
		sourceAssetId: asset.id,
	};
	const originalQuoteInput = {
		ownerType: "USER" as const,
		ownerId,
		submittedByUserId: ownerId,
		productKey: "image-fast",
		catalogVersion: "2026-08-23.1",
		pricingVersion: "2026-08-23.1",
		credits: 4n,
		costMicros: 3_000n,
		inputSnapshot: {
			...normalizedInput,
			editContext: { kind: "ROOT", rootAssetId: asset.id },
		},
		pricingSnapshot: { credits: 4 },
		expiresAt: new Date(Date.now() + 10 * 60_000),
	};
	const originalQuote = await createModeratedGenerationQuoteTransaction(
		{
			...originalQuoteInput,
			moderation: {
				decision: "ALLOW",
				provider: "test",
				ruleVersion: TEXT_RULE,
				reasonCode: "TEST_ALLOW",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(originalQuoteInput),
			},
		},
		client,
	);
	const source = await createGenerationJobTransaction(
		{
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: originalQuote.id,
			idempotencyKey: `root-retry-source-${suffix}`,
			inputAssetIds: [asset.id],
			expectedInputAssets: [{ assetId: asset.id, assetChecksum: asset.checksum! }],
			expectedModerationRuleVersion: TEXT_RULE,
			expectedAssetModerationRuleVersion: ASSET_RULE,
			expectedAssetModerationPolicyVersion: ASSET_POLICY,
			edit: { kind: "ROOT", rootAssetId: asset.id },
		},
		client,
	);
	await client.generationJob.update({
		where: { id: source.job.id },
		data: { status: "FAILED", terminalAt: new Date() },
	});
	const sourceJob = await client.generationJob.findUniqueOrThrow({
		where: { id: source.job.id },
		select: { editSessionId: true },
	});
	if (!sourceJob.editSessionId) throw new Error("Root retry source has no edit session");
	const operation = {
		sourceJobId: source.job.id,
		productKey: "image-fast",
		normalizedInput,
		inputAssets: [{ assetId: asset.id, assetChecksum: asset.checksum! }],
		catalogVersion: "2026-08-23.1",
		pricingVersion: "2026-08-23.1",
		credits: "4",
		costMicros: "3000",
		pricingSnapshot: { credits: 4 },
		moderationProvider: "test",
		moderationRuleVersion: TEXT_RULE,
		assetModerationRuleVersion: ASSET_RULE,
		assetModerationPolicyVersion: ASSET_POLICY,
		editContext: {
			kind: "ROOT_RETRY" as const,
			editSessionId: sourceJob.editSessionId,
			rootAssetId: asset.id,
		},
	};
	return {
		ownerId,
		accountId: account.id,
		assetId: asset.id,
		assetChecksum: asset.checksum!,
		editSessionId: sourceJob.editSessionId,
		idempotencyKey,
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
			sourceJobId: source.job.id,
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
	fixture: { ownerId: string; operation: GenerationRetryOperation },
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
	const editContext = operation.editContext;
	const normalizedRecord =
		typeof operation.normalizedInput === "object" &&
		operation.normalizedInput !== null &&
		!Array.isArray(operation.normalizedInput)
			? operation.normalizedInput
			: null;
	return {
		ownerType: "USER" as const,
		ownerId,
		submittedByUserId: ownerId,
		productKey: operation.productKey,
		catalogVersion: operation.catalogVersion,
		pricingVersion: operation.pricingVersion,
		credits: BigInt(operation.credits),
		costMicros: BigInt(operation.costMicros),
		inputSnapshot:
			editContext && normalizedRecord
				? Object.assign({}, normalizedRecord, { editContext })
				: operation.normalizedInput,
		pricingSnapshot: operation.pricingSnapshot,
		expiresAt: new Date(Date.now() + 10 * 60_000),
	};
}

async function createRetryImageAsset(client: PrismaClient, ownerId: string) {
	const suffix = crypto.randomUUID();
	const checksum = suffix.replaceAll("-", "").repeat(2);
	const validUntil = new Date(Date.now() + 60 * 60_000);
	const asset = await client.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			objectKey: `users/${ownerId}/root-retry-${suffix}`,
			mimeType: "image/png",
			byteSize: 128n,
			checksum,
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "test",
			verificationRuleVersion: ASSET_RULE,
			verificationPolicyVersion: ASSET_POLICY,
			verificationValidUntil: validUntil,
		},
	});
	await client.assetModerationResult.create({
		data: {
			assetId: asset.id,
			assetChecksum: checksum,
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: "INPUT",
			provider: "test",
			ruleVersion: ASSET_RULE,
			policyVersion: ASSET_POLICY,
			status: "APPROVED",
			reasonCode: "TEST_ALLOW",
			categories: {},
			rawEnvelope: {},
			validUntil,
		},
	});
	return client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });
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
