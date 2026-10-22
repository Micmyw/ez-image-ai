import { PrismaPg } from "@prisma/adapter-pg";
import {
	MEDIA_VERIFICATION_RULE_VERSION,
	TestMediaSafetyAdapter,
	type NormalizedResult,
	type ProviderSubmission,
} from "@repo/ai";
import {
	claimImagePhaseOwnerInTransaction,
	claimOutboxBatch,
	completeOutboxEvent,
	deferOutboxEvent,
	getImagePhaseOwner,
	releaseOutboxEvent,
	type ImagePhaseOwner,
	type ImageWorkflowPhase,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ProviderEventPhaseHeldError, type OutboxDependencies } from "../contracts";
import {
	createDatabaseDispatchStore,
	createDatabaseProviderEventStore,
	createDatabaseReconciliationStore,
	createDatabaseVerifyUploadDependencies,
} from "../runtime";
import { deliverOutboxEvent } from "./deliver-outbox-event";
import { dispatchOutbox } from "./dispatch-outbox";
import { processProviderEvent } from "./process-provider-event";
import { reconcileGenerations } from "./reconcile-generations";

describe("runtime phase ownership with real PostgreSQL", () => {
	let client: PrismaClient;
	const assetIds: string[] = [];
	const jobIds: string[] = [];
	const quoteIds: string[] = [];
	const accountIds: string[] = [];
	const attemptIds: string[] = [];
	const providerEventIds: string[] = [];

	beforeAll(() => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("EXPLICIT_TEST_DATABASE_REQUIRED");
		const url = new URL(connectionString);
		if (
			!["postgres:", "postgresql:"].includes(url.protocol) ||
			url.hostname !== "127.0.0.1" ||
			url.port !== "55432" ||
			(url.pathname !== "/ai_media_foundation_test" &&
				url.pathname !== "/scanless_phase_owner_migration_test" &&
				!/^\/ezpic_[a-z0-9_]+_test$/.test(url.pathname)) ||
			url.search ||
			url.hash
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 6 }) });
	});

	afterAll(async () => {
		if (!client) return;
		try {
			await client.providerWebhookEvent.deleteMany({ where: { id: { in: providerEventIds } } });
			await client.mediaWorkflowPhaseOwner.deleteMany({
				where: { subjectId: { in: [...assetIds, ...attemptIds] } },
			});
			await client.outboxEvent.deleteMany({
				where: { aggregateId: { in: [...assetIds, ...jobIds] } },
			});
			await client.creditReservation.deleteMany({ where: { jobId: { in: jobIds } } });
			await client.generationJob.deleteMany({ where: { id: { in: jobIds } } });
			await client.generationQuote.deleteMany({ where: { id: { in: quoteIds } } });
			await client.creditAccount.deleteMany({ where: { id: { in: accountIds } } });
			// Successful review evidence stays append-only in the disposable database.
			await client.mediaAsset.deleteMany({
				where: { id: { in: assetIds }, moderationResults: { none: {} } },
			});
		} finally {
			await client.$disconnect();
		}
	});

	async function ownerFor(
		phase: ImageWorkflowPhase,
		workflowId = `workflow-${crypto.randomUUID()}`,
	) {
		const result = await client.$transaction(async (tx) => {
			if (phase.kind === "verification") {
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${phase.assetId}`}, 0))`;
			} else {
				await tx.$queryRaw`SELECT "id" FROM "generation_attempt" WHERE "id" = ${phase.attemptId} FOR UPDATE`;
			}
			return claimImagePhaseOwnerInTransaction({ phase, workflowId }, tx);
		});
		expect(result.owned).toBe(true);
		if (!result.phaseOwner) throw new Error("MISSING_TEST_OWNER");
		return result.phaseOwner;
	}

	async function replaceOwner(phase: ImageWorkflowPhase, owner: ImagePhaseOwner) {
		await client.$executeRaw`UPDATE "media_workflow_phase_owner" SET "leasedUntil" = clock_timestamp() - INTERVAL '1 second' WHERE "phaseKey" = ${owner.phaseKey}`;
		return ownerFor(phase);
	}

	async function reviewFixture() {
		const assetId = crypto.randomUUID();
		assetIds.push(assetId);
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId: `phase-runtime-${assetId}`,
				kind: "OUTPUT",
				status: "VERIFYING",
				objectKey: `users/phase-runtime/assets/${assetId}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum: "a".repeat(64),
				finalizedAt: new Date(),
			},
		});
		const submit = vi.fn(async (input: { idempotencyKey: string; ruleVersion: string }) => ({
			moderationTaskId: `review-${assetId}`,
			status: "QUEUED" as const,
			ruleVersion: input.ruleVersion,
			idempotency: { key: input.idempotencyKey, providerSupported: true, replayed: false },
		}));
		const retrieve = vi.fn(async () => ({
			decision: "REVIEW" as const,
			reasonCode: "IMAGE_PROCESSING",
			ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
		}));
		const dependencies = createDatabaseVerifyUploadDependencies(client, {
			environment: {},
			moderationProvider: `phase-runtime-${assetId}`,
			safety: Object.assign(new TestMediaSafetyAdapter("ALLOW"), {
				submitImage: submit,
				retrieveImage: retrieve,
			}),
			createSignedReadUrl: async () => "https://private.example/phase-runtime.png",
		});
		return {
			assetId,
			submit,
			retrieve,
			dependencies,
			phase: { kind: "verification", assetId, generation: 1 } as const,
		};
	}

	async function generationFixture(options: { engine?: string; uncertain?: boolean } = {}) {
		const id = crypto.randomUUID();
		const uncertain = options.uncertain ?? true;
		const taskId = `task-${id}`;
		const snapshot = {
			ownerType: "USER" as const,
			ownerId: id,
			submittedByUserId: id,
			productKey: "image-nano-banana-2-lite",
			catalogVersion: "phase-runtime-test",
			pricingVersion: "phase-runtime-test",
			inputSnapshot: {},
			pricingSnapshot: {},
		};
		const job = await client.generationJob.create({
			data: {
				...snapshot,
				quote: { create: { ...snapshot, credits: 5n, costMicros: 10n, expiresAt: new Date() } },
				idempotencyKey: id,
				creditsReserved: 5n,
				status: uncertain ? "SUBMITTING" : "PROVIDER_PENDING",
				executionEngine: options.engine ?? "legacy",
				attempts: {
					create: {
						id,
						attemptNumber: 1,
						provider: "kie",
						providerModelId: "nano-banana-2-lite",
						providerTaskId: uncertain ? null : taskId,
						status: uncertain ? "SUBMISSION_UNCERTAIN" : "SUBMITTED",
						uncertainSubmission: uncertain,
						requestSnapshot: {},
						submittedAt: new Date(),
						nextReconcileAt: new Date(0),
					},
				},
				reservation: {
					create: {
						amount: 5n,
						account: { create: { ownerType: "USER", ownerId: id, reservedCredits: 5n } },
					},
				},
			},
			include: { reservation: true },
		});
		jobIds.push(job.id);
		quoteIds.push(job.quoteId);
		accountIds.push(job.reservation!.accountId);
		attemptIds.push(id);
		const submission: Extract<ProviderSubmission, { outcome: "accepted" }> = {
			outcome: "accepted",
			providerTaskId: taskId,
			status: "SUCCEEDED",
			idempotency: { key: id, providerSupported: false, replayed: false },
			reconciliation: { submissionToken: id },
			snapshot: { providerTaskId: taskId, status: "SUCCEEDED", raw: {} },
		};
		const result: NormalizedResult = {
			outputs: [
				{
					kind: "remote-url",
					url: `https://private.example/${id}.png`,
					trust: "untrusted-transfer-candidate",
				},
			],
			progress: 100,
			providerCostMicros: 20_000,
			providerCharged: true,
			failure: null,
			retryable: false,
		};
		return {
			job,
			taskId,
			submission,
			result,
			phase: { kind: "generation", attemptId: id } as const,
			read: () => client.generationAttempt.findUniqueOrThrow({ where: { id } }),
		};
	}

	it("registers one review owner and blocks legacy or foreign submission/query on that generation", async () => {
		const f = await reviewFixture();
		const first = await f.dependencies.verify(f.assetId, { workflowId: "review-owner" });
		expect(first).toMatchObject({
			queryOnly: true,
			phaseOwner: { workflowId: "review-owner", epoch: 1 },
		});
		const owner = await getImagePhaseOwner(f.phase, client);
		expect(owner).toBeDefined();
		await client.mediaAsset.update({
			where: { id: f.assetId },
			data: { verificationNextAttemptAt: new Date(0) },
		});
		const before = await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } });
		const queries = f.retrieve.mock.calls.length;
		await expect(f.dependencies.verify(f.assetId)).resolves.toMatchObject({
			phaseOwnershipLost: true,
			phaseOwner: owner,
		});
		await expect(
			f.dependencies.verify(f.assetId, { queryOnly: true, workflowId: "foreign" }),
		).resolves.toMatchObject({ phaseOwnershipLost: true, phaseOwner: owner });
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.retrieve).toHaveBeenCalledTimes(queries);
		expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } })).toEqual(before);
		await f.dependencies.verify(f.assetId, {
			queryOnly: true,
			workflowId: "review-owner",
			phaseOwner: owner,
		});
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.retrieve).toHaveBeenCalledTimes(queries + 1);
	});

	it("rejects the previous review epoch without another provider call after takeover", async () => {
		const f = await reviewFixture();
		await f.dependencies.verify(f.assetId, { workflowId: "original-review" });
		const prior = await getImagePhaseOwner(f.phase, client);
		if (!prior) throw new Error("MISSING_TEST_OWNER");
		const replacement = await replaceOwner(f.phase, prior);
		await client.mediaAsset.update({
			where: { id: f.assetId },
			data: { verificationNextAttemptAt: new Date(0) },
		});
		const before = await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } });
		const queries = f.retrieve.mock.calls.length;
		await expect(
			f.dependencies.verify(f.assetId, {
				workflowId: prior.workflowId,
				phaseOwner: prior,
				queryOnly: true,
			}),
		).resolves.toMatchObject({ phaseOwnershipLost: true, phaseOwner: replacement });
		expect(f.retrieve).toHaveBeenCalledTimes(queries);
		expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } })).toEqual(before);
	});

	it("refuses a stale provider pre-send fence without mutating acceptance state", async () => {
		const f = await generationFixture();
		const prior = await ownerFor(f.phase);
		await replaceOwner(f.phase, prior);
		const before = await f.read();
		const store = createDatabaseDispatchStore(client);
		await expect(store.recordSubmissionStarted(f.phase.attemptId, prior)).resolves.toBe(false);
		expect(await f.read()).toEqual(before);
	});

	it("preserves the first stale synchronous result for the current owner's recovery without model I/O", async () => {
		const f = await generationFixture();
		const prior = await ownerFor(f.phase);
		const current = await replaceOwner(f.phase, prior);
		const store = createDatabaseDispatchStore(client);
		await expect(
			store.recordSynchronousCompletion(f.phase.attemptId, f.submission, f.result, prior),
		).resolves.toEqual({ phaseOwnershipLost: true, phaseOwner: current });
		const preserved = await f.read();
		expect(preserved).toMatchObject({
			status: "SUBMISSION_UNCERTAIN",
			uncertainSubmission: true,
			providerTaskId: f.taskId,
			providerCostMicros: null,
		});
		expect(preserved.responseSnapshot).toMatchObject({
			phaseCompletion: {
				providerTaskId: f.taskId,
				providerCostMicros: 20_000,
				providerCharged: true,
			},
		});
		const envelope = await client.generationAttemptTransferEnvelope.findUniqueOrThrow({
			where: { attemptId: f.phase.attemptId },
		});
		await store.recordSynchronousCompletion(
			f.phase.attemptId,
			f.submission,
			{
				...f.result,
				providerCostMicros: 999_999,
				outputs: [
					{
						kind: "remote-url",
						url: "https://private.example/conflicting.png",
						trust: "untrusted-transfer-candidate",
					},
				],
			},
			prior,
		);
		expect(await f.read()).toEqual(preserved);
		expect(
			await client.generationAttemptTransferEnvelope.findUniqueOrThrow({
				where: { attemptId: f.phase.attemptId },
			}),
		).toEqual(envelope);
		expect(await client.creditReservation.findUnique({ where: { jobId: f.job.id } })).toEqual(
			f.job.reservation,
		);
		const getProvider = vi.fn(() => {
			throw new Error("SAVED_RESULT_MUST_NOT_QUERY_PROVIDER");
		});
		const reconciliation = createDatabaseReconciliationStore(client, {
			workflowId: current.workflowId,
			phaseOwner: current,
		});
		await expect(
			reconcileGenerations(
				{ attemptId: f.phase.attemptId },
				{ store: reconciliation, getProvider },
			),
		).resolves.toMatchObject({ claimed: 1, reconciled: 1, outboxCommitted: true });
		expect(getProvider).not.toHaveBeenCalled();
		expect(await f.read()).toMatchObject({
			status: "SUCCEEDED",
			uncertainSubmission: false,
			providerCostMicros: 20_000n,
			reconcileLeaseToken: null,
		});
		expect(await client.generationJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject(
			{ status: "FINALIZING" },
		);
		expect(
			await client.outboxEvent.count({
				where: { dedupeKey: `generation-finalize:${f.job.id}:${f.phase.attemptId}` },
			}),
		).toBe(1);
		expect(await client.creditReservation.findUnique({ where: { jobId: f.job.id } })).toEqual(
			f.job.reservation,
		);
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: f.job.reservation!.accountId } }),
		).toBe(0);
		await expect(
			reconcileGenerations(
				{ attemptId: f.phase.attemptId },
				{ store: reconciliation, getProvider },
			),
		).resolves.toMatchObject({ claimed: 0, reconciled: 0 });
	});

	it("reports ownership loss even when terminal provider evidence already exists", async () => {
		const f = await generationFixture({ uncertain: false });
		const prior = await ownerFor(f.phase);
		const current = await replaceOwner(f.phase, prior);
		await client.generationAttempt.update({
			where: { id: f.phase.attemptId },
			data: {
				responseSnapshot: {
					providerTerminalEvidence: {
						version: 1,
						provider: "kie",
						source: "kie-record-info",
						attemptId: f.phase.attemptId,
						providerTaskId: f.taskId,
						status: "FAILED",
						verifiedAt: new Date().toISOString(),
					},
				},
			},
		});
		const before = await f.read();
		await expect(
			createDatabaseDispatchStore(client).recordSynchronousCompletion(
				f.phase.attemptId,
				f.submission,
				f.result,
				prior,
			),
		).resolves.toEqual({ phaseOwnershipLost: true, phaseOwner: current });
		expect(await f.read()).toEqual(before);
		expect(
			await client.generationAttemptTransferEnvelope.findUnique({
				where: { attemptId: f.phase.attemptId },
			}),
		).toBeNull();
	});

	it("prevents an old reconciliation lease from persisting after phase takeover", async () => {
		const f = await generationFixture({ uncertain: false });
		const prior = await ownerFor(f.phase);
		const store = createDatabaseReconciliationStore(client, {
			workflowId: prior.workflowId,
			phaseOwner: prior,
		});
		const [lease] = await store.claimStale({
			attemptId: f.phase.attemptId,
			limit: 1,
			leaseSeconds: 60,
			now: new Date(),
		});
		expect(lease).toBeDefined();
		await client.generationAttempt.update({
			where: { id: f.phase.attemptId },
			data: { reconcileLeasedUntil: new Date(0) },
		});
		await replaceOwner(f.phase, prior);
		const before = await f.read();
		await expect(
			store.recordReconciled(lease!, f.submission.snapshot!, f.result),
		).resolves.toMatchObject({ outboxCommitted: false, phaseOwnershipLost: true });
		expect(await f.read()).toEqual(before);
		expect(
			await client.generationAttemptTransferEnvelope.findUnique({
				where: { attemptId: f.phase.attemptId },
			}),
		).toBeNull();
	});

	it("does not create image phase ownership while inspecting a native-video attempt", async () => {
		const f = await generationFixture({ engine: "video-workflow-v1", uncertain: false });
		const before = await f.read();
		const store = createDatabaseReconciliationStore(client, { workflowId: "wrong-engine" });
		await expect(
			store.claimStale({
				attemptId: f.phase.attemptId,
				limit: 1,
				leaseSeconds: 60,
				now: new Date(),
			}),
		).resolves.toEqual([]);
		expect(
			await client.mediaWorkflowPhaseOwner.count({ where: { subjectId: f.phase.attemptId } }),
		).toBe(0);
		expect(await f.read()).toEqual(before);
	});

	it.each(["before-claim", "during-normalization"] as const)(
		"keeps a legacy callback retryable when a phase owner appears %s",
		async (timing) => {
			const f = await generationFixture({ uncertain: false });
			const event = await client.providerWebhookEvent.create({
				data: {
					provider: "kie",
					providerEventId: `phase-event-${crypto.randomUUID()}`,
					providerTaskId: f.taskId,
					verifiedAt: new Date(),
					envelope: { status: "succeeded" },
				},
			});
			providerEventIds.push(event.id);
			let owner = timing === "before-claim" ? await ownerFor(f.phase) : undefined;
			const before = await f.read();
			const submit = vi.fn(async () => f.submission);
			const retrieve = vi.fn(async () => f.submission.snapshot!);
			const normalizeResult = vi.fn(async () => {
				if (!owner) owner = await ownerFor(f.phase);
				return f.result;
			});
			const dependencies = {
				store: createDatabaseProviderEventStore(client),
				getProvider: () => ({ provider: "kie" as const, submit, retrieve, normalizeResult }),
			};
			const process = () =>
				processProviderEvent({ providerWebhookEventId: event.id }, dependencies);
			await expect(process()).rejects.toBeInstanceOf(ProviderEventPhaseHeldError);
			expect(await f.read()).toEqual(before);
			const heldEvent = await client.providerWebhookEvent.findUniqueOrThrow({
				where: { id: event.id },
			});
			expect(heldEvent.status).toBe(timing === "before-claim" ? "RECEIVED" : "PROCESSING");
			expect(heldEvent.processedAt).toBeNull();
			expect(heldEvent.failureReason).toBeNull();
			const outbox = await client.outboxEvent.create({
				data: {
					eventType: "PROVIDER_EVENT_RECEIVED",
					aggregateType: "GENERATION_JOB",
					aggregateId: f.job.id,
					dedupeKey: `phase-callback:${event.id}`,
					payload: { providerWebhookEventId: event.id },
					availableAt: new Date("1900-01-01T00:00:00Z"),
					attempts: 11,
				},
			});
			const release = vi.fn(
				async (input: Parameters<OutboxDependencies["store"]["release"]>[0]) => {
					await releaseOutboxEvent({ ...input, error: input.errorCode, maxAttempts: 12 }, client);
				},
			);
			const delivery: OutboxDependencies = {
				store: {
					claimBatch: (input) =>
						client.$transaction(async (tx) => {
							const rows = await claimOutboxBatch({ ...input, limit: 1 }, tx);
							// Roll back rather than lease any unrelated fixture if its due time wins.
							expect(rows.map((row) => row.id)).toEqual([outbox.id]);
							return rows;
						}),
					complete: async (id, workerId, leaseToken) => {
						await completeOutboxEvent(id, workerId, leaseToken, client);
					},
					defer: async (input) => {
						expect(await deferOutboxEvent(input, client)).toEqual({ applied: true });
					},
					release,
				},
				deliver: (leased) =>
					deliverOutboxEvent(leased, {
						trigger: async () => {
							throw new Error("CALLBACK_MUST_WAIT_FOR_COMPLETION");
						},
						triggerAndWait: async (taskId, payload) => {
							expect(taskId).toBe("media-process-provider-webhook");
							expect(payload).toEqual({ providerWebhookEventId: event.id });
							await process();
						},
						resolveDispatchRoute: async () => null,
					}),
			};
			const workerId = `phase-delivery-${event.id}`;
			await expect(dispatchOutbox({ workerId, limit: 1 }, delivery)).resolves.toEqual({
				claimed: 1,
				delivered: 0,
			});
			const deferred = await client.outboxEvent.findUniqueOrThrow({ where: { id: outbox.id } });
			expect(deferred).toMatchObject({
				status: "PENDING",
				attempts: 11,
				leaseOwner: null,
				leaseToken: null,
				processedAt: null,
			});
			expect(deferred.availableAt.getTime()).toBeGreaterThan(Date.now());
			expect(release).not.toHaveBeenCalled();
			if (!owner) throw new Error("MISSING_TEST_OWNER");
			await client.$executeRaw`UPDATE "media_workflow_phase_owner" SET "leasedUntil" = clock_timestamp() - INTERVAL '1 second' WHERE "phaseKey" = ${owner.phaseKey}`;
			if (timing === "during-normalization") {
				// The old processing lease independently retains pending work.
				await expect(process()).rejects.toBeInstanceOf(ProviderEventPhaseHeldError);
				await client.providerWebhookEvent.update({
					where: { id: event.id },
					data: { processingLeasedUntil: new Date(0) },
				});
			}
			await client.outboxEvent.update({
				where: { id: outbox.id },
				data: { availableAt: new Date("1900-01-01T00:00:00Z") },
			});
			await expect(dispatchOutbox({ workerId, limit: 1 }, delivery)).resolves.toEqual({
				claimed: 1,
				delivered: 1,
			});
			expect(
				await client.outboxEvent.findUniqueOrThrow({ where: { id: outbox.id } }),
			).toMatchObject({ status: "PROCESSED", attempts: 12 });
			expect(
				await client.providerWebhookEvent.findUniqueOrThrow({ where: { id: event.id } }),
			).toMatchObject({ status: "PROCESSED", processingToken: null });
			expect(await f.read()).toMatchObject({ status: "SUCCEEDED" });
			expect(
				await client.outboxEvent.count({
					where: { dedupeKey: `generation-finalize:${f.job.id}:${f.phase.attemptId}` },
				}),
			).toBe(1);
			expect(submit).not.toHaveBeenCalled();
			expect(retrieve).not.toHaveBeenCalled();
			expect(await client.creditReservation.findUnique({ where: { jobId: f.job.id } })).toEqual(
				f.job.reservation,
			);
		},
	);
});
