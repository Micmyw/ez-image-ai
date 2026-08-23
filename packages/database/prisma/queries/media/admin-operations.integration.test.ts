import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createCreditGrant,
	createGenerationJobTransaction,
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
	getAdminMediaDiagnostics,
	replayPersistedMediaEvent,
	resolveAdminUncertainSubmission,
	retryAdminMediaJobStage,
	rollbackAdminMediaRuntimeOverride,
	setAdminMediaRuntimeOverride,
} from ".";
import { PrismaClient } from "../../generated/client";

function safeTestDatabaseUrl(): string {
	const value = process.env.TEST_DATABASE_URL;
	if (!value) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	if (process.env.DATABASE_URL === value) throw new Error("UNSAFE_TEST_DATABASE");
	const parsed = new URL(value);
	if (
		!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
		!/test|testing/.test(parsed.pathname)
	) {
		throw new Error("UNSAFE_TEST_DATABASE");
	}
	return value;
}

describe("admin media database operations", () => {
	let client: PrismaClient;
	const uncertainFixtureIds: UncertainFixtureIds = {
		accountIds: new Set(),
		actorUserIds: new Set(),
		jobIds: new Set(),
		quoteIds: new Set(),
		reservationIds: new Set(),
	};

	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl() }),
		});
	});

	afterAll(async () => {
		if (!client) return;
		try {
			await cleanupUncertainFixtures(client, uncertainFixtureIds);
		} finally {
			await client.$disconnect();
		}
	});

	it("replays a failed persisted event exactly once and audits the operation", async () => {
		const suffix = crypto.randomUUID();
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `admin-test-${suffix}`,
				verifiedAt: new Date(),
				envelope: { privateFixture: "must-not-be-returned" },
				status: "FAILED",
				failureReason: "DEPENDENCY_UNAVAILABLE",
			},
		});
		const input = {
			eventKind: "PAYMENT" as const,
			eventId: event.id,
			actorUserId: `admin-${suffix}`,
			idempotencyKey: `replay-${suffix}`,
			reason: "Dependency recovered and event is safe to replay",
		};
		const first = await replayPersistedMediaEvent(input, client);
		const second = await replayPersistedMediaEvent(input, client);
		expect(first).toMatchObject({ eventId: event.id, replayed: false });
		expect(second).toMatchObject({ eventId: event.id, replayed: true });
		expect(await client.paymentEvent.findUnique({ where: { id: event.id } })).toMatchObject({
			status: "RECEIVED",
			failureReason: null,
		});
		expect(
			await client.outboxEvent.count({
				where: { dedupeKey: `admin-replay:PAYMENT:${event.id}:${input.idempotencyKey}` },
			}),
		).toBe(1);
		expect(
			await client.auditLog.count({ where: { targetId: `operation:${input.idempotencyKey}` } }),
		).toBe(1);
	});

	it("versions, supersedes, and rolls back runtime overrides with audits", async () => {
		const suffix = crypto.randomUUID();
		const first = await setAdminMediaRuntimeOverride(
			{
				configKey: "media.model.image-fast.enabled",
				value: false,
				actorUserId: `admin-${suffix}`,
				idempotencyKey: `override-a-${suffix}`,
				reason: "Disable model after elevated provider failures",
			},
			client,
		);
		const second = await setAdminMediaRuntimeOverride(
			{
				configKey: "media.model.image-fast.enabled",
				value: true,
				actorUserId: `admin-${suffix}`,
				idempotencyKey: `override-b-${suffix}`,
				reason: "Enable model after successful recovery checks",
			},
			client,
		);
		expect(second.version).toBeGreaterThan(first.version as number);
		expect(
			await client.runtimeConfigOverride.findUnique({ where: { id: first.id as string } }),
		).toMatchObject({ active: false });
		const rolledBack = await rollbackAdminMediaRuntimeOverride(
			{
				overrideId: second.id as string,
				actorUserId: `admin-${suffix}`,
				idempotencyKey: `rollback-${suffix}`,
				reason: "Restore catalog defaults after incident resolution",
			},
			client,
		);
		expect(rolledBack).toMatchObject({ id: second.id, replayed: false });
		expect(
			await client.runtimeConfigOverride.findUnique({ where: { id: second.id as string } }),
		).toMatchObject({ active: false });
	});

	it("rejects reuse of an operation key with different parameters", async () => {
		const suffix = crypto.randomUUID();
		const idempotencyKey = `conflict-${suffix}`;
		await setAdminMediaRuntimeOverride(
			{
				configKey: "media.model.video-fast.enabled",
				value: false,
				actorUserId: `admin-${suffix}`,
				idempotencyKey,
				reason: "Disable model after elevated provider failures",
			},
			client,
		);
		await expect(
			setAdminMediaRuntimeOverride(
				{
					configKey: "media.model.video-quality.enabled",
					value: false,
					actorUserId: `admin-${suffix}`,
					idempotencyKey,
					reason: "A different operation must not replay",
				},
				client,
			),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
	});

	it("rejects reuse of an operation key across operation types", async () => {
		const suffix = crypto.randomUUID();
		const idempotencyKey = `cross-kind-${suffix}`;
		const created = await setAdminMediaRuntimeOverride(
			{
				configKey: "media.model.video-fast.enabled",
				value: false,
				actorUserId: `admin-${suffix}`,
				idempotencyKey,
				reason: "Create an override for cross-operation fencing",
			},
			client,
		);
		await expect(
			rollbackAdminMediaRuntimeOverride(
				{
					overrideId: created.id,
					actorUserId: `admin-${suffix}`,
					idempotencyKey,
					reason: "A different operation must not replay",
				},
				client,
			),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
	});

	it("serializes concurrent override and rollback using the same operation key", async () => {
		const suffix = crypto.randomUUID();
		const target = await setAdminMediaRuntimeOverride(
			{
				configKey: "media.model.image-quality.enabled",
				value: false,
				actorUserId: `admin-${suffix}`,
				idempotencyKey: `seed-${suffix}`,
				reason: "Seed override for concurrent operation key test",
			},
			client,
		);
		const sharedKey = `shared-${suffix}`;
		const results = await Promise.allSettled([
			setAdminMediaRuntimeOverride(
				{
					configKey: "media.model.video-quality.enabled",
					value: false,
					actorUserId: `admin-${suffix}`,
					idempotencyKey: sharedKey,
					reason: "Concurrent set operation should win or conflict",
				},
				client,
			),
			rollbackAdminMediaRuntimeOverride(
				{
					overrideId: target.id,
					actorUserId: `admin-${suffix}`,
					idempotencyKey: sharedKey,
					reason: "Concurrent rollback should win or conflict",
				},
				client,
			),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(await client.auditLog.count({ where: { targetId: `operation:${sharedKey}` } })).toBe(1);
	});

	it("coalesces concurrent event replay requests for the same target", async () => {
		const suffix = crypto.randomUUID();
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `concurrent-replay-${suffix}`,
				verifiedAt: new Date(),
				envelope: {},
				status: "FAILED",
			},
		});
		const results = await Promise.allSettled(
			["a", "b"].map((key) =>
				replayPersistedMediaEvent(
					{
						eventKind: "PAYMENT",
						eventId: event.id,
						actorUserId: `admin-${suffix}`,
						idempotencyKey: `concurrent-${key}-${suffix}`,
						reason: "Concurrent recovery should produce one active event",
					},
					client,
				),
			),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(
			await client.outboxEvent.count({
				where: {
					aggregateId: event.id,
					eventType: "PAYMENT_EVENT_RECEIVED",
					status: { in: ["PENDING", "LEASED"] },
				},
			}),
		).toBe(1);
	});

	it("coalesces concurrent finalization retries for the same job", async () => {
		const suffix = crypto.randomUUID();
		const quote = await client.generationQuote.create({
			data: {
				ownerType: "USER",
				ownerId: `owner-${suffix}`,
				submittedByUserId: `owner-${suffix}`,
				productKey: "image-fast",
				catalogVersion: "test-v1",
				pricingVersion: "test-v1",
				credits: 1n,
				costMicros: 0n,
				inputSnapshot: {},
				pricingSnapshot: {},
				expiresAt: new Date(Date.now() + 60_000),
			},
		});
		const job = await client.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId: `owner-${suffix}`,
				submittedByUserId: `owner-${suffix}`,
				quoteId: quote.id,
				idempotencyKey: `job-${suffix}`,
				productKey: "image-fast",
				catalogVersion: "test-v1",
				pricingVersion: "test-v1",
				creditsReserved: 1n,
				inputSnapshot: {},
				pricingSnapshot: {},
				status: "FINALIZING",
			},
		});
		await client.outboxEvent.create({
			data: {
				eventType: "GENERATION_FINALIZE",
				aggregateType: "GENERATION_JOB",
				aggregateId: job.id,
				dedupeKey: `historical-finalize-${suffix}`,
				payload: { jobId: job.id },
				status: "PROCESSED",
				processedAt: new Date(),
			},
		});
		const results = await Promise.allSettled(
			["a", "b"].map((key) =>
				retryAdminMediaJobStage(
					{
						jobId: job.id,
						stage: "FINALIZE",
						actorUserId: `admin-${suffix}`,
						idempotencyKey: `finalize-${key}-${suffix}`,
						reason: "Concurrent recovery must only queue one finalization",
					},
					client,
				),
			),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(
			await client.outboxEvent.count({
				where: {
					aggregateId: job.id,
					eventType: "GENERATION_FINALIZE_RETRY",
					status: { in: ["PENDING", "LEASED"] },
				},
			}),
		).toBe(1);
	});

	it("rejects a finalization retry while the original finalization event is active", async () => {
		const suffix = crypto.randomUUID();
		const quote = await client.generationQuote.create({
			data: {
				ownerType: "USER",
				ownerId: `active-owner-${suffix}`,
				submittedByUserId: `active-owner-${suffix}`,
				productKey: "image-fast",
				catalogVersion: "test-v1",
				pricingVersion: "test-v1",
				credits: 1n,
				costMicros: 0n,
				inputSnapshot: {},
				pricingSnapshot: {},
				expiresAt: new Date(Date.now() + 60_000),
			},
		});
		const job = await client.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId: `active-owner-${suffix}`,
				submittedByUserId: `active-owner-${suffix}`,
				quoteId: quote.id,
				idempotencyKey: `active-job-${suffix}`,
				productKey: "image-fast",
				catalogVersion: "test-v1",
				pricingVersion: "test-v1",
				creditsReserved: 1n,
				inputSnapshot: {},
				pricingSnapshot: {},
				status: "FINALIZING",
			},
		});
		await client.outboxEvent.create({
			data: {
				eventType: "GENERATION_FINALIZE",
				aggregateType: "GENERATION_JOB",
				aggregateId: job.id,
				dedupeKey: `active-finalize-${suffix}`,
				payload: { jobId: job.id },
				status: "PENDING",
			},
		});
		await expect(
			retryAdminMediaJobStage(
				{
					jobId: job.id,
					stage: "FINALIZE",
					actorUserId: `admin-${suffix}`,
					idempotencyKey: `active-retry-${suffix}`,
					reason: "Must not overlap original finalization",
				},
				client,
			),
		).rejects.toThrow("OPERATION_ALREADY_PENDING");
	});

	it("resolves uncertain submissions only with provider evidence and idempotent admin decisions", async () => {
		const accepted = await seedUncertainAttempt(client, uncertainFixtureIds);
		const acceptedInput = {
			attemptId: accepted.attemptId,
			resolution: "ACCEPTED" as const,
			providerTaskId: `provider-task-${crypto.randomUUID()}`,
			providerEvidenceReference: "provider-dashboard-case-accepted-123",
			actorUserId: accepted.actorUserId,
			idempotencyKey: `accepted-${crypto.randomUUID()}`,
			reason: "Provider dashboard confirms the request was accepted",
		};
		expect(await resolveAdminUncertainSubmission(acceptedInput, client)).toMatchObject({
			resolution: "ACCEPTED",
			replayed: false,
		});
		expect(await resolveAdminUncertainSubmission(acceptedInput, client)).toMatchObject({
			replayed: true,
		});
		expect(
			await client.generationAttempt.findUniqueOrThrow({ where: { id: accepted.attemptId } }),
		).toMatchObject({
			status: "SUBMITTED",
			providerTaskId: acceptedInput.providerTaskId,
			uncertainSubmission: false,
		});
		expect(
			await client.creditReservation.findUniqueOrThrow({ where: { jobId: accepted.jobId } }),
		).toMatchObject({ status: "ACTIVE", settledAmount: 0n, releasedAmount: 0n });

		const rejected = await seedUncertainAttempt(client, uncertainFixtureIds);
		const rejectedInput = {
			attemptId: rejected.attemptId,
			resolution: "REJECTED" as const,
			providerEvidenceReference: "provider-dashboard-case-rejected-456",
			actorUserId: rejected.actorUserId,
			idempotencyKey: `rejected-${crypto.randomUUID()}`,
			reason: "Provider dashboard confirms the request was rejected",
		};
		expect(await resolveAdminUncertainSubmission(rejectedInput, client)).toMatchObject({
			resolution: "REJECTED",
			replayed: false,
		});
		expect(
			await client.generationJob.findUniqueOrThrow({ where: { id: rejected.jobId } }),
		).toMatchObject({ status: "FINALIZING", failureCode: "SUBMISSION_REJECTED_CONFIRMED" });
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: rejected.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).toBe(1);
	});

	it("enforces provider-specific accepted reconciliation capabilities", async () => {
		const fal = await seedUncertainAttempt(client, uncertainFixtureIds, "fal");
		const falInput = {
			attemptId: fal.attemptId,
			resolution: "ACCEPTED" as const,
			providerTaskId: `fal-task-${crypto.randomUUID()}`,
			providerEvidenceReference: "provider-dashboard-fal-accepted-123",
			actorUserId: fal.actorUserId,
			idempotencyKey: `fal-accepted-${crypto.randomUUID()}`,
			reason: "Fal dashboard confirms the request was accepted",
		};
		await expect(resolveAdminUncertainSubmission(falInput, client)).rejects.toThrow(
			"FAL_RECONCILIATION_ENDPOINT_REQUIRED",
		);
		await expect(
			resolveAdminUncertainSubmission(
				{ ...falInput, resultUrl: "https://queue.fal.run.attacker.example/task" },
				client,
			),
		).rejects.toThrow("UNSAFE_FAL_RECONCILIATION_ENDPOINT");
		await expect(
			resolveAdminUncertainSubmission(
				{ ...falInput, resultUrl: "https://queue.fal.run/task" },
				client,
			),
		).resolves.toMatchObject({ resolution: "ACCEPTED", replayed: false });

		const gemini = await seedUncertainAttempt(client, uncertainFixtureIds, "gemini");
		await expect(
			resolveAdminUncertainSubmission(
				{
					attemptId: gemini.attemptId,
					resolution: "ACCEPTED",
					providerTaskId: `gemini-task-${crypto.randomUUID()}`,
					providerEvidenceReference: "provider-dashboard-gemini-accepted-123",
					actorUserId: gemini.actorUserId,
					idempotencyKey: `gemini-accepted-${crypto.randomUUID()}`,
					reason: "Provider dashboard reports an accepted synchronous request",
				},
				client,
			),
		).rejects.toThrow("PROVIDER_ACCEPTANCE_CANNOT_BE_RECONCILED");
	});

	it("returns JSON-safe aggregate diagnostics with no payload fields", async () => {
		const diagnostics = await getAdminMediaDiagnostics(client);
		const serialized = JSON.stringify(diagnostics);
		expect(serialized).not.toMatch(
			/prompt|rawPayload|requestBody|responseBody|envelope|signature|signedUrl|objectKey|sourceUrl|token|url/i,
		);
		expect(diagnostics).toHaveProperty("queue.depth");
		expect(diagnostics).toHaveProperty("finance.marginMicros");
	});

	it("uses processed event time for revenue and completed time for provider cost", async () => {
		const suffix = crypto.randomUUID();
		const before = await getAdminMediaDiagnostics(client);
		const old = new Date("2026-01-01T00:00:00Z");
		await client.paymentEvent.createMany({
			data: [
				{
					provider: "stripe",
					providerEventId: `invoice-${suffix}`,
					verifiedAt: old,
					receivedAt: old,
					processedAt: new Date(),
					status: "PROCESSED" as const,
					envelope: { type: "invoice.paid", data: { object: { amount_paid: 100 } } },
				},
				{
					provider: "stripe",
					providerEventId: `refund-${suffix}`,
					verifiedAt: old,
					receivedAt: old,
					processedAt: new Date(),
					status: "PROCESSED" as const,
					envelope: { type: "refund.created", data: { object: { amount: 25 } } },
				},
				{
					provider: "stripe",
					providerEventId: `charge-refund-${suffix}`,
					verifiedAt: old,
					receivedAt: old,
					processedAt: new Date(),
					status: "PROCESSED" as const,
					envelope: {
						type: "charge.refund.updated",
						data: { object: { amount: 15 } },
					},
				},
			],
		});
		const quote = await client.generationQuote.create({
			data: {
				ownerType: "USER",
				ownerId: `finance-owner-${suffix}`,
				submittedByUserId: `finance-owner-${suffix}`,
				productKey: "image-fast",
				catalogVersion: "test-v1",
				pricingVersion: "test-v1",
				credits: 1n,
				costMicros: 0n,
				inputSnapshot: {},
				pricingSnapshot: {},
				createdAt: old,
				expiresAt: new Date(Date.now() + 60_000),
			},
		});
		const job = await client.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId: `finance-owner-${suffix}`,
				submittedByUserId: `finance-owner-${suffix}`,
				quoteId: quote.id,
				idempotencyKey: `finance-job-${suffix}`,
				productKey: "image-fast",
				catalogVersion: "test-v1",
				pricingVersion: "test-v1",
				creditsReserved: 1n,
				inputSnapshot: {},
				pricingSnapshot: {},
				createdAt: old,
			},
		});
		await client.generationAttempt.create({
			data: {
				jobId: job.id,
				attemptNumber: 1,
				provider: "replicate",
				providerModelId: "test-model",
				requestSnapshot: {},
				status: "SUCCEEDED",
				providerCostMicros: 125_000n,
				createdAt: old,
				completedAt: new Date(),
			},
		});
		const after = await getAdminMediaDiagnostics(client);
		expect(BigInt(after.finance.revenueMicros) - BigInt(before.finance.revenueMicros)).toBe(
			1_000_000n,
		);
		expect(BigInt(after.finance.refundedMicros) - BigInt(before.finance.refundedMicros)).toBe(
			400_000n,
		);
		expect(
			BigInt(after.finance.providerCostMicros) - BigInt(before.finance.providerCostMicros),
		).toBe(125_000n);
	});
});

async function seedUncertainAttempt(
	client: PrismaClient,
	fixtureIds: UncertainFixtureIds,
	provider: "replicate" | "fal" | "kie" | "gemini" = "replicate",
) {
	const suffix = crypto.randomUUID();
	const ownerId = `uncertain-owner-${suffix}`;
	const actorUserId = `uncertain-admin-${suffix}`;
	fixtureIds.actorUserIds.add(actorUserId);
	const account = await client.creditAccount.create({
		data: { ownerType: "USER", ownerId },
	});
	fixtureIds.accountIds.add(account.id);
	await createCreditGrant(
		{
			accountId: account.id,
			amount: 4n,
			referenceKey: `uncertain-grant-${suffix}`,
		},
		client,
	);
	const quoteInput = {
		ownerType: "USER",
		ownerId,
		submittedByUserId: ownerId,
		productKey: "image-fast",
		catalogVersion: "test-v1",
		pricingVersion: "test-v1",
		credits: 4n,
		costMicros: 1_000n,
		inputSnapshot: {},
		pricingSnapshot: {},
		expiresAt: new Date(Date.now() + 60_000),
	} as const;
	const quote = await createModeratedGenerationQuoteTransaction(
		{
			...quoteInput,
			moderation: {
				decision: "ALLOW",
				provider: "test",
				ruleVersion: "TEST_ALLOW_ADMIN_INTEGRATION_V1",
				reasonCode: "TEST_ALLOW_ADMIN_INTEGRATION",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
			},
		},
		client,
	);
	fixtureIds.quoteIds.add(quote.id);
	const created = await createGenerationJobTransaction(
		{
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: `uncertain-job-${suffix}`,
			inputAssetIds: [],
			expectedModerationRuleVersion: "TEST_ALLOW_ADMIN_INTEGRATION_V1",
		},
		client,
	);
	fixtureIds.jobIds.add(created.job.id);
	fixtureIds.reservationIds.add(created.reservation.id);
	const attempt = await client.$transaction(async (tx) => {
		await tx.generationJob.update({
			where: { id: created.job.id },
			data: {
				status: "NEEDS_RECONCILIATION",
				failureCode: "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
			},
		});
		return tx.generationAttempt.create({
			data: {
				jobId: created.job.id,
				attemptNumber: 1,
				provider,
				providerModelId: "test-model",
				status: "NEEDS_RECONCILIATION",
				uncertainSubmission: true,
				requestSnapshot: {},
			},
		});
	});
	return { actorUserId, attemptId: attempt.id, jobId: created.job.id };
}

interface UncertainFixtureIds {
	accountIds: Set<string>;
	actorUserIds: Set<string>;
	jobIds: Set<string>;
	quoteIds: Set<string>;
	reservationIds: Set<string>;
}

async function cleanupUncertainFixtures(client: PrismaClient, fixtureIds: UncertainFixtureIds) {
	const accountIds = [...fixtureIds.accountIds];
	const actorUserIds = [...fixtureIds.actorUserIds];
	const jobIds = [...fixtureIds.jobIds];
	const quoteIds = [...fixtureIds.quoteIds];
	const reservationIds = [...fixtureIds.reservationIds];
	if (accountIds.length === 0 && jobIds.length === 0 && quoteIds.length === 0) return;

	await client.$transaction(async (tx) => {
		await tx.auditLog.deleteMany({ where: { actorUserId: { in: actorUserIds } } });
		await tx.outboxEvent.deleteMany({ where: { aggregateId: { in: jobIds } } });
		await tx.generationAttempt.deleteMany({ where: { jobId: { in: jobIds } } });
		await tx.$executeRaw`ALTER TABLE "credit_ledger_entry" DISABLE TRIGGER "credit_ledger_entry_immutable"`;
		await tx.creditLedgerEntry.deleteMany({ where: { accountId: { in: accountIds } } });
		await tx.$executeRaw`ALTER TABLE "credit_ledger_entry" ENABLE TRIGGER "credit_ledger_entry_immutable"`;
		await tx.creditReservationAllocation.deleteMany({
			where: { reservationId: { in: reservationIds } },
		});
		await tx.creditReservation.deleteMany({ where: { id: { in: reservationIds } } });
		await tx.generationJob.deleteMany({ where: { id: { in: jobIds } } });
		await tx.generationQuote.deleteMany({ where: { id: { in: quoteIds } } });
		await tx.creditLot.deleteMany({ where: { accountId: { in: accountIds } } });
		await tx.creditAccount.deleteMany({ where: { id: { in: accountIds } } });
	});
}
