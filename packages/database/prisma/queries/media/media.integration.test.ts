import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	claimOutboxBatch,
	completeOutboxEvent,
	createCreditGrant,
	createGenerationJobTransaction,
	createGenerationOutputAssetBindingTransaction,
	claimGenerationOutputTransferTransaction,
	completeGenerationOutputTransferTransaction,
	createModeratedGenerationQuoteTransaction,
	expireCreditLots,
	fingerprintGenerationQuoteSecurityPayload,
	createMediaAsset,
	createMediaUploadSessionTransaction,
	getCreditInvariantReport,
	getCommittedDailyGenerationCost,
	IdempotencyConflictError,
	ingestProviderEvent,
	listCreditReservationAllocations,
	listMediaAssets,
	markMediaAssetDeletedTransaction,
	recordGenerationOutputPromotionMultipartTransaction,
	refundCreditGrant,
	releaseOutboxEvent,
	releaseCredits,
	reserveCredits,
	settleCredits,
	transitionGenerationJob,
	abortMediaUploadSessionTransaction,
} from ".";
import { PrismaClient } from "../../generated/client";
import type { CreateGenerationQuoteInput } from "./types";

const TEST_MODERATION_RULE_VERSION = "TEST_ALLOW_DATABASE_INTEGRATION_V1";

async function createApprovedQuote(client: PrismaClient, input: CreateGenerationQuoteInput) {
	return createModeratedGenerationQuoteTransaction(
		{
			...input,
			moderation: {
				decision: "ALLOW",
				provider: "test",
				ruleVersion: TEST_MODERATION_RULE_VERSION,
				reasonCode: "TEST_ALLOW_DATABASE_INTEGRATION",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(input),
			},
		},
		client,
	);
}

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;

interface SerializableAttemptObservation {
	attempt: number;
	outcome: "STARTED" | "SERIALIZATION_CONFLICT";
}

async function waitForAdvisoryLock(
	client: PrismaClient,
	classId: number,
	objectId: number,
): Promise<boolean> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const rows = await client.$queryRaw<Array<{ locked: boolean }>>`
			SELECT EXISTS (
				SELECT 1 FROM pg_locks
				WHERE locktype = 'advisory'
				  AND classid = ${classId}::oid
				  AND objid = ${objectId}::oid
				  AND granted
			) AS locked`;
		if (rows[0]?.locked) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return false;
}

async function createReservedCreditsFixture(
	client: PrismaClient,
	input: { grantAmount: bigint; reserveAmount: bigint; expiresAt?: Date },
) {
	const ownerId = `test-user-${crypto.randomUUID()}`;
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	const grantReferenceKey = `test-grant-${crypto.randomUUID()}`;
	await createCreditGrant(
		{
			accountId: account.id,
			amount: input.grantAmount,
			referenceKey: grantReferenceKey,
			expiresAt: input.expiresAt,
		},
		client,
	);
	const quote = await createApprovedQuote(client, {
		ownerType: "USER",
		ownerId,
		submittedByUserId: ownerId,
		productKey: "test-product",
		catalogVersion: "test-v1",
		pricingVersion: "test-v1",
		credits: input.reserveAmount,
		costMicros: 0n,
		inputSnapshot: { kind: "text-to-image", prompt: "review regression" },
		pricingSnapshot: {},
		expiresAt: new Date(Date.now() + 60_000),
	});
	const created = await createGenerationJobTransaction(
		{
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: `test-job-${crypto.randomUUID()}`,
			inputAssetIds: [],
			expectedModerationRuleVersion: TEST_MODERATION_RULE_VERSION,
		},
		client,
	);
	return { ownerId, account, grantReferenceKey, ...created };
}

async function createBudgetFixture(client: PrismaClient, costs: bigint[]) {
	const ownerId = `budget-user-${crypto.randomUUID()}`;
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{
			accountId: account.id,
			amount: 1_000n,
			referenceKey: `budget-grant-${crypto.randomUUID()}`,
		},
		client,
	);
	const quotes = await Promise.all(
		costs.map((costMicros, index) =>
			createApprovedQuote(client, {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				productKey: "image-fast",
				catalogVersion: "test-v1",
				pricingVersion: "test-v1",
				credits: 4n,
				costMicros,
				inputSnapshot: { kind: "text-to-image", prompt: `budget-${index}` },
				pricingSnapshot: {},
				expiresAt: new Date(Date.now() + 60_000),
			}),
		),
	);
	return { ownerId, quotes };
}

async function approveReadyAssetForTest(
	client: PrismaClient,
	input: { assetId: string; kind: "INPUT" | "OUTPUT"; checksum?: string },
) {
	const checksum = input.checksum ?? crypto.randomUUID().replaceAll("-", "").repeat(2);
	const verificationValidUntil = new Date(Date.now() + 60 * 60_000);
	await client.mediaAsset.update({
		where: { id: input.assetId },
		data: {
			status: "VERIFYING",
			checksum,
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "test",
			verificationRuleVersion: "asset-binding-rule-v1",
			verificationPolicyVersion: "asset-binding-policy-v1",
			verificationValidUntil,
		},
	});
	await client.assetModerationResult.create({
		data: {
			assetId: input.assetId,
			assetChecksum: checksum,
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: input.kind,
			provider: "test",
			ruleVersion: "asset-binding-rule-v1",
			policyVersion: "asset-binding-policy-v1",
			status: "APPROVED",
			reasonCode: "TEST_ALLOW_ASSET_BINDING",
			categories: {},
			rawEnvelope: { decision: "ALLOW" },
			validUntil: verificationValidUntil,
		},
	});
	return client.mediaAsset.update({
		where: { id: input.assetId },
		data: { status: "READY" },
	});
}

async function createReadyInputAssetFixture(client: PrismaClient) {
	const ownerId = `asset-binding-user-${crypto.randomUUID()}`;
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{
			accountId: account.id,
			amount: 20n,
			referenceKey: `asset-binding-grant-${crypto.randomUUID()}`,
		},
		client,
	);
	const asset = await createMediaAsset(
		{
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			objectKey: `users/${ownerId}/assets/${crypto.randomUUID()}/original.png`,
			mimeType: "image/png",
			byteSize: 10n,
		},
		client,
	);
	const checksum = "a".repeat(64);
	const verificationValidUntil = new Date(Date.now() + 60 * 60_000);
	await client.mediaAsset.update({
		where: { id: asset.id },
		data: {
			status: "VERIFYING",
			checksum,
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "test",
			verificationRuleVersion: "asset-binding-rule-v1",
			verificationPolicyVersion: "asset-binding-policy-v1",
			verificationValidUntil,
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
			ruleVersion: "asset-binding-rule-v1",
			policyVersion: "asset-binding-policy-v1",
			status: "APPROVED",
			reasonCode: "TEST_ALLOW_ASSET_BINDING",
			categories: {},
			rawEnvelope: { decision: "ALLOW" },
			validUntil: verificationValidUntil,
		},
	});
	const readyAsset = await client.mediaAsset.update({
		where: { id: asset.id },
		data: { status: "READY" },
	});
	const quote = await createApprovedQuote(client, {
		ownerType: "USER",
		ownerId,
		submittedByUserId: ownerId,
		productKey: "image-fast",
		catalogVersion: "test-v1",
		pricingVersion: "test-v1",
		credits: 4n,
		costMicros: 0n,
		inputSnapshot: { kind: "image-to-image", prompt: "asset binding regression" },
		pricingSnapshot: {},
		expiresAt: new Date(Date.now() + 60_000),
	});
	return {
		ownerId,
		asset: readyAsset,
		createJob: (idempotencyKey = `asset-binding-job-${crypto.randomUUID()}`) =>
			createGenerationJobTransaction(
				{
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					quoteId: quote.id,
					idempotencyKey,
					inputAssetIds: [readyAsset.id],
					expectedModerationRuleVersion: TEST_MODERATION_RULE_VERSION,
					expectedAssetModerationRuleVersion: "asset-binding-rule-v1",
					expectedAssetModerationPolicyVersion: "asset-binding-policy-v1",
				},
				client,
			),
	};
}

function assertSafeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) {
		throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	}
	if (DATABASE_URL && TEST_DATABASE_URL === DATABASE_URL) {
		throw new Error("UNSAFE_TEST_DATABASE: TEST_DATABASE_URL must not equal DATABASE_URL");
	}

	const parsed = new URL(TEST_DATABASE_URL);
	const databaseName = parsed.pathname.slice(1).toLowerCase();
	const looksLocal = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
	const looksTestOnly = /(^|[_-])(test|testing)([_-]|$)/.test(databaseName);
	if (!looksLocal || !looksTestOnly) {
		throw new Error(
			"UNSAFE_TEST_DATABASE: use a local database whose name contains test or testing",
		);
	}
	return TEST_DATABASE_URL;
}

describe("media PostgreSQL transactions", () => {
	let client: PrismaClient;

	beforeAll(async () => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: assertSafeTestDatabaseUrl() }),
		});
	});

	afterAll(async () => {
		await client?.$disconnect();
	});

	it("never commits concurrent reservations beyond FIFO lot availability", async () => {
		const ownerId = `test-user-${crypto.randomUUID()}`;
		const account = await client.creditAccount.create({
			data: { ownerType: "USER", ownerId },
		});
		await createCreditGrant(
			{
				accountId: account.id,
				amount: 100n,
				referenceKey: `test-grant-${crypto.randomUUID()}`,
			},
			client,
		);

		const quoteInputs = await Promise.all(
			[0, 1].map((index) =>
				createApprovedQuote(client, {
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					productKey: "image-quality",
					catalogVersion: "test-v1",
					pricingVersion: "test-v1",
					credits: 80n,
					costMicros: 0n,
					inputSnapshot: { kind: "text-to-image", prompt: `test-${index}` },
					pricingSnapshot: {},
					expiresAt: new Date(Date.now() + 60_000),
				}),
			),
		);

		const attempts = await Promise.allSettled(
			quoteInputs.map((quote, index) =>
				createGenerationJobTransaction(
					{
						ownerType: "USER",
						ownerId,
						submittedByUserId: ownerId,
						quoteId: quote.id,
						idempotencyKey: `test-reserve-${index}-${crypto.randomUUID()}`,
						inputAssetIds: [],
						expectedModerationRuleVersion: TEST_MODERATION_RULE_VERSION,
					},
					client,
				),
			),
		);

		const successfulReservations = attempts
			.filter((item) => item.status === "fulfilled")
			.map((item) => item.value.reservation.amount);
		expect(successfulReservations.reduce((sum, amount) => sum + amount, 0n)).toBeLessThanOrEqual(
			100n,
		);
		expect(await getCreditInvariantReport(account.id, client)).toMatchObject({ valid: true });
	});

	it("does not count abandoned quotes toward committed daily generation cost", async () => {
		const ownerId = `budget-abandoned-${crypto.randomUUID()}`;
		await client.generationQuote.createMany({
			data: Array.from({ length: 100 }, (_, index) => ({
				ownerType: "USER" as const,
				ownerId,
				submittedByUserId: ownerId,
				productKey: "image-fast",
				catalogVersion: "test-v1",
				pricingVersion: "test-v1",
				credits: 4n,
				costMicros: 60n,
				inputSnapshot: { kind: "text-to-image", prompt: `abandoned-${index}` },
				pricingSnapshot: {},
				expiresAt: new Date(Date.now() + 60_000),
			})),
		});
		expect(await getCommittedDailyGenerationCost({ ownerType: "USER", ownerId }, client)).toBe(0n);
	});

	it("commits quote cost once and idempotent replay does not consume budget twice", async () => {
		const fixture = await createBudgetFixture(client, [60n]);
		const input = {
			ownerType: "USER" as const,
			ownerId: fixture.ownerId,
			submittedByUserId: fixture.ownerId,
			quoteId: fixture.quotes[0]!.id,
			idempotencyKey: `budget-once-${crypto.randomUUID()}`,
			inputAssetIds: [],
			expectedModerationRuleVersion: TEST_MODERATION_RULE_VERSION,
			maximumDailyCostMicros: 100n,
		};
		const created = await createGenerationJobTransaction(input, client);
		const replay = await createGenerationJobTransaction(input, client);
		expect(replay).toMatchObject({ job: { id: created.job.id }, replayed: true });
		expect(
			await getCommittedDailyGenerationCost(
				{ ownerType: "USER", ownerId: fixture.ownerId },
				client,
			),
		).toBe(60n);
	});

	it("allows only one concurrent generation when two candidates would exceed the daily cap", async () => {
		const fixture = await createBudgetFixture(client, [60n, 60n]);
		const results = await Promise.allSettled(
			fixture.quotes.map((quote, index) =>
				createGenerationJobTransaction(
					{
						ownerType: "USER",
						ownerId: fixture.ownerId,
						submittedByUserId: fixture.ownerId,
						quoteId: quote.id,
						idempotencyKey: `budget-concurrent-${index}-${crypto.randomUUID()}`,
						inputAssetIds: [],
						expectedModerationRuleVersion: TEST_MODERATION_RULE_VERSION,
						maximumDailyCostMicros: 100n,
					},
					client,
				),
			),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.filter((result) => result.status === "rejected");
		expect(rejected).toHaveLength(1);
		expect(rejected[0]!.reason).toMatchObject({ message: "BUDGET_EXCEEDED" });
		expect(
			await getCommittedDailyGenerationCost(
				{ ownerType: "USER", ownerId: fixture.ownerId },
				client,
			),
		).toBe(60n);
	});

	it("settles a reservation only once", async () => {
		const reservation = await client.creditReservation.findFirstOrThrow({
			where: { status: "ACTIVE" },
		});
		const first = await settleCredits(
			{
				reservationId: reservation.id,
				amount: reservation.amount,
				referenceKey: `test-settle-${reservation.id}`,
			},
			client,
		);
		const replay = await settleCredits(
			{
				reservationId: reservation.id,
				amount: reservation.amount,
				referenceKey: `test-settle-${reservation.id}`,
			},
			client,
		);
		expect(replay).toEqual(first);
	});

	it("returns the original job and reservation for a duplicate owner idempotency key", async () => {
		const ownerId = `test-user-${crypto.randomUUID()}`;
		const account = await client.creditAccount.create({
			data: { ownerType: "USER", ownerId },
		});
		await createCreditGrant(
			{ accountId: account.id, amount: 40n, referenceKey: `test-grant-${ownerId}` },
			client,
		);
		const quote = await createApprovedQuote(client, {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-fast",
			catalogVersion: "test-v1",
			pricingVersion: "test-v1",
			credits: 4n,
			costMicros: 0n,
			inputSnapshot: { kind: "text-to-image", prompt: "duplicate" },
			pricingSnapshot: {},
			expiresAt: new Date(Date.now() + 60_000),
		});
		const input = {
			ownerType: "USER" as const,
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: `test-job-${crypto.randomUUID()}`,
			inputAssetIds: [],
			expectedModerationRuleVersion: TEST_MODERATION_RULE_VERSION,
		};
		const created = await createGenerationJobTransaction(input, client);
		const replay = await createGenerationJobTransaction(input, client);
		expect(replay).toMatchObject({
			job: { id: created.job.id },
			reservation: { id: created.reservation.id },
			replayed: true,
		});
		expect(
			await client.outboxEvent.count({ where: { dedupeKey: `job:${created.job.id}:created` } }),
		).toBe(1);

		const applied = await transitionGenerationJob(
			{
				jobId: created.job.id,
				expectedStatuses: ["RESERVED"],
				expectedVersion: created.job.version,
				nextStatus: "DISPATCH_QUEUED",
			},
			client,
		);
		const stale = await transitionGenerationJob(
			{
				jobId: created.job.id,
				expectedStatuses: ["RESERVED"],
				expectedVersion: created.job.version,
				nextStatus: "DISPATCH_QUEUED",
			},
			client,
		);
		expect(applied.applied).toBe(true);
		expect(stale).toMatchObject({ applied: false, job: { status: "DISPATCH_QUEUED", version: 1 } });
	});

	it("rejects reuse of a generation idempotency key with a different quote", async () => {
		const fixture = await createBudgetFixture(client, [10n, 10n]);
		const idempotencyKey = `quote-conflict-${crypto.randomUUID()}`;
		await createGenerationJobTransaction(
			{
				ownerType: "USER",
				ownerId: fixture.ownerId,
				submittedByUserId: fixture.ownerId,
				quoteId: fixture.quotes[0]!.id,
				idempotencyKey,
				inputAssetIds: [],
				expectedModerationRuleVersion: TEST_MODERATION_RULE_VERSION,
			},
			client,
		);

		await expect(
			createGenerationJobTransaction(
				{
					ownerType: "USER",
					ownerId: fixture.ownerId,
					submittedByUserId: fixture.ownerId,
					quoteId: fixture.quotes[1]!.id,
					idempotencyKey,
					inputAssetIds: [],
					expectedModerationRuleVersion: TEST_MODERATION_RULE_VERSION,
				},
				client,
			),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
	});

	it("allocates reservations from earliest-expiring lots first", async () => {
		const ownerId = `test-user-${crypto.randomUUID()}`;
		const account = await client.creditAccount.create({
			data: { ownerType: "USER", ownerId },
		});
		const later = await createCreditGrant(
			{
				accountId: account.id,
				amount: 20n,
				referenceKey: `test-later-${ownerId}`,
				expiresAt: new Date(Date.now() + 120_000),
			},
			client,
		);
		const sooner = await createCreditGrant(
			{
				accountId: account.id,
				amount: 10n,
				referenceKey: `test-sooner-${ownerId}`,
				expiresAt: new Date(Date.now() + 60_000),
			},
			client,
		);
		const quote = await createApprovedQuote(client, {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "video-fast",
			catalogVersion: "test-v1",
			pricingVersion: "test-v1",
			credits: 25n,
			costMicros: 0n,
			inputSnapshot: { kind: "text-to-video", prompt: "fifo" },
			pricingSnapshot: {},
			expiresAt: new Date(Date.now() + 60_000),
		});
		const result = await createGenerationJobTransaction(
			{
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				quoteId: quote.id,
				idempotencyKey: `test-fifo-${crypto.randomUUID()}`,
				inputAssetIds: [],
				expectedModerationRuleVersion: TEST_MODERATION_RULE_VERSION,
			},
			client,
		);
		const allocations = await listCreditReservationAllocations(result.reservation.id, client);
		expect(allocations.map(({ lot, amount }) => [lot.id, amount])).toEqual([
			[sooner.lotId, 10n],
			[later.lotId, 15n],
		]);
	});

	it("records one provider envelope and one outbox event for duplicate delivery", async () => {
		const providerEventId = `test-provider-event-${crypto.randomUUID()}`;
		const input = {
			provider: "replicate",
			providerEventId,
			providerTaskId: `test-task-${crypto.randomUUID()}`,
			verifiedAt: new Date(),
			envelope: { status: "succeeded" },
		};
		const created = await ingestProviderEvent(input, client);
		const replay = await ingestProviderEvent(input, client);
		expect(created.replayed).toBe(false);
		expect(replay).toMatchObject({ event: { id: created.event.id }, replayed: true });
		expect(
			await client.outboxEvent.count({
				where: { dedupeKey: `provider-event:replicate:${providerEventId}` },
			}),
		).toBe(1);
	});

	it("recovers expired outbox leases and dead-letters after bounded attempts", async () => {
		const dedupeKey = `test-outbox-${crypto.randomUUID()}`;
		await client.outboxEvent.create({
			data: {
				eventType: "TEST_EVENT",
				aggregateType: "TEST",
				aggregateId: dedupeKey,
				dedupeKey,
				payload: {},
				availableAt: new Date(0),
			},
		});
		const first = await claimOutboxBatch(
			{ workerId: "test-worker-a", limit: 100, leaseSeconds: 1 },
			client,
		);
		const claimed = first.find((item) => item.dedupeKey === dedupeKey)!;
		expect(claimed.attempts).toBe(1);
		const recovered = await claimOutboxBatch(
			{
				workerId: "test-worker-b",
				limit: 100,
				leaseSeconds: 30,
				now: new Date(Date.now() + 2_000),
			},
			client,
		);
		expect(recovered.find((item) => item.id === claimed.id)?.attempts).toBe(2);
		await releaseOutboxEvent(
			{
				id: claimed.id,
				workerId: "test-worker-b",
				leaseToken: recovered.find((item) => item.id === claimed.id)!.leaseToken,
				error: "test failure",
				maxAttempts: 2,
				retryAt: new Date(),
			},
			client,
		);
		expect(await client.outboxEvent.findUnique({ where: { id: claimed.id } })).toMatchObject({
			status: "DEAD_LETTER",
			attempts: 2,
		});
	});

	it("turns grant refund shortage into debt and repays debt before new spendable credits", async () => {
		const ownerId = `test-user-${crypto.randomUUID()}`;
		const account = await client.creditAccount.create({
			data: { ownerType: "USER", ownerId },
		});
		const grantReferenceKey = `test-refundable-${ownerId}`;
		await createCreditGrant(
			{ accountId: account.id, amount: 10n, referenceKey: grantReferenceKey },
			client,
		);
		await refundCreditGrant(
			{
				accountId: account.id,
				amount: 15n,
				grantReferenceKey,
				referenceKey: `test-refund-${ownerId}`,
			},
			client,
		);
		expect(await client.creditAccount.findUnique({ where: { id: account.id } })).toMatchObject({
			spendableCredits: 0n,
			creditDebt: 5n,
		});
		await createCreditGrant(
			{ accountId: account.id, amount: 8n, referenceKey: `test-repay-${ownerId}` },
			client,
		);
		expect(await client.creditAccount.findUnique({ where: { id: account.id } })).toMatchObject({
			spendableCredits: 3n,
			creditDebt: 0n,
		});
	});

	it("rejects a generation transaction with outstanding debt without committing job side effects", async () => {
		const ownerId = `debt-gate-${crypto.randomUUID()}`;
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		await createCreditGrant(
			{
				accountId: account.id,
				amount: 10n,
				referenceKey: `debt-gate-grant-${crypto.randomUUID()}`,
			},
			client,
		);
		await client.creditAccount.update({ where: { id: account.id }, data: { creditDebt: 1n } });
		const quote = await createApprovedQuote(client, {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-fast",
			catalogVersion: "test-v1",
			pricingVersion: "test-v1",
			credits: 4n,
			costMicros: 0n,
			inputSnapshot: { kind: "text-to-image", prompt: "debt gate" },
			pricingSnapshot: {},
			expiresAt: new Date(Date.now() + 60_000),
		});
		const jobsCreatedBefore = await client.outboxEvent.count({
			where: { eventType: "JOB_CREATED" },
		});

		await expect(
			createGenerationJobTransaction(
				{
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					quoteId: quote.id,
					idempotencyKey: `debt-gate-job-${crypto.randomUUID()}`,
					inputAssetIds: [],
					expectedModerationRuleVersion: TEST_MODERATION_RULE_VERSION,
				},
				client,
			),
		).rejects.toThrow("CREDIT_DEBT_OUTSTANDING");
		expect(await client.generationJob.count({ where: { ownerId } })).toBe(0);
		expect(await client.creditReservation.count({ where: { accountId: account.id } })).toBe(0);
		expect(await client.outboxEvent.count({ where: { eventType: "JOB_CREATED" } })).toBe(
			jobsCreatedBefore,
		);
	});

	it("incurs debt when a refunded active reservation later settles", async () => {
		const fixture = await createReservedCreditsFixture(client, {
			grantAmount: 10n,
			reserveAmount: 10n,
		});
		await refundCreditGrant(
			{
				accountId: fixture.account.id,
				amount: 10n,
				grantReferenceKey: fixture.grantReferenceKey,
				referenceKey: `test-refund-settle-${crypto.randomUUID()}`,
			},
			client,
		);
		const settlement = {
			reservationId: fixture.reservation.id,
			amount: 10n,
			referenceKey: `test-settle-refunded-${crypto.randomUUID()}`,
		};
		await settleCredits(settlement, client);
		await settleCredits(settlement, client);

		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: fixture.account.id } }),
		).toMatchObject({
			creditDebt: 10n,
		});
		expect(
			await client.creditLedgerEntry.aggregate({
				where: { accountId: fixture.account.id, type: "DEBT_INCURRED" },
				_sum: { amount: true },
			}),
		).toMatchObject({ _sum: { amount: 10n } });
	});

	it("preserves refunded settlement debt when refund and settlement overlap", async () => {
		const fixture = await createReservedCreditsFixture(client, {
			grantAmount: 10n,
			reserveAmount: 10n,
		});
		await Promise.all([
			refundCreditGrant(
				{
					accountId: fixture.account.id,
					amount: 10n,
					grantReferenceKey: fixture.grantReferenceKey,
					referenceKey: `test-concurrent-refund-${crypto.randomUUID()}`,
				},
				client,
			),
			settleCredits(
				{
					reservationId: fixture.reservation.id,
					amount: 10n,
					referenceKey: `test-concurrent-settle-${crypto.randomUUID()}`,
				},
				client,
			),
		]);

		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: fixture.account.id } }),
		).toMatchObject({ creditDebt: 10n, reservedCredits: 0n, spendableCredits: 0n });
		expect(await getCreditInvariantReport(fixture.account.id, client)).toMatchObject({
			valid: true,
		});
	});

	it("makes partial settlement and refund order financially equivalent", async () => {
		const runSequence = async (settleAmount: bigint, settleFirst: boolean) => {
			const fixture = await createReservedCreditsFixture(client, {
				grantAmount: 10n,
				reserveAmount: 10n,
			});
			const refund = () =>
				refundCreditGrant(
					{
						accountId: fixture.account.id,
						amount: 5n,
						grantReferenceKey: fixture.grantReferenceKey,
						referenceKey: `partial-order-refund-${crypto.randomUUID()}`,
					},
					client,
				);
			const settle = () =>
				settleCredits(
					{
						reservationId: fixture.reservation.id,
						amount: settleAmount,
						referenceKey: `partial-order-settle-${crypto.randomUUID()}`,
					},
					client,
				);
			if (settleFirst) {
				await settle();
				await refund();
			} else {
				await refund();
				await settle();
			}
			return client.creditAccount.findUniqueOrThrow({ where: { id: fixture.account.id } });
		};

		const refundThenSettleFive = await runSequence(5n, false);
		const settleThenRefundFive = await runSequence(5n, true);
		const refundThenSettleEight = await runSequence(8n, false);
		const settleThenRefundEight = await runSequence(8n, true);

		expect(refundThenSettleFive).toMatchObject({
			spendableCredits: 0n,
			reservedCredits: 0n,
			creditDebt: 0n,
		});
		expect(settleThenRefundFive).toMatchObject({
			spendableCredits: 0n,
			reservedCredits: 0n,
			creditDebt: 0n,
		});
		expect(refundThenSettleEight).toMatchObject({
			spendableCredits: 0n,
			reservedCredits: 0n,
			creditDebt: 3n,
		});
		expect(settleThenRefundEight).toMatchObject({
			spendableCredits: 0n,
			reservedCredits: 0n,
			creditDebt: 3n,
		});
	});

	it("preserves FIFO settlement allocation identity across refunded lots", async () => {
		const createTwoLotFixture = async () => {
			const ownerId = `fifo-refund-${crypto.randomUUID()}`;
			const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
			const grantA = await createCreditGrant(
				{
					accountId: account.id,
					amount: 5n,
					referenceKey: `fifo-refund-a-${crypto.randomUUID()}`,
					expiresAt: new Date(Date.now() + 60_000),
				},
				client,
			);
			const grantB = await createCreditGrant(
				{
					accountId: account.id,
					amount: 5n,
					referenceKey: `fifo-refund-b-${crypto.randomUUID()}`,
					expiresAt: new Date(Date.now() + 120_000),
				},
				client,
			);
			const quote = await createApprovedQuote(client, {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				productKey: "image-fast",
				catalogVersion: "test-v1",
				pricingVersion: "test-v1",
				credits: 10n,
				costMicros: 0n,
				inputSnapshot: { kind: "text-to-image", prompt: "fifo refunded settlement" },
				pricingSnapshot: {},
				expiresAt: new Date(Date.now() + 60_000),
			});
			const { reservation } = await createGenerationJobTransaction(
				{
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					quoteId: quote.id,
					idempotencyKey: `fifo-refund-job-${crypto.randomUUID()}`,
					inputAssetIds: [],
					expectedModerationRuleVersion: TEST_MODERATION_RULE_VERSION,
				},
				client,
			);
			const aLotId = grantA.lotId;
			if (!aLotId || !grantB.lotId) throw new Error("Test grants must create credit lots");
			await client.creditLot.update({
				where: { id: aLotId },
				data: { expiresAt: new Date(Date.now() - 60_000) },
			});
			return { account, grantA, grantB, reservation, aLotId };
		};

		const runSequence = async (refundLot: "A" | "B", settleFirst: boolean) => {
			const fixture = await createTwoLotFixture();
			const grant = refundLot === "A" ? fixture.grantA : fixture.grantB;
			const refund = () =>
				refundCreditGrant(
					{
						accountId: fixture.account.id,
						amount: 5n,
						grantReferenceKey: grant.referenceKey,
						referenceKey: `fifo-refund-command-${crypto.randomUUID()}`,
					},
					client,
				);
			const settle = () =>
				settleCredits(
					{
						reservationId: fixture.reservation.id,
						amount: 5n,
						referenceKey: `fifo-settle-command-${crypto.randomUUID()}`,
					},
					client,
				);
			if (settleFirst) {
				await settle();
				await refund();
			} else {
				await refund();
				await settle();
			}
			const allocations = await listCreditReservationAllocations(fixture.reservation.id, client);
			return {
				aLotId: fixture.aLotId,
				account: await client.creditAccount.findUniqueOrThrow({
					where: { id: fixture.account.id },
				}),
				allocations: allocations.map(({ lot, settledAmount, releasedAmount }) => ({
					lotId: lot.id,
					settledAmount,
					releasedAmount,
				})),
				invariant: await getCreditInvariantReport(fixture.account.id, client),
			};
		};

		const refundAThenSettle = await runSequence("A", false);
		const settleThenRefundA = await runSequence("A", true);
		const refundBThenSettle = await runSequence("B", false);
		const settleThenRefundB = await runSequence("B", true);

		for (const result of [refundAThenSettle, settleThenRefundA]) {
			expect(result.account).toMatchObject({
				spendableCredits: 5n,
				reservedCredits: 0n,
				creditDebt: 5n,
			});
			expect(
				result.allocations.map(({ settledAmount, releasedAmount }) => [
					settledAmount,
					releasedAmount,
				]),
			).toEqual([
				[5n, 0n],
				[0n, 5n],
			]);
			expect(
				result.allocations
					.filter(({ settledAmount }) => settledAmount > 0n)
					.map(({ lotId }) => lotId),
			).toEqual([result.aLotId]);
			expect(result.invariant).toMatchObject({ valid: true });
		}
		for (const result of [refundBThenSettle, settleThenRefundB]) {
			expect(result.account).toMatchObject({
				spendableCredits: 0n,
				reservedCredits: 0n,
				creditDebt: 0n,
			});
			expect(
				result.allocations.map(({ settledAmount, releasedAmount }) => [
					settledAmount,
					releasedAmount,
				]),
			).toEqual([
				[5n, 0n],
				[0n, 5n],
			]);
			expect(
				result.allocations
					.filter(({ settledAmount }) => settledAmount > 0n)
					.map(({ lotId }) => lotId),
			).toEqual([result.aLotId]);
			expect(result.invariant).toMatchObject({ valid: true });
		}
	});

	it("materializes an expired lot once with an immutable expiry ledger entry", async () => {
		const ownerId = `expiry-command-${crypto.randomUUID()}`;
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		await createCreditGrant(
			{ accountId: account.id, amount: 10n, referenceKey: `expiry-grant-${crypto.randomUUID()}` },
			client,
		);
		const lot = await client.creditLot.findFirstOrThrow({ where: { accountId: account.id } });
		await client.creditLot.update({
			where: { id: lot.id },
			data: { expiresAt: new Date(Date.now() - 60_000) },
		});

		expect(await expireCreditLots({ accountId: account.id }, client)).toBe(10n);
		expect(await expireCreditLots({ accountId: account.id }, client)).toBe(0n);
		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: account.id } }),
		).toMatchObject({
			spendableCredits: 0n,
		});
		expect(
			await client.creditLedgerEntry.findMany({
				where: { accountId: account.id, type: "EXPIRE" },
			}),
		).toHaveLength(1);
	});

	it("refunds expired unspent credits without debt and permits a later reservation", async () => {
		const ownerId = `expired-refund-${crypto.randomUUID()}`;
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		const grantReferenceKey = `expired-refund-grant-${crypto.randomUUID()}`;
		await createCreditGrant(
			{ accountId: account.id, amount: 10n, referenceKey: grantReferenceKey },
			client,
		);
		const lot = await client.creditLot.findFirstOrThrow({ where: { accountId: account.id } });
		await client.creditLot.update({
			where: { id: lot.id },
			data: { expiresAt: new Date(Date.now() - 60_000) },
		});
		await expireCreditLots({ accountId: account.id }, client);
		await refundCreditGrant(
			{
				accountId: account.id,
				amount: 10n,
				grantReferenceKey,
				referenceKey: `expired-refund-${crypto.randomUUID()}`,
			},
			client,
		);
		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: account.id } }),
		).toMatchObject({
			creditDebt: 0n,
		});

		await createCreditGrant(
			{
				accountId: account.id,
				amount: 4n,
				referenceKey: `after-expiry-grant-${crypto.randomUUID()}`,
			},
			client,
		);
		const quote = await createApprovedQuote(client, {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-fast",
			catalogVersion: "test-v1",
			pricingVersion: "test-v1",
			credits: 4n,
			costMicros: 0n,
			inputSnapshot: { kind: "text-to-image", prompt: "expired refund recovery" },
			pricingSnapshot: {},
			expiresAt: new Date(Date.now() + 60_000),
		});
		await expect(
			createGenerationJobTransaction(
				{
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					quoteId: quote.id,
					idempotencyKey: `after-expiry-job-${crypto.randomUUID()}`,
					inputAssetIds: [],
					expectedModerationRuleVersion: TEST_MODERATION_RULE_VERSION,
				},
				client,
			),
		).resolves.toMatchObject({ reservation: { amount: 4n } });
	});

	it("applies partial expired refunds only to expired unrefunded credits", async () => {
		const ownerId = `expired-partial-refund-${crypto.randomUUID()}`;
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		const grantReferenceKey = `expired-partial-grant-${crypto.randomUUID()}`;
		await createCreditGrant(
			{ accountId: account.id, amount: 10n, referenceKey: grantReferenceKey },
			client,
		);
		const lot = await client.creditLot.findFirstOrThrow({ where: { accountId: account.id } });
		await client.creditLot.update({
			where: { id: lot.id },
			data: { expiresAt: new Date(Date.now() - 60_000) },
		});
		await expireCreditLots({ accountId: account.id }, client);
		for (const amount of [4n, 3n, 3n]) {
			await refundCreditGrant(
				{
					accountId: account.id,
					amount,
					grantReferenceKey,
					referenceKey: `expired-partial-refund-${amount}-${crypto.randomUUID()}`,
				},
				client,
			);
		}
		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: account.id } }),
		).toMatchObject({
			creditDebt: 0n,
			spendableCredits: 0n,
		});
		expect(await getCreditInvariantReport(account.id, client)).toMatchObject({ valid: true });
	});

	it("refunds an expired released reservation without false debt", async () => {
		const fixture = await createReservedCreditsFixture(client, {
			grantAmount: 10n,
			reserveAmount: 10n,
		});
		await client.creditLot.updateMany({
			where: { accountId: fixture.account.id },
			data: { expiresAt: new Date(Date.now() - 60_000) },
		});
		await releaseCredits(
			{
				reservationId: fixture.reservation.id,
				referenceKey: `test-release-expired-${crypto.randomUUID()}`,
			},
			client,
		);

		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: fixture.account.id } }),
		).toMatchObject({
			spendableCredits: 0n,
			reservedCredits: 0n,
		});
		const lot = await client.creditLot.findFirstOrThrow({
			where: { accountId: fixture.account.id },
		});
		expect(lot).toMatchObject({
			remainingAmount: 0n,
			reservedAmount: 0n,
			expiredUnrefundedAmount: 10n,
		});
		await refundCreditGrant(
			{
				accountId: fixture.account.id,
				amount: 10n,
				grantReferenceKey: fixture.grantReferenceKey,
				referenceKey: `test-refund-expired-release-${crypto.randomUUID()}`,
			},
			client,
		);
		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: fixture.account.id } }),
		).toMatchObject({ spendableCredits: 0n, reservedCredits: 0n, creditDebt: 0n });
		expect(await client.creditLot.findUniqueOrThrow({ where: { id: lot.id } })).toMatchObject({
			expiredUnrefundedAmount: 0n,
		});
		expect(await getCreditInvariantReport(fixture.account.id, client)).toMatchObject({
			valid: true,
		});
	});

	it("does not resurrect a fully refunded reserved grant on zero-charge release", async () => {
		const fixture = await createReservedCreditsFixture(client, {
			grantAmount: 10n,
			reserveAmount: 10n,
		});
		await refundCreditGrant(
			{
				accountId: fixture.account.id,
				amount: 10n,
				grantReferenceKey: fixture.grantReferenceKey,
				referenceKey: `test-refund-reserved-${crypto.randomUUID()}`,
			},
			client,
		);
		await releaseCredits(
			{
				reservationId: fixture.reservation.id,
				referenceKey: `test-release-refunded-${crypto.randomUUID()}`,
			},
			client,
		);

		const [account, lot, invariant] = await Promise.all([
			client.creditAccount.findUniqueOrThrow({ where: { id: fixture.account.id } }),
			client.creditLot.findFirstOrThrow({ where: { accountId: fixture.account.id } }),
			getCreditInvariantReport(fixture.account.id, client),
		]);
		expect(account).toMatchObject({ spendableCredits: 0n, reservedCredits: 0n, creditDebt: 0n });
		expect(lot).toMatchObject({ remainingAmount: 0n, reservedAmount: 0n });
		expect(invariant).toMatchObject({ valid: true });
	});

	it("restores only the non-refunded part of a partially revoked reservation", async () => {
		const fixture = await createReservedCreditsFixture(client, {
			grantAmount: 10n,
			reserveAmount: 6n,
		});
		await refundCreditGrant(
			{
				accountId: fixture.account.id,
				amount: 8n,
				grantReferenceKey: fixture.grantReferenceKey,
				referenceKey: `test-refund-partial-${crypto.randomUUID()}`,
			},
			client,
		);
		await releaseCredits(
			{
				reservationId: fixture.reservation.id,
				referenceKey: `test-release-partial-${crypto.randomUUID()}`,
			},
			client,
		);
		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: fixture.account.id } }),
		).toMatchObject({ spendableCredits: 2n, reservedCredits: 0n, creditDebt: 0n });
		expect(await getCreditInvariantReport(fixture.account.id, client)).toMatchObject({
			valid: true,
		});
	});

	it("refunds unused units from an expired matching lot instead of creating false debt", async () => {
		const ownerId = `test-user-${crypto.randomUUID()}`;
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		const grantReferenceKey = `test-expired-grant-${crypto.randomUUID()}`;
		await createCreditGrant(
			{
				accountId: account.id,
				amount: 7n,
				referenceKey: grantReferenceKey,
				expiresAt: new Date(Date.now() - 60_000),
			},
			client,
		);
		await refundCreditGrant(
			{
				accountId: account.id,
				amount: 7n,
				grantReferenceKey,
				referenceKey: `test-expired-refund-${crypto.randomUUID()}`,
			},
			client,
		);
		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: account.id } }),
		).toMatchObject({
			spendableCredits: 0n,
			creditDebt: 0n,
		});
	});

	it("rejects stale outbox release and completion after the lease is reclaimed", async () => {
		const dedupeKey = `test-outbox-cas-${crypto.randomUUID()}`;
		await client.outboxEvent.create({
			data: {
				eventType: "TEST_EVENT",
				aggregateType: "TEST",
				aggregateId: dedupeKey,
				dedupeKey,
				payload: {},
				availableAt: new Date(0),
			},
		});
		const first = (
			await claimOutboxBatch(
				{ workerId: "test-reused-worker", limit: 100, leaseSeconds: 1 },
				client,
			)
		).find((item) => item.dedupeKey === dedupeKey)! as { id: string; leaseToken?: string };
		expect(first.leaseToken).toEqual(expect.any(String));
		const second = (
			await claimOutboxBatch(
				{
					workerId: "test-reused-worker",
					limit: 100,
					leaseSeconds: 30,
					now: new Date(Date.now() + 2_000),
				},
				client,
			)
		).find((item) => item.id === first.id)! as { id: string; leaseToken?: string };
		expect(second.leaseToken).toEqual(expect.any(String));
		expect(second.leaseToken).not.toBe(first.leaseToken);

		const staleRelease = await releaseOutboxEvent(
			{
				id: first.id,
				workerId: "test-reused-worker",
				leaseToken: first.leaseToken!,
				error: "stale failure",
				maxAttempts: 5,
				retryAt: new Date(),
			} as Parameters<typeof releaseOutboxEvent>[0] & { leaseToken: string },
			client,
		);
		const staleComplete = await completeOutboxEvent(
			first.id,
			"test-reused-worker",
			first.leaseToken!,
			client,
		);
		expect(staleRelease).toMatchObject({ applied: false });
		expect(staleComplete).toMatchObject({ count: 0 });
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
			status: "LEASED",
			leaseOwner: "test-reused-worker",
			leaseToken: second.leaseToken,
		});
	});

	it("rejects idempotency-key reuse with different credit commands", async () => {
		const ownerA = `test-user-${crypto.randomUUID()}`;
		const ownerB = `test-user-${crypto.randomUUID()}`;
		const [accountA, accountB] = await Promise.all([
			client.creditAccount.create({ data: { ownerType: "USER", ownerId: ownerA } }),
			client.creditAccount.create({ data: { ownerType: "USER", ownerId: ownerB } }),
		]);
		const grantKey = `test-grant-conflict-${crypto.randomUUID()}`;
		const grant = await createCreditGrant(
			{ accountId: accountA.id, amount: 10n, referenceKey: grantKey },
			client,
		);
		const grantReplay = await createCreditGrant(
			{ accountId: accountA.id, amount: 10n, referenceKey: grantKey },
			client,
		);
		expect(grantReplay.id).toBe(grant.id);
		await expect(
			createCreditGrant({ accountId: accountA.id, amount: 11n, referenceKey: grantKey }, client),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
		await expect(
			createCreditGrant({ accountId: accountB.id, amount: 10n, referenceKey: grantKey }, client),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");

		const refundKey = `test-refund-conflict-${crypto.randomUUID()}`;
		const refund = await refundCreditGrant(
			{
				accountId: accountA.id,
				amount: 2n,
				grantReferenceKey: grantKey,
				referenceKey: refundKey,
			},
			client,
		);
		const refundReplay = await refundCreditGrant(
			{
				accountId: accountA.id,
				amount: 2n,
				grantReferenceKey: grantKey,
				referenceKey: refundKey,
			},
			client,
		);
		expect(refundReplay.id).toBe(refund.id);
		await expect(
			refundCreditGrant(
				{
					accountId: accountA.id,
					amount: 3n,
					grantReferenceKey: grantKey,
					referenceKey: refundKey,
				},
				client,
			),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
		await expect(
			refundCreditGrant(
				{
					accountId: accountB.id,
					amount: 2n,
					grantReferenceKey: grantKey,
					referenceKey: refundKey,
				},
				client,
			),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
	});

	it("normalizes a concurrent cross-account reference-key race to an idempotency conflict", async () => {
		const referenceKey = `test-concurrent-race-${crypto.randomUUID()}`;
		const accounts = await Promise.all(
			[0, 1].map((index) =>
				client.creditAccount.create({
					data: {
						ownerType: "USER",
						ownerId: `test-concurrent-user-${index}-${crypto.randomUUID()}`,
					},
				}),
			),
		);
		await client.$executeRawUnsafe(`
			CREATE OR REPLACE FUNCTION test_delay_credit_ledger_insert() RETURNS trigger AS $$
			BEGIN
				IF NEW."accountId" = '${accounts[0]!.id}' AND NEW."referenceKey" LIKE 'test-concurrent-race-%' THEN
					PERFORM pg_sleep(0.2);
				END IF;
				RETURN NEW;
			END;
			$$ LANGUAGE plpgsql;
			CREATE TRIGGER test_delay_credit_ledger_insert
			BEFORE INSERT ON "credit_ledger_entry"
			FOR EACH ROW EXECUTE FUNCTION test_delay_credit_ledger_insert();
		`);
		try {
			const delayedLoser = createCreditGrant(
				{ accountId: accounts[0]!.id, amount: 10n, referenceKey },
				client,
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
			const committedWinner = createCreditGrant(
				{ accountId: accounts[1]!.id, amount: 10n, referenceKey },
				client,
			);
			const results = await Promise.allSettled([delayedLoser, committedWinner]);
			const fulfilled = results.filter((result) => result.status === "fulfilled");
			const rejected = results.filter((result) => result.status === "rejected");
			expect(fulfilled).toHaveLength(1);
			expect(rejected).toHaveLength(1);
			expect(rejected[0]!.reason).toBeInstanceOf(IdempotencyConflictError);
			expect(rejected[0]!.reason).not.toMatchObject({ code: "P2002" });
			expect(await client.creditLedgerEntry.count({ where: { referenceKey } })).toBe(1);
		} finally {
			await client.$executeRawUnsafe(`
				DROP TRIGGER IF EXISTS test_delay_credit_ledger_insert ON "credit_ledger_entry";
				DROP FUNCTION IF EXISTS test_delay_credit_ledger_insert();
			`);
		}
	});

	it("returns one canonical result for concurrent identical credit commands", async () => {
		const account = await client.creditAccount.create({
			data: { ownerType: "USER", ownerId: `test-concurrent-replay-${crypto.randomUUID()}` },
		});
		const referenceKey = `test-concurrent-replay-${crypto.randomUUID()}`;
		const lockClassId = 214_731;
		const lockObjectId = Math.floor(Math.random() * 1_000_000) + 1;
		const observations: SerializableAttemptObservation[][] = [[], []];
		await client.$executeRawUnsafe(`
			CREATE OR REPLACE FUNCTION test_hold_identical_credit_grant() RETURNS trigger AS $$
			BEGIN
				IF NEW."grantReferenceKey" = '${referenceKey}' THEN
					PERFORM pg_advisory_xact_lock(${lockClassId}, ${lockObjectId});
					PERFORM pg_sleep(1);
				END IF;
				RETURN NEW;
			END;
			$$ LANGUAGE plpgsql;
			CREATE TRIGGER test_hold_identical_credit_grant
			BEFORE INSERT ON "credit_lot"
			FOR EACH ROW EXECUTE FUNCTION test_hold_identical_credit_grant();
		`);
		try {
			const firstCall = createCreditGrant(
				{ accountId: account.id, amount: 10n, referenceKey },
				client,
				{ onAttempt: (event) => observations[0]!.push(event) },
			);
			const overlapObserved = await waitForAdvisoryLock(client, lockClassId, lockObjectId);
			expect(overlapObserved).toBe(true);
			const secondCall = createCreditGrant(
				{ accountId: account.id, amount: 10n, referenceKey },
				client,
				{ onAttempt: (event) => observations[1]!.push(event) },
			);
			const [first, second] = await Promise.all([firstCall, secondCall]);
			const allObservations = observations.flat();
			expect(allObservations.some((event) => event.outcome === "SERIALIZATION_CONFLICT")).toBe(
				true,
			);
			expect(Math.max(...allObservations.map((event) => event.attempt))).toBeLessThanOrEqual(4);
			expect(second.id).toBe(first.id);
			expect(await client.creditLedgerEntry.count({ where: { referenceKey } })).toBe(1);
			expect(
				await client.creditAccount.findUniqueOrThrow({ where: { id: account.id } }),
			).toMatchObject({ spendableCredits: 10n });
		} finally {
			await client.$executeRawUnsafe(`
				DROP TRIGGER IF EXISTS test_hold_identical_credit_grant ON "credit_lot";
				DROP FUNCTION IF EXISTS test_hold_identical_credit_grant();
			`);
		}
	});

	it("normalizes a concurrent reservation job-key race to an idempotency conflict", async () => {
		const owners = [0, 1].map((index) => `test-reserve-race-user-${index}-${crypto.randomUUID()}`);
		const accounts = await Promise.all(
			owners.map((ownerId) =>
				client.creditAccount.create({ data: { ownerType: "USER", ownerId } }),
			),
		);
		await Promise.all(
			accounts.map((account) =>
				createCreditGrant(
					{
						accountId: account.id,
						amount: 10n,
						referenceKey: `test-reserve-race-grant-${crypto.randomUUID()}`,
					},
					client,
				),
			),
		);
		const quote = await client.generationQuote.create({
			data: {
				ownerType: "USER",
				ownerId: owners[0]!,
				submittedByUserId: owners[0]!,
				productKey: "test-product",
				catalogVersion: "test-v1",
				pricingVersion: "test-v1",
				credits: 10n,
				costMicros: 0n,
				inputSnapshot: {},
				pricingSnapshot: {},
				expiresAt: new Date(Date.now() + 60_000),
			},
		});
		const job = await client.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId: owners[0]!,
				submittedByUserId: owners[0]!,
				quoteId: quote.id,
				idempotencyKey: `test-reserve-race-job-${crypto.randomUUID()}`,
				productKey: quote.productKey,
				catalogVersion: quote.catalogVersion,
				pricingVersion: quote.pricingVersion,
				creditsReserved: 10n,
				inputSnapshot: {},
				pricingSnapshot: {},
			},
		});
		await client.$executeRawUnsafe(`
			CREATE OR REPLACE FUNCTION test_delay_credit_reservation_insert() RETURNS trigger AS $$
			BEGIN
				IF NEW."accountId" = '${accounts[0]!.id}' THEN
					PERFORM pg_sleep(0.2);
				END IF;
				RETURN NEW;
			END;
			$$ LANGUAGE plpgsql;
			CREATE TRIGGER test_delay_credit_reservation_insert
			BEFORE INSERT ON "credit_reservation"
			FOR EACH ROW EXECUTE FUNCTION test_delay_credit_reservation_insert();
		`);
		try {
			const delayedLoser = reserveCredits(
				{
					accountId: accounts[0]!.id,
					jobId: job.id,
					amount: 10n,
					referenceKey: `test-reserve-race-loser-${crypto.randomUUID()}`,
				},
				client,
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
			const committedWinner = reserveCredits(
				{
					accountId: accounts[1]!.id,
					jobId: job.id,
					amount: 10n,
					referenceKey: `test-reserve-race-winner-${crypto.randomUUID()}`,
				},
				client,
			);
			const results = await Promise.allSettled([delayedLoser, committedWinner]);
			const rejected = results.filter((result) => result.status === "rejected");
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			expect(rejected).toHaveLength(1);
			expect(rejected[0]!.reason).toBeInstanceOf(IdempotencyConflictError);
			expect(rejected[0]!.reason).not.toMatchObject({ code: "P2002" });
			const reservation = await client.creditReservation.findUniqueOrThrow({
				where: { jobId: job.id },
			});
			expect(
				await client.creditLedgerEntry.count({ where: { reservationId: reservation.id } }),
			).toBe(1);
		} finally {
			await client.$executeRawUnsafe(`
				DROP TRIGGER IF EXISTS test_delay_credit_reservation_insert ON "credit_reservation";
				DROP FUNCTION IF EXISTS test_delay_credit_reservation_insert();
			`);
		}
	});

	it("rejects reservation and finalization replay conflicts", async () => {
		const first = await createReservedCreditsFixture(client, {
			grantAmount: 20n,
			reserveAmount: 10n,
		});
		const second = await createReservedCreditsFixture(client, {
			grantAmount: 20n,
			reserveAmount: 10n,
		});
		const reserveReplay = await reserveCredits(
			{
				accountId: first.account.id,
				jobId: first.job.id,
				amount: 10n,
				referenceKey: `job:${first.job.id}:reserve`,
			},
			client,
		);
		expect(reserveReplay.id).toBe(first.reservation.id);
		await expect(
			reserveCredits(
				{
					accountId: first.account.id,
					jobId: first.job.id,
					amount: 9n,
					referenceKey: `different-reserve-${crypto.randomUUID()}`,
				},
				client,
			),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");

		const settleKey = `test-settle-conflict-${crypto.randomUUID()}`;
		await settleCredits(
			{ reservationId: first.reservation.id, amount: 5n, referenceKey: settleKey },
			client,
		);
		await expect(
			settleCredits(
				{ reservationId: first.reservation.id, amount: 4n, referenceKey: settleKey },
				client,
			),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
		await expect(
			settleCredits(
				{ reservationId: second.reservation.id, amount: 5n, referenceKey: settleKey },
				client,
			),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");

		const releaseKey = `test-release-conflict-${crypto.randomUUID()}`;
		await releaseCredits(
			{ reservationId: second.reservation.id, referenceKey: releaseKey },
			client,
		);
		await expect(
			releaseCredits({ reservationId: first.reservation.id, referenceKey: releaseKey }, client),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
	});

	it("paginates the asset library without repeating a cursor row", async () => {
		const ownerId = `test-user-${crypto.randomUUID()}`;
		const assets = [];
		for (let index = 0; index < 3; index += 1) {
			const checksum = index.toString(16).padStart(64, "0");
			const validUntil = new Date(Date.now() + 60_000);
			const asset = await createMediaAsset(
				{
					ownerType: "USER",
					ownerId,
					kind: "INPUT",
					objectKey: `test/${ownerId}/${index}`,
					mimeType: "image/png",
					byteSize: 10n,
				},
				client,
			);
			await client.mediaAsset.update({
				where: { id: asset.id },
				data: {
					status: "VERIFYING",
					checksum,
					verificationGeneration: 1,
					verificationAttemptCount: 1,
					verificationProvider: "test",
					verificationRuleVersion: "asset-rule-v1",
					verificationPolicyVersion: "policy-v1",
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
					ruleVersion: "asset-rule-v1",
					policyVersion: "policy-v1",
					status: "APPROVED",
					validUntil,
					reasonCode: "TEST_ALLOW",
					categories: {},
					rawEnvelope: { decision: "ALLOW" },
				},
			});
			assets.push(
				await client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } }),
			);
		}
		const firstPage = await listMediaAssets({ ownerType: "USER", ownerId, take: 2 }, client);
		const cursor = firstPage.at(-1)!;
		const secondPage = await listMediaAssets(
			{
				ownerType: "USER",
				ownerId,
				take: 2,
				cursor: { createdAt: cursor.createdAt, id: cursor.id },
			},
			client,
		);
		expect(firstPage).toHaveLength(2);
		expect(secondPage).toHaveLength(1);
		expect(new Set([...firstPage, ...secondPage].map((asset) => asset.id)).size).toBe(3);
	});

	it("refuses to delete a READY asset bound to a nonterminal generation job", async () => {
		const fixture = await createReadyInputAssetFixture(client);
		await fixture.createJob();

		await expect(
			markMediaAssetDeletedTransaction(
				{ assetId: fixture.asset.id, ownerId: fixture.ownerId },
				client,
			),
		).rejects.toThrow("MEDIA_ASSET_BOUND_TO_ACTIVE_GENERATION_JOB");
		expect(
			await client.mediaAsset.findUniqueOrThrow({ where: { id: fixture.asset.id } }),
		).toMatchObject({ status: "READY", deletedAt: null });
	});

	it("refuses to delete a READY output while finalizing settlement can consume it", async () => {
		const fixture = await createReadyInputAssetFixture(client);
		const created = await fixture.createJob();
		await client.generationJob.update({
			where: { id: created.job.id },
			data: { status: "FINALIZING" },
		});
		const verifyingOutput = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: fixture.ownerId,
				kind: "OUTPUT",
				status: "VERIFYING",
				objectKey: `users/${fixture.ownerId}/assets/${crypto.randomUUID()}/output.png`,
				mimeType: "image/png",
				byteSize: 10n,
			},
		});
		const output = await approveReadyAssetForTest(client, {
			assetId: verifyingOutput.id,
			kind: "OUTPUT",
		});
		await client.generationJobAsset.create({
			data: {
				jobId: created.job.id,
				assetId: output.id,
				assetChecksum: output.checksum!,
				role: "OUTPUT",
				position: 0,
			},
		});

		await expect(
			markMediaAssetDeletedTransaction({ assetId: output.id, ownerId: fixture.ownerId }, client),
		).rejects.toThrow("MEDIA_ASSET_BOUND_TO_ACTIVE_GENERATION_JOB");
		expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: output.id } })).toMatchObject({
			status: "READY",
			deletedAt: null,
		});
	});

	it("binds a VERIFYING output to its FINALIZING job before it can become READY", async () => {
		const fixture = await createReadyInputAssetFixture(client);
		const created = await fixture.createJob();
		await client.generationJob.update({
			where: { id: created.job.id },
			data: { status: "FINALIZING" },
		});
		const assetId = `bound-output-${crypto.randomUUID()}`;
		const output = await createGenerationOutputAssetBindingTransaction(
			{
				jobId: created.job.id,
				asset: {
					id: assetId,
					ownerId: fixture.ownerId,
					objectKey: `users/${fixture.ownerId}/assets/${assetId}/output.png`,
					mimeType: "image/png",
					byteSize: 10n,
					checksum: "b".repeat(64),
					sourceUrl: `provider-output:${assetId}`,
				},
			},
			client,
		);

		expect(output).toMatchObject({ id: assetId, status: "VERIFYING" });
		expect(
			await client.generationJobAsset.findUnique({
				where: {
					jobId_assetId_role: { jobId: created.job.id, assetId, role: "OUTPUT" },
				},
			}),
		).toMatchObject({ jobId: created.job.id, assetId, role: "OUTPUT" });
	});

	it("claims one output transfer and fences duplicate writers before storage work", async () => {
		const fixture = await createReadyInputAssetFixture(client);
		const created = await fixture.createJob();
		await client.generationJob.update({
			where: { id: created.job.id },
			data: { status: "FINALIZING" },
		});
		const assetId = `asset_output_transfer_${crypto.randomUUID().replaceAll("-", "")}`;
		const input = {
			jobId: created.job.id,
			ownerId: fixture.ownerId,
			assetId,
			objectKey: `users/${fixture.ownerId}/assets/${assetId}/original.png`,
			mimeType: "image/png",
			sourceUrl: `provider-output:${assetId}`,
			createStagingObjectKey: (token: string) =>
				`users/${fixture.ownerId}/staging/${assetId}/${token}.png`,
		};

		const first = await claimGenerationOutputTransferTransaction(input, client);
		expect(first).toMatchObject({
			outcome: "CLAIMED",
			asset: { id: assetId, status: "VERIFYING" },
		});
		if (first.outcome !== "CLAIMED") throw new Error("Expected initial output transfer claim");

		await expect(claimGenerationOutputTransferTransaction(input, client)).resolves.toMatchObject({
			outcome: "IN_PROGRESS",
			asset: { id: assetId },
		});
		expect(
			await client.generationJobAsset.findUnique({
				where: {
					jobId_assetId_role: { jobId: created.job.id, assetId, role: "OUTPUT" },
				},
			}),
		).toMatchObject({ jobId: created.job.id, assetId, role: "OUTPUT" });
		expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).toMatchObject({
			outputTransferToken: first.transferToken,
			outputStagingObjectKey: first.stagingObjectKey,
		});
	});

	it("reclaims an expired output transfer and queues only stale staging and exact promotion abort", async () => {
		const fixture = await createReadyInputAssetFixture(client);
		const created = await fixture.createJob();
		await client.generationJob.update({
			where: { id: created.job.id },
			data: { status: "FINALIZING" },
		});
		const assetId = `asset_output_reclaim_${crypto.randomUUID().replaceAll("-", "")}`;
		const initialNow = new Date("2026-08-24T00:00:00.000Z");
		const input = {
			jobId: created.job.id,
			ownerId: fixture.ownerId,
			assetId,
			objectKey: `users/${fixture.ownerId}/assets/${assetId}/original.png`,
			mimeType: "image/png",
			sourceUrl: `provider-output:${assetId}`,
			createStagingObjectKey: (token: string) =>
				`users/${fixture.ownerId}/staging/${assetId}/${token}.png`,
		};
		const first = await claimGenerationOutputTransferTransaction(
			{ ...input, now: initialNow, leaseDurationMs: 1_000 },
			client,
		);
		if (first.outcome !== "CLAIMED") throw new Error("Expected initial output transfer claim");
		await recordGenerationOutputPromotionMultipartTransaction(
			{
				assetId,
				ownerId: fixture.ownerId,
				transferToken: first.transferToken,
				multipartUploadId: `promotion-${assetId}`,
				now: new Date("2026-08-24T00:00:00.500Z"),
			},
			client,
		);

		const reclaimed = await claimGenerationOutputTransferTransaction(
			{ ...input, now: new Date("2026-08-24T00:00:02.000Z"), leaseDurationMs: 1_000 },
			client,
		);
		expect(reclaimed).toMatchObject({ outcome: "CLAIMED", asset: { id: assetId } });
		if (reclaimed.outcome !== "CLAIMED")
			throw new Error("Expected expired output transfer reclaim");
		expect(reclaimed.transferToken).not.toBe(first.transferToken);
		expect(reclaimed.stagingObjectKey).not.toBe(first.stagingObjectKey);
		await expect(
			client.outboxEvent.findMany({
				where: { aggregateId: assetId },
				orderBy: { dedupeKey: "asc" },
			}),
		).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "MEDIA_OBJECT_DELETE",
					dedupeKey: `generation-output-staging-delete:${assetId}:${first.transferToken}`,
					payload: expect.objectContaining({ objectKey: first.stagingObjectKey }),
				}),
				expect.objectContaining({
					eventType: "MEDIA_UPLOAD_CLEANUP",
					dedupeKey: `generation-output-promotion-abort:${assetId}:${first.transferToken}`,
					payload: expect.objectContaining({
						objectKey: input.objectKey,
						multipartUploadId: `promotion-${assetId}`,
						promotionAbortOnly: true,
					}),
				}),
			]),
		);
	});

	it("commits only the current output transfer identity and queues staging deletion", async () => {
		const fixture = await createReadyInputAssetFixture(client);
		const created = await fixture.createJob();
		await client.generationJob.update({
			where: { id: created.job.id },
			data: { status: "FINALIZING" },
		});
		const assetId = `asset_output_complete_${crypto.randomUUID().replaceAll("-", "")}`;
		const input = {
			jobId: created.job.id,
			ownerId: fixture.ownerId,
			assetId,
			objectKey: `users/${fixture.ownerId}/assets/${assetId}/original.png`,
			mimeType: "image/png",
			sourceUrl: `provider-output:${assetId}`,
			createStagingObjectKey: (token: string) =>
				`users/${fixture.ownerId}/staging/${assetId}/${token}.png`,
		};
		const claimed = await claimGenerationOutputTransferTransaction(input, client);
		if (claimed.outcome !== "CLAIMED") throw new Error("Expected initial output transfer claim");

		await expect(
			completeGenerationOutputTransferTransaction(
				{
					assetId,
					ownerId: fixture.ownerId,
					transferToken: "stale-transfer-token",
					bytes: 123n,
					checksum: "a".repeat(64),
					storageEtag: '"final-etag"',
					storageVersionId: "final-version",
				},
				client,
			),
		).resolves.toMatchObject({ outcome: "STALE" });
		await expect(
			completeGenerationOutputTransferTransaction(
				{
					assetId,
					ownerId: fixture.ownerId,
					transferToken: claimed.transferToken,
					bytes: 123n,
					checksum: "b".repeat(64),
					storageEtag: '"final-etag"',
					storageVersionId: "final-version",
				},
				client,
			),
		).resolves.toMatchObject({
			outcome: "COMPLETED",
			asset: { id: assetId, checksum: "b".repeat(64) },
		});
		expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).toMatchObject({
			status: "VERIFYING",
			byteSize: 123n,
			checksum: "b".repeat(64),
			storageEtag: '"final-etag"',
			storageVersionId: "final-version",
			outputTransferToken: null,
			outputTransferLeaseExpiresAt: null,
			outputStagingObjectKey: null,
			outputPromotionMultipartUploadId: null,
			finalizedAt: expect.any(Date),
		});
		await expect(
			client.generationJobAsset.findUniqueOrThrow({
				where: {
					jobId_assetId_role: { jobId: created.job.id, assetId, role: "OUTPUT" },
				},
			}),
		).resolves.toMatchObject({ assetChecksum: "b".repeat(64) });
		await expect(
			client.outboxEvent.findUnique({
				where: {
					dedupeKey: `generation-output-staging-delete:${assetId}:${claimed.transferToken}`,
				},
			}),
		).resolves.toMatchObject({
			eventType: "MEDIA_OBJECT_DELETE",
			payload: expect.objectContaining({ objectKey: claimed.stagingObjectKey }),
		});
	});

	it("permits deletion of a READY output after its bound job is terminal", async () => {
		const fixture = await createReadyInputAssetFixture(client);
		const created = await fixture.createJob();
		await client.generationJob.update({
			where: { id: created.job.id },
			data: { status: "FINALIZING" },
		});
		const assetId = `terminal-output-${crypto.randomUUID()}`;
		await createGenerationOutputAssetBindingTransaction(
			{
				jobId: created.job.id,
				asset: {
					id: assetId,
					ownerId: fixture.ownerId,
					objectKey: `users/${fixture.ownerId}/assets/${assetId}/output.png`,
					mimeType: "image/png",
					byteSize: 10n,
					checksum: "c".repeat(64),
					sourceUrl: `provider-output:${assetId}`,
				},
			},
			client,
		);
		await approveReadyAssetForTest(client, {
			assetId,
			kind: "OUTPUT",
			checksum: "c".repeat(64),
		});
		await client.generationJob.update({
			where: { id: created.job.id },
			data: { status: "SUCCEEDED" },
		});

		await expect(
			markMediaAssetDeletedTransaction({ assetId, ownerId: fixture.ownerId }, client),
		).resolves.toMatchObject({ id: assetId, status: "DELETED" });
	});

	it("permits deletion after every input binding belongs to a terminal generation job", async () => {
		const fixture = await createReadyInputAssetFixture(client);
		const created = await fixture.createJob();
		const transitioned = await transitionGenerationJob(
			{
				jobId: created.job.id,
				expectedStatuses: ["RESERVED"],
				expectedVersion: created.job.version,
				nextStatus: "CANCELED",
			},
			client,
		);
		expect(transitioned.applied).toBe(true);

		await expect(
			markMediaAssetDeletedTransaction(
				{ assetId: fixture.asset.id, ownerId: fixture.ownerId },
				client,
			),
		).resolves.toMatchObject({ id: fixture.asset.id, status: "DELETED" });
	});

	it("serializes input binding creation against asset deletion so both cannot succeed", async () => {
		const fixture = await createReadyInputAssetFixture(client);
		const lockClassId = 241_871;
		const lockObjectId = Math.floor(Math.random() * 1_000_000) + 1;
		const barrierName = `test_hold_media_asset_binding_${crypto.randomUUID().replaceAll("-", "")}`;
		await client.$executeRawUnsafe(`
			CREATE OR REPLACE FUNCTION "${barrierName}"() RETURNS trigger AS $$
			BEGIN
				IF NEW."assetId" = '${fixture.asset.id}' THEN
					PERFORM pg_advisory_xact_lock(${lockClassId}, ${lockObjectId});
					PERFORM pg_sleep(1);
				END IF;
				RETURN NEW;
			END;
			$$ LANGUAGE plpgsql;
			CREATE TRIGGER "${barrierName}"
			BEFORE INSERT ON "generation_job_asset"
			FOR EACH ROW EXECUTE FUNCTION "${barrierName}"();
		`);
		try {
			const creating = fixture.createJob();
			expect(await waitForAdvisoryLock(client, lockClassId, lockObjectId)).toBe(true);
			const deleting = markMediaAssetDeletedTransaction(
				{ assetId: fixture.asset.id, ownerId: fixture.ownerId },
				client,
			);
			const [created, deleted] = await Promise.allSettled([creating, deleting]);

			expect(created.status).toBe("fulfilled");
			expect(deleted.status).toBe("rejected");
			if (deleted.status === "rejected") {
				expect(deleted.reason).toMatchObject({
					message: "MEDIA_ASSET_BOUND_TO_ACTIVE_GENERATION_JOB",
				});
			}
		} finally {
			await client.$executeRawUnsafe(`
				DROP TRIGGER IF EXISTS "${barrierName}" ON "generation_job_asset";
				DROP FUNCTION IF EXISTS "${barrierName}"();
			`);
		}
	});

	it("serializes finalizing output binding against deletion", async () => {
		const fixture = await createReadyInputAssetFixture(client);
		const created = await fixture.createJob();
		await client.generationJob.update({
			where: { id: created.job.id },
			data: { status: "FINALIZING" },
		});
		const assetId = `racing-output-${crypto.randomUUID()}`;
		const verifyingOutput = await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId: fixture.ownerId,
				kind: "OUTPUT",
				status: "VERIFYING",
				objectKey: `users/${fixture.ownerId}/assets/${assetId}/output.png`,
				mimeType: "image/png",
				byteSize: 10n,
				checksum: "d".repeat(64),
				sourceUrl: `provider-output:${assetId}`,
			},
		});
		const output = await approveReadyAssetForTest(client, {
			assetId: verifyingOutput.id,
			kind: "OUTPUT",
			checksum: "d".repeat(64),
		});
		const lockClassId = 241_872;
		const lockObjectId = Math.floor(Math.random() * 1_000_000) + 1;
		const barrierName = `test_hold_output_asset_binding_${crypto.randomUUID().replaceAll("-", "")}`;
		await client.$executeRawUnsafe(`
			CREATE OR REPLACE FUNCTION "${barrierName}"() RETURNS trigger AS $$
			BEGIN
				IF NEW."assetId" = '${assetId}' THEN
					PERFORM pg_advisory_xact_lock(${lockClassId}, ${lockObjectId});
					PERFORM pg_sleep(1);
				END IF;
				RETURN NEW;
			END;
			$$ LANGUAGE plpgsql;
			CREATE TRIGGER "${barrierName}"
			BEFORE INSERT ON "generation_job_asset"
			FOR EACH ROW EXECUTE FUNCTION "${barrierName}"();
		`);
		try {
			const binding = createGenerationOutputAssetBindingTransaction(
				{
					jobId: created.job.id,
					asset: {
						id: output.id,
						ownerId: fixture.ownerId,
						objectKey: output.objectKey,
						mimeType: output.mimeType,
						byteSize: output.byteSize,
						checksum: output.checksum!,
						sourceUrl: output.sourceUrl!,
					},
				},
				client,
			);
			expect(await waitForAdvisoryLock(client, lockClassId, lockObjectId)).toBe(true);
			const deleting = markMediaAssetDeletedTransaction(
				{ assetId: output.id, ownerId: fixture.ownerId },
				client,
			);
			const [bound, deleted] = await Promise.allSettled([binding, deleting]);

			expect(bound.status).toBe("fulfilled");
			expect(deleted.status).toBe("rejected");
			if (deleted.status === "rejected") {
				expect(deleted.reason).toMatchObject({
					message: "MEDIA_ASSET_BOUND_TO_ACTIVE_GENERATION_JOB",
				});
			}
		} finally {
			await client.$executeRawUnsafe(`
				DROP TRIGGER IF EXISTS "${barrierName}" ON "generation_job_asset";
				DROP FUNCTION IF EXISTS "${barrierName}"();
			`);
		}
	});

	it("atomically persists one stable cleanup event when an upload is aborted", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `abort-upload-${suffix}`;
		const created = await createMediaUploadSessionTransaction(
			{
				assetId: `asset_abort_${suffix}`,
				sessionId: `upload_abort_${suffix}`,
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				objectKey: `users/${ownerId}/assets/${suffix}/original.mp4`,
				stagingObjectKey: `users/${ownerId}/staging/upload_abort_${suffix}/nonce.mp4`,
				mimeType: "video/mp4",
				expectedBytes: 1024n,
				tokenHash: `hash-${suffix}`,
				expiresAt: new Date(Date.now() + 60_000),
				multipartUploadId: `multipart-${suffix}`,
				limits: { maximumActiveSessions: 5, maximumReservedBytes: 2_147_483_648n },
			},
			client,
		);
		await abortMediaUploadSessionTransaction({ sessionId: created.session.id, ownerId }, client);
		await abortMediaUploadSessionTransaction({ sessionId: created.session.id, ownerId }, client);

		await expect(
			client.outboxEvent.findMany({
				where: { dedupeKey: `media-upload-abort-cleanup:${created.session.id}` },
			}),
		).resolves.toEqual([
			expect.objectContaining({
				eventType: "MEDIA_UPLOAD_CLEANUP",
				status: "PENDING",
				payload: expect.objectContaining({ multipartUploadId: `multipart-${suffix}` }),
			}),
		]);
	});

	it("rejects update and delete mutations to credit ledger rows", async () => {
		const row = await client.creditLedgerEntry.findFirstOrThrow();
		await expect(
			client.$executeRaw`UPDATE "credit_ledger_entry" SET "amount" = "amount" + 1 WHERE "id" = ${row.id}`,
		).rejects.toThrow("credit_ledger_entry is immutable");
		await expect(
			client.$executeRaw`DELETE FROM "credit_ledger_entry" WHERE "id" = ${row.id}`,
		).rejects.toThrow("credit_ledger_entry is immutable");
	});

	it("rejects a negative aggregate balance at the database boundary", async () => {
		const account = await client.creditAccount.findFirstOrThrow();
		await expect(
			client.$executeRaw`UPDATE "credit_account" SET "spendableCredits" = -1 WHERE "id" = ${account.id}`,
		).rejects.toThrow();
	});
});

describe("integration database safety gate", () => {
	it("does not silently fall back to DATABASE_URL", () => {
		if (!TEST_DATABASE_URL) {
			expect(() => assertSafeTestDatabaseUrl()).toThrow("TEST_DATABASE_URL is required");
		}
	});
});
