import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createCreditGrant,
	createGenerationJobTransaction,
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
	getAdminMediaDiagnostics,
	listAdminUncertainGenerationAttempts,
	replayPersistedMediaEvent,
	resolveAdminUncertainSubmission,
	retryAdminMediaJobStage,
	rollbackAdminMediaRuntimeOverride,
	setAdminMediaRuntimeOverride,
} from ".";
import { PrismaClient, type Prisma } from "../../generated/client";

interface SafePaymentEventDiagnostic {
	id: string;
	providerEventId: string;
	status: "FAILED" | "DEAD_LETTER" | "IGNORED";
	attemptCount: number;
	lastTriggerAttempt: number | null;
	lastAttemptAt: string | null;
	lastTriggerRunId: string | null;
	lastErrorClass: string | null;
}

interface PaymentDiagnostics {
	events: {
		payment: Record<
			"failed" | "deadLetter" | "ignored",
			{ count: number; items: SafePaymentEventDiagnostic[] }
		>;
	};
	stripeReconciliation: {
		checkpoint: null | {
			provider: string;
			status: string;
			stage: string;
			pages: number;
			failures: number;
			cutoff: string | null;
			lastAttempt: string | null;
			lastCompleted: string | null;
			lastError: string | null;
			hasCursor: boolean;
			leaseActive: boolean;
		};
		issues: {
			openCount: number;
			items: Array<{
				code: string;
				entityType: string;
				providerObjectId: string;
				stage: string;
				occurrences: number;
				firstSeenAt: string;
				lastSeenAt: string;
			}>;
		};
		historicalRefunds: {
			needsReviewCount: number;
			missingLifecycleCount: number;
			items: Array<{
				providerRefundId: string;
				reason:
					| "MISSING_LIFECYCLE"
					| "NON_SUCCEEDED_LIFECYCLE"
					| "FINALIZATION_MISSING"
					| "CREDIT_TOTAL_MISMATCH";
				lifecycleStatus: string | null;
				ledgerEntryCount: number;
				ledgerCredits: string;
				finalizedCredits: string | null;
				creditsFinalizedAt: string | null;
				firstLedgerAt: string;
				lastLedgerAt: string;
			}>;
		};
	};
}

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
		const lastAttemptAt = new Date("2026-08-23T12:00:00.000Z");
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `admin-test-${suffix}`,
				verifiedAt: new Date(),
				envelope: { privateFixture: "must-not-be-returned" },
				status: "FAILED",
				failureReason: "DEPENDENCY_UNAVAILABLE",
				attemptCount: 4,
				lastTriggerAttempt: 5,
				lastAttemptAt,
				lastTriggerRunId: `trigger-run-${suffix}`,
				lastErrorClass: "TRANSIENT",
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
			attemptCount: 0,
			lastTriggerAttempt: null,
			lastAttemptAt: null,
			lastTriggerRunId: null,
			lastErrorClass: null,
		});
		expect(
			await client.outboxEvent.count({
				where: { dedupeKey: `admin-replay:PAYMENT:${event.id}:${input.idempotencyKey}` },
			}),
		).toBe(1);
		const audit = await client.auditLog.findFirstOrThrow({
			where: {
				action: "MEDIA_EVENT_REPLAYED",
				targetId: `operation:${input.idempotencyKey}`,
			},
		});
		expect(audit.before).toEqual({
			status: "FAILED",
			failureReason: "DEPENDENCY_UNAVAILABLE",
			attemptCount: 4,
			lastTriggerAttempt: 5,
			lastAttemptAt: lastAttemptAt.toISOString(),
			lastTriggerRunId: `trigger-run-${suffix}`,
			lastErrorClass: "TRANSIENT",
		});
	});

	it("does not clear newer payment retry evidence during replay", async () => {
		const suffix = crypto.randomUUID();
		const initialAttemptAt = new Date("2026-08-23T12:00:00.000Z");
		const newerAttemptAt = new Date("2026-08-23T12:01:00.000Z");
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `replay-race-${suffix}`,
				verifiedAt: new Date(),
				envelope: {},
				status: "FAILED",
				failureReason: "INITIAL_FAILURE",
				attemptCount: 1,
				lastTriggerAttempt: 1,
				lastAttemptAt: initialAttemptAt,
				lastTriggerRunId: `initial-run-${suffix}`,
				lastErrorClass: "TRANSIENT",
			},
		});
		let injectedNewerFailure = false;
		const racingClient = new Proxy(client, {
			get(target, property, receiver) {
				if (property !== "$transaction") return Reflect.get(target, property, receiver);
				return async <T>(
					operation: (transaction: Prisma.TransactionClient) => Promise<T>,
					options?: Parameters<typeof client.$transaction>[1],
				) =>
					target.$transaction(async (transaction) => {
						const paymentEvent = new Proxy(transaction.paymentEvent, {
							get(delegate, delegateProperty, delegateReceiver) {
								if (delegateProperty !== "findUnique") {
									return Reflect.get(delegate, delegateProperty, delegateReceiver);
								}
								return async (...args: Parameters<typeof transaction.paymentEvent.findUnique>) => {
									const snapshot = await transaction.paymentEvent.findUnique(...args);
									if (!injectedNewerFailure && snapshot?.id === event.id) {
										injectedNewerFailure = true;
										await client.paymentEvent.update({
											where: { id: event.id },
											data: {
												status: "FAILED",
												failureReason: "NEWER_FAILURE",
												attemptCount: 2,
												lastTriggerAttempt: 2,
												lastAttemptAt: newerAttemptAt,
												lastTriggerRunId: `newer-run-${suffix}`,
												lastErrorClass: "TRANSIENT",
											},
										});
									}
									return snapshot;
								};
							},
						});
						return operation(
							new Proxy(transaction, {
								get(transactionTarget, transactionProperty, transactionReceiver) {
									return transactionProperty === "paymentEvent"
										? paymentEvent
										: Reflect.get(transactionTarget, transactionProperty, transactionReceiver);
								},
							}),
						);
					}, options);
			},
		});

		await expect(
			replayPersistedMediaEvent(
				{
					eventKind: "PAYMENT",
					eventId: event.id,
					actorUserId: `admin-${suffix}`,
					idempotencyKey: `replay-race-${suffix}`,
					reason: "Do not replace newly recorded retry evidence",
				},
				racingClient,
			),
		).rejects.toThrow("EVENT_NOT_REPLAYABLE");
		expect(injectedNewerFailure).toBe(true);
		expect(await client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			status: "FAILED",
			failureReason: "NEWER_FAILURE",
			attemptCount: 2,
			lastTriggerAttempt: 2,
			lastAttemptAt: newerAttemptAt,
			lastTriggerRunId: `newer-run-${suffix}`,
			lastErrorClass: "TRANSIENT",
		});
		expect(
			await client.auditLog.count({
				where: { action: "MEDIA_EVENT_REPLAYED", targetId: `operation:replay-race-${suffix}` },
			}),
		).toBe(0);
		expect(
			await client.outboxEvent.count({
				where: { dedupeKey: `admin-replay:PAYMENT:${event.id}:replay-race-${suffix}` },
			}),
		).toBe(0);
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

	it.each([
		"PROVIDER_ADAPTER_UNAVAILABLE",
		"QUOTED_ROUTE_UNAVAILABLE",
		"LEGACY_QUOTE_ROUTE_UNAVAILABLE",
	] as const)(
		"requeues an explicit no-submit %s recovery while preserving its active reservation",
		async (failureCode) => {
			const fixture = await seedUncertainAttempt(client, uncertainFixtureIds);
			await client.$transaction(async (tx) => {
				await tx.generationJob.update({
					where: { id: fixture.jobId },
					data: { failureCode },
				});
				await tx.generationAttempt.update({
					where: { id: fixture.attemptId },
					data: {
						uncertainSubmission: false,
						providerTaskId: null,
						submittedAt: new Date(),
						errorSnapshot: { code: failureCode },
					},
				});
			});

			await expect(
				retryAdminMediaJobStage(
					{
						jobId: fixture.jobId,
						stage: "DISPATCH",
						actorUserId: fixture.actorUserId,
						idempotencyKey: `retry-no-submit-${failureCode}-${crypto.randomUUID()}`,
						reason: "Provider configuration is available again and no submission occurred",
					},
					client,
				),
			).resolves.toMatchObject({ jobId: fixture.jobId, stage: "DISPATCH", replayed: false });

			const [job, attempt, reservation, dispatchEvents] = await Promise.all([
				client.generationJob.findUniqueOrThrow({ where: { id: fixture.jobId } }),
				client.generationAttempt.findUniqueOrThrow({ where: { id: fixture.attemptId } }),
				client.creditReservation.findUniqueOrThrow({ where: { jobId: fixture.jobId } }),
				client.outboxEvent.findMany({
					where: { aggregateId: fixture.jobId, eventType: "GENERATION_DISPATCH" },
				}),
			]);
			expect(job).toMatchObject({ status: "DISPATCH_QUEUED", failureCode: null });
			expect(attempt).toMatchObject({
				status: "CREATED",
				uncertainSubmission: false,
				providerTaskId: null,
				submittedAt: null,
				nextReconcileAt: null,
			});
			expect(reservation).toMatchObject({
				status: "ACTIVE",
				settledAmount: 0n,
				releasedAmount: 0n,
			});
			expect(dispatchEvents).toHaveLength(1);
			expect(dispatchEvents[0]).toMatchObject({
				status: "PENDING",
				payload: { jobId: fixture.jobId, version: job.version },
			});
		},
	);

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

	it("separates safe payment-event diagnostics by processing status", async () => {
		const suffix = crypto.randomUUID();
		const lastAttemptAt = new Date("2026-08-23T12:00:00.000Z");
		const secret = `must-not-leak-${suffix}`;
		const events = await Promise.all(
			(["FAILED", "DEAD_LETTER", "IGNORED"] as const).map((status, index) =>
				client.paymentEvent.create({
					data: {
						provider: "stripe",
						providerEventId: `diagnostic-${status.toLowerCase()}-${suffix}`,
						verifiedAt: new Date(),
						envelope: { rawPayload: secret, nested: { token: secret } },
						status,
						attemptCount: index + 1,
						lastTriggerAttempt: index + 2,
						lastAttemptAt,
						lastTriggerRunId: `diagnostic-run-${status.toLowerCase()}-${suffix}`,
						lastErrorClass: status === "IGNORED" ? null : "TRANSIENT",
					},
				}),
			),
		);
		const diagnostics = (await getAdminMediaDiagnostics(client)) as unknown as PaymentDiagnostics;
		const expected = [
			{ bucket: diagnostics.events.payment.failed, event: events[0]! },
			{ bucket: diagnostics.events.payment.deadLetter, event: events[1]! },
			{ bucket: diagnostics.events.payment.ignored, event: events[2]! },
		];
		for (const { bucket, event } of expected) {
			expect(bucket.count).toBeGreaterThan(0);
			expect(bucket.items).toContainEqual({
				id: event.id,
				providerEventId: event.providerEventId,
				status: event.status,
				attemptCount: event.attemptCount,
				lastTriggerAttempt: event.lastTriggerAttempt,
				lastAttemptAt: lastAttemptAt.toISOString(),
				lastTriggerRunId: event.lastTriggerRunId,
				lastErrorClass: event.lastErrorClass,
			});
		}
		expect(JSON.stringify(diagnostics)).not.toContain(secret);
	});

	it("lists uncertain attempts through a narrow recovery projection", async () => {
		const fixture = await seedUncertainAttempt(client, uncertainFixtureIds, "fal");
		await client.generationJob.update({
			where: { id: fixture.jobId },
			data: { failureCode: "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION" },
		});
		await client.generationAttempt.update({
			where: { id: fixture.attemptId },
			data: {
				providerTaskId: "provider-task-secret",
				providerStatusUrl: "https://queue.fal.run/task?signature=secret",
				providerResultUrl: "https://queue.fal.run/result?token=secret",
				submissionToken: "submission-secret",
				requestSnapshot: { prompt: "private prompt", rawPayload: "request-secret" },
				responseSnapshot: { signedUrl: "https://cdn.example/output?signature=secret" },
				errorSnapshot: { rawPayload: "error-secret" },
			},
		});

		const diagnostics = await listAdminUncertainGenerationAttempts({ limit: 100 }, client);
		const item = diagnostics.find((diagnostic) => diagnostic.ids.attemptId === fixture.attemptId);

		expect(item).toEqual({
			ids: {
				attemptId: fixture.attemptId,
				jobId: fixture.jobId,
				reservationId: fixture.reservationId,
			},
			route: { provider: "fal", providerModelId: "test-model" },
			status: { attempt: "NEEDS_RECONCILIATION", job: "NEEDS_RECONCILIATION" },
			timestamps: {
				createdAt: expect.any(String),
				updatedAt: expect.any(String),
				submittedAt: null,
				completedAt: null,
				lastProviderEventAt: null,
				nextReconcileAt: null,
			},
			retryCount: 0,
			reservationStatus: "ACTIVE",
			reasonCode: "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
		});
		expect(JSON.stringify(item)).not.toMatch(
			/providerTaskId|providerStatusUrl|providerResultUrl|submissionToken|requestSnapshot|responseSnapshot|errorSnapshot|prompt|rawPayload|signature|token|secret/i,
		);

		await client.generationJob.update({
			where: { id: fixture.jobId },
			data: { failureCode: "UNSAFE_REASON_WITH_SECRET" },
		});
		const [redacted] = (await listAdminUncertainGenerationAttempts({ limit: 100 }, client)).filter(
			(diagnostic) => diagnostic.ids.attemptId === fixture.attemptId,
		);
		expect(redacted?.reasonCode).toBe("SUBMISSION_UNCERTAIN");
	});

	it("returns only allowlisted Stripe reconciliation diagnostics", async () => {
		const suffix = crypto.randomUUID();
		const sweepId = `admin-diagnostic-sweep-${suffix}`;
		const checkpointId = "stripe-billing-reconciliation";
		const secretCursor = `secret-cursor-${suffix}`;
		const secretLeaseToken = `secret-lease-token-${suffix}`;
		const secretDetails = `secret-provider-envelope-${suffix}`;
		const cutoff = new Date("2026-08-23T10:00:00.000Z");
		const lastAttempt = new Date("2026-08-23T10:01:00.000Z");
		const lastCompleted = new Date("2026-08-22T10:00:00.000Z");
		const previous = await client.stripeReconciliationCheckpoint.findUnique({
			where: { provider: "stripe" },
		});
		try {
			await client.stripeReconciliationCheckpoint.upsert({
				where: { provider: "stripe" },
				create: {
					id: checkpointId,
					provider: "stripe",
					status: "RUNNING",
					sweepId,
					sweepCutoff: cutoff,
					stage: "INVOICES",
					cursor: secretCursor,
					leaseToken: secretLeaseToken,
					leasedUntil: new Date(Date.now() + 60_000),
					pagesProcessed: 7,
					failureCount: 2,
					lastAttemptAt: lastAttempt,
					lastCompletedAt: lastCompleted,
					lastErrorCode: secretDetails,
				},
				update: {
					status: "RUNNING",
					sweepId,
					sweepCutoff: cutoff,
					stage: "INVOICES",
					cursor: secretCursor,
					leaseToken: secretLeaseToken,
					leasedUntil: new Date(Date.now() + 60_000),
					pagesProcessed: 7,
					failureCount: 2,
					lastAttemptAt: lastAttempt,
					lastCompletedAt: lastCompleted,
					lastErrorCode: secretDetails,
				},
			});
			await client.stripeReconciliationIssue.createMany({
				data: Array.from({ length: 26 }, (_, index) => ({
					issueKey: `admin-diagnostic-issue-${suffix}-${index}`,
					provider: "stripe",
					sweepId,
					stage: "INVOICES" as const,
					code: index === 25 ? secretDetails : "STRIPE_INVOICE_PAYMENT_METHOD_UNSUPPORTED",
					entityType: "invoice",
					providerObjectId: `in_admin_diagnostic_${suffix}_${index}`,
					status: "OPEN" as const,
					details: {
						rawError: secretDetails,
						envelope: { authorization: secretDetails },
					},
					occurrences: index + 1,
					firstSeenAt: new Date(Date.UTC(2099, 0, 1, 0, 0, index)),
					lastSeenAt: new Date(Date.UTC(2099, 0, 2, 0, 0, index)),
				})),
			});

			const diagnostics = (await getAdminMediaDiagnostics(client)) as unknown as PaymentDiagnostics;
			const reconciliation = diagnostics.stripeReconciliation;
			expect(reconciliation.checkpoint).toEqual({
				provider: "stripe",
				status: "RUNNING",
				stage: "INVOICES",
				pages: 7,
				failures: 2,
				cutoff: cutoff.toISOString(),
				lastAttempt: lastAttempt.toISOString(),
				lastCompleted: lastCompleted.toISOString(),
				lastError: "STRIPE_RECONCILIATION_ERROR_REDACTED",
				hasCursor: true,
				leaseActive: true,
			});
			expect(reconciliation.checkpoint).not.toHaveProperty("cursor");
			expect(reconciliation.checkpoint).not.toHaveProperty("leaseToken");
			expect(reconciliation.checkpoint).not.toHaveProperty("leasedUntil");
			expect(reconciliation.issues.openCount).toBeGreaterThanOrEqual(26);
			expect(reconciliation.issues.items).toHaveLength(25);
			for (const issue of reconciliation.issues.items) {
				expect(Object.keys(issue).sort()).toEqual(
					[
						"code",
						"entityType",
						"firstSeenAt",
						"lastSeenAt",
						"occurrences",
						"providerObjectId",
						"stage",
					].sort(),
				);
			}
			const serialized = JSON.stringify(reconciliation);
			expect(serialized).not.toContain(secretCursor);
			expect(serialized).not.toContain(secretLeaseToken);
			expect(serialized).not.toContain(secretDetails);
			expect(serialized).not.toContain('"details"');
		} finally {
			await client.stripeReconciliationIssue.deleteMany({ where: { sweepId } });
			if (previous) {
				await client.stripeReconciliationCheckpoint.update({
					where: { id: previous.id },
					data: {
						status: previous.status,
						sweepId: previous.sweepId,
						sweepCutoff: previous.sweepCutoff,
						stage: previous.stage,
						cursor: previous.cursor,
						leaseToken: previous.leaseToken,
						leasedUntil: previous.leasedUntil,
						pagesProcessed: previous.pagesProcessed,
						failureCount: previous.failureCount,
						lastAttemptAt: previous.lastAttemptAt,
						lastCompletedAt: previous.lastCompletedAt,
						lastErrorCode: previous.lastErrorCode,
					},
				});
			} else {
				await client.stripeReconciliationCheckpoint.deleteMany({
					where: { provider: "stripe", sweepId },
				});
			}
		}
	});

	it("reports historical Stripe refund ledger mutations without creating lifecycle state", async () => {
		const suffix = crypto.randomUUID();
		const missingRefundId = `re_historical_missing_${suffix}`;
		const trackedRefundId = `re_historical_tracked_${suffix}`;
		const consistentRefundId = `re_historical_consistent_${suffix}`;
		const unfinalizedRefundId = `re_historical_unfinalized_${suffix}`;
		const mismatchedRefundId = `re_historical_mismatched_${suffix}`;
		const secretMetadata = `historical-raw-envelope-${suffix}`;
		const firstLedgerAt = new Date(Date.now() + 1_000);
		const lastLedgerAt = new Date(firstLedgerAt.getTime() + 1_000);
		const account = await client.creditAccount.create({
			data: { ownerType: "USER", ownerId: `historical-refund-owner-${suffix}` },
		});
		await client.creditLedgerEntry.createMany({
			data: [
				{
					accountId: account.id,
					type: "REFUND",
					amount: 4n,
					referenceKey: `stripe-refund:${missingRefundId}:period-a-${suffix}`,
					metadata: { rawEnvelope: secretMetadata },
					createdAt: firstLedgerAt,
				},
				{
					accountId: account.id,
					type: "REFUND",
					amount: 6n,
					referenceKey: `stripe-refund:${missingRefundId}:period-b-${suffix}`,
					metadata: { rawEnvelope: secretMetadata },
					createdAt: lastLedgerAt,
				},
				{
					accountId: account.id,
					type: "REFUND",
					amount: 1n,
					referenceKey: `stripe-refund:${trackedRefundId}:period-c-${suffix}`,
					metadata: {},
					createdAt: new Date(lastLedgerAt.getTime() + 1_000),
				},
				{
					accountId: account.id,
					type: "REFUND",
					amount: 2n,
					referenceKey: `stripe-refund:${consistentRefundId}:period-d-${suffix}`,
					metadata: {},
					createdAt: new Date(lastLedgerAt.getTime() + 2_000),
				},
				{
					accountId: account.id,
					type: "REFUND",
					amount: 3n,
					referenceKey: `stripe-refund:${unfinalizedRefundId}:period-e-${suffix}`,
					metadata: {},
					createdAt: new Date(lastLedgerAt.getTime() + 3_000),
				},
				{
					accountId: account.id,
					type: "REFUND",
					amount: 4n,
					referenceKey: `stripe-refund:${mismatchedRefundId}:period-f-${suffix}`,
					metadata: {},
					createdAt: new Date(lastLedgerAt.getTime() + 4_000),
				},
			],
		});
		await client.stripeRefund.createMany({
			data: [
				{
					provider: "stripe",
					providerRefundId: trackedRefundId,
					providerChargeId: `ch_historical_${suffix}`,
					amount: 1n,
					currency: "USD",
					status: "FAILED",
					providerCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
					lastProviderChangeAt: new Date("2026-08-01T00:00:00.000Z"),
					lastProviderChangeId: `evt_historical_failed_${suffix}`,
				},
				{
					provider: "stripe",
					providerRefundId: consistentRefundId,
					providerChargeId: `ch_historical_consistent_${suffix}`,
					amount: 2n,
					currency: "USD",
					status: "SUCCEEDED",
					providerCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
					lastProviderChangeAt: new Date("2026-08-01T00:00:00.000Z"),
					lastProviderChangeId: `evt_historical_succeeded_${suffix}`,
					finalizedCredits: 2n,
					creditsFinalizedAt: new Date("2026-08-01T00:01:00.000Z"),
				},
				{
					provider: "stripe",
					providerRefundId: unfinalizedRefundId,
					providerChargeId: `ch_historical_unfinalized_${suffix}`,
					amount: 3n,
					currency: "USD",
					status: "SUCCEEDED",
					providerCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
					lastProviderChangeAt: new Date("2026-08-01T00:00:00.000Z"),
					lastProviderChangeId: `evt_historical_unfinalized_${suffix}`,
				},
				{
					provider: "stripe",
					providerRefundId: mismatchedRefundId,
					providerChargeId: `ch_historical_mismatched_${suffix}`,
					amount: 4n,
					currency: "USD",
					status: "SUCCEEDED",
					providerCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
					lastProviderChangeAt: new Date("2026-08-01T00:00:00.000Z"),
					lastProviderChangeId: `evt_historical_mismatched_${suffix}`,
					finalizedCredits: 3n,
					creditsFinalizedAt: new Date("2026-08-01T00:01:00.000Z"),
				},
			],
		});

		const diagnostics = (await getAdminMediaDiagnostics(client)) as unknown as PaymentDiagnostics;
		const historical = diagnostics.stripeReconciliation.historicalRefunds;
		expect(historical.needsReviewCount).toBeGreaterThanOrEqual(4);
		expect(historical.missingLifecycleCount).toBeGreaterThanOrEqual(1);
		expect(historical.items.length).toBeLessThanOrEqual(25);
		expect(historical.items).toContainEqual({
			providerRefundId: missingRefundId,
			reason: "MISSING_LIFECYCLE",
			lifecycleStatus: null,
			ledgerEntryCount: 2,
			ledgerCredits: "10",
			finalizedCredits: null,
			creditsFinalizedAt: null,
			firstLedgerAt: firstLedgerAt.toISOString(),
			lastLedgerAt: lastLedgerAt.toISOString(),
		});
		expect(historical.items).toContainEqual({
			providerRefundId: trackedRefundId,
			reason: "NON_SUCCEEDED_LIFECYCLE",
			lifecycleStatus: "FAILED",
			ledgerEntryCount: 1,
			ledgerCredits: "1",
			finalizedCredits: "0",
			creditsFinalizedAt: null,
			firstLedgerAt: new Date(lastLedgerAt.getTime() + 1_000).toISOString(),
			lastLedgerAt: new Date(lastLedgerAt.getTime() + 1_000).toISOString(),
		});
		expect(historical.items.some((item) => item.providerRefundId === consistentRefundId)).toBe(
			false,
		);
		expect(historical.items).toContainEqual({
			providerRefundId: unfinalizedRefundId,
			reason: "FINALIZATION_MISSING",
			lifecycleStatus: "SUCCEEDED",
			ledgerEntryCount: 1,
			ledgerCredits: "3",
			finalizedCredits: "0",
			creditsFinalizedAt: null,
			firstLedgerAt: new Date(lastLedgerAt.getTime() + 3_000).toISOString(),
			lastLedgerAt: new Date(lastLedgerAt.getTime() + 3_000).toISOString(),
		});
		expect(historical.items).toContainEqual({
			providerRefundId: mismatchedRefundId,
			reason: "CREDIT_TOTAL_MISMATCH",
			lifecycleStatus: "SUCCEEDED",
			ledgerEntryCount: 1,
			ledgerCredits: "4",
			finalizedCredits: "3",
			creditsFinalizedAt: "2026-08-01T00:01:00.000Z",
			firstLedgerAt: new Date(lastLedgerAt.getTime() + 4_000).toISOString(),
			lastLedgerAt: new Date(lastLedgerAt.getTime() + 4_000).toISOString(),
		});
		expect(JSON.stringify(historical)).not.toContain(secretMetadata);
		expect(
			await client.stripeRefund.findFirst({
				where: { provider: "stripe", providerRefundId: missingRefundId },
			}),
		).toBeNull();
		expect(
			await client.creditLedgerEntry.count({
				where: { accountId: account.id, referenceKey: { startsWith: "stripe-refund:" } },
			}),
		).toBe(6);
	});

	it("does not flag a finalized refund when future ungranted periods need no refund ledger", async () => {
		const suffix = crypto.randomUUID();
		const providerRefundId = `re_historical_future_periods_${suffix}`;
		const account = await client.creditAccount.create({
			data: { ownerType: "USER", ownerId: `historical-future-owner-${suffix}` },
		});
		await client.creditLedgerEntry.create({
			data: {
				accountId: account.id,
				type: "REFUND",
				amount: 2n,
				referenceKey: `stripe-refund:${providerRefundId}:granted-period-${suffix}`,
				metadata: {},
				createdAt: new Date(Date.now() + 60_000),
			},
		});
		await client.stripeRefund.create({
			data: {
				provider: "stripe",
				providerRefundId,
				providerChargeId: `ch_historical_future_periods_${suffix}`,
				amount: 100n,
				currency: "USD",
				status: "SUCCEEDED",
				providerCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
				lastProviderChangeAt: new Date("2026-08-01T00:00:00.000Z"),
				lastProviderChangeId: `evt_historical_future_periods_${suffix}`,
				finalizedCredits: 10n,
				creditsFinalizedAt: new Date("2026-08-01T00:01:00.000Z"),
			},
		});

		const diagnostics = (await getAdminMediaDiagnostics(client)) as unknown as PaymentDiagnostics;
		expect(
			diagnostics.stripeReconciliation.historicalRefunds.items.some(
				(item) => item.providerRefundId === providerRefundId,
			),
		).toBe(false);
	});

	it("uses normalized billing rows instead of raw envelopes for finance diagnostics", async () => {
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
					envelope: { type: "invoice.paid", data: { object: { amount_paid: 999 } } },
				},
				{
					provider: "stripe",
					providerEventId: `refund-${suffix}`,
					verifiedAt: old,
					receivedAt: old,
					processedAt: new Date(),
					status: "PROCESSED" as const,
					envelope: { type: "refund.created", data: { object: { amount: 888 } } },
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
						data: { object: { amount: 777 } },
					},
				},
			],
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `finance-price-${suffix}`,
				name: "finance fixture",
				creditsPerPeriod: 10n,
				priceMicros: 1_000_000n,
				currency: "USD",
				metadata: { planId: "finance", interval: "month" },
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId: `finance-owner-${suffix}`,
				provider: "stripe",
				providerSubscriptionId: `finance-subscription-${suffix}`,
				planId: plan.id,
				status: "ACTIVE",
			},
		});
		await client.billingPeriod.create({
			data: {
				subscriptionId: subscription.id,
				startsAt: new Date(),
				endsAt: new Date(Date.now() + 28 * 24 * 60 * 60_000),
				status: "ACTIVE",
				creditAmount: 10n,
				providerInvoiceId: `finance-invoice-${suffix}`,
				providerInvoicePaymentId: `finance-payment-${suffix}`,
				providerChargeId: `finance-charge-${suffix}`,
				paidAmount: 100n,
			},
		});
		await client.stripeRefund.create({
			data: {
				provider: "stripe",
				providerRefundId: `finance-refund-${suffix}`,
				providerChargeId: `finance-charge-${suffix}`,
				amount: 40n,
				currency: "USD",
				status: "SUCCEEDED",
				providerCreatedAt: new Date(),
				lastProviderChangeAt: new Date(),
				lastProviderChangeId: `finance-change-${suffix}`,
				finalizedCredits: 4n,
				creditsFinalizedAt: new Date(),
			},
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
	return {
		actorUserId,
		attemptId: attempt.id,
		jobId: created.job.id,
		reservationId: created.reservation.id,
	};
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
