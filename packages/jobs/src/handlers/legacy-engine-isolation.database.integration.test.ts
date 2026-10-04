import { PrismaPg } from "@prisma/adapter-pg";
import { TestMediaSafetyAdapter } from "@repo/ai";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { unmanagedLegacyTask } from "../orchestration/legacy-task-ownership";
import { listVerificationRecoveryCandidates } from "../orchestration/verification-recovery";
import {
	createDatabaseDispatchStore,
	createDatabaseFinalizationStore,
	createDatabaseProviderCancellationStore,
	createDatabaseProviderEventStore,
	createDatabaseReconciliationStore,
	createDatabaseSettlementStore,
	createDatabaseVerifyUploadDependencies,
	resolveDatabaseDispatchRoute,
} from "../runtime";
import { createDatabaseFinalizingGenerationRecoveryStore } from "./finalization-recovery-store";
import { processProviderEvent } from "./process-provider-event";
import { settleGeneration } from "./settle-generation";

const ownerId = `video-engine-isolation-${crypto.randomUUID()}`;
let client: PrismaClient;
const now = new Date();
const eventIds: string[] = [];
const localSafetyEnvironment = {
	NODE_ENV: "test",
	MEDIA_SAFETY_ADAPTER: "test",
	MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
};

describe("legacy executors cannot mutate video V1 records", () => {
	beforeAll(() => {
		const url = process.env.TEST_DATABASE_URL;
		if (!url) throw new Error("TEST_DATABASE_URL is required");
		const parsed = new URL(url);
		if (
			!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
			!parsed.pathname.includes("test")
		) {
			throw new Error("Only an isolated local test database is allowed");
		}
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
	});
	afterAll(async () => {
		if (!client) return;
		const jobs = await client.generationJob.findMany({ where: { ownerId }, select: { id: true } });
		const jobIds = jobs.map(({ id }) => id);
		await client.$transaction([
			client.providerWebhookEvent.deleteMany({
				where: { OR: [{ providerEventId: { startsWith: ownerId } }, { id: { in: eventIds } }] },
			}),
			client.outboxEvent.deleteMany({ where: { aggregateId: { in: jobIds } } }),
			client.generationAttempt.deleteMany({ where: { jobId: { in: jobIds } } }),
			client.creditReservation.deleteMany({ where: { jobId: { in: jobIds } } }),
			client.generationJob.deleteMany({ where: { ownerId } }),
			client.generationQuote.deleteMany({ where: { ownerId } }),
			client.creditAccount.deleteMany({ where: { ownerId } }),
			client.mediaAsset.deleteMany({ where: { ownerId } }),
		]);
		await client.$disconnect();
	});

	it.each(["RESERVED", "PROVIDER_PENDING", "FINALIZING", "CANCELED"] as const)(
		"keeps %s jobs, their attempts, credits and callback inbox unchanged",
		async (status) => {
			const quote = await client.generationQuote.create({
				data: {
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					productKey: "video-kling-2.6",
					catalogVersion: "isolation-test",
					pricingVersion: "isolation-test",
					credits: 5n,
					costMicros: 0n,
					inputSnapshot: {},
					pricingSnapshot: {},
					expiresAt: new Date(Date.now() + 60_000),
				},
			});
			const job = await client.generationJob.create({
				data: {
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					quoteId: quote.id,
					idempotencyKey: crypto.randomUUID(),
					productKey: quote.productKey,
					catalogVersion: quote.catalogVersion,
					pricingVersion: quote.pricingVersion,
					creditsReserved: 5n,
					inputSnapshot: {},
					pricingSnapshot: {},
					executionEngine: "video-workflow-v1",
					status,
					nextFinalizeAt: new Date(0),
				},
			});
			const account = await client.creditAccount.upsert({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
				create: { ownerType: "USER", ownerId, reservedCredits: 20n },
				update: {},
			});
			await client.creditReservation.create({
				data: { accountId: account.id, jobId: job.id, amount: 5n },
			});
			const attempt = await client.generationAttempt.create({
				data: {
					jobId: job.id,
					attemptNumber: 1,
					provider: "kie",
					providerModelId: "kling-2.6/text-to-video",
					providerTaskId: crypto.randomUUID(),
					status: "SUBMITTED",
					requestSnapshot: {},
					nextReconcileAt: new Date(0),
				},
			});
			const event = await client.providerWebhookEvent.create({
				data: {
					provider: "kie",
					providerEventId: `${ownerId}:${crypto.randomUUID()}`,
					providerTaskId: attempt.providerTaskId,
					verifiedAt: now,
					envelope: {},
				},
			});
			const snapshot = () =>
				Promise.all([
					client.generationJob.findUniqueOrThrow({ where: { id: job.id } }),
					client.generationAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
					client.creditReservation.findUniqueOrThrow({ where: { jobId: job.id } }),
					client.creditAccount.findUniqueOrThrow({ where: { id: account.id } }),
					client.providerWebhookEvent.findUniqueOrThrow({ where: { id: event.id } }),
					client.outboxEvent.findMany({ where: { aggregateId: job.id } }),
					client.creditLedgerEntry.findMany({ where: { accountId: account.id } }),
				]);
			const before = await snapshot();
			const payload = { jobId: job.id, version: 0 };
			expect(await unmanagedLegacyTask(client, payload)).toMatchObject({ outcome: "NOT_MANAGED" });
			expect(await resolveDatabaseDispatchRoute(job.id, { database: client })).toBeNull();
			expect(await createDatabaseDispatchStore(client).claimDispatch(payload)).toBeNull();
			expect(await createDatabaseFinalizationStore(client).claimFinalization(payload)).toBeNull();
			expect(await createDatabaseSettlementStore(client).claimSettlement(payload)).toBeNull();
			expect(
				await createDatabaseProviderCancellationStore(client).claimProviderCancellation(payload),
			).toBeNull();
			const recovery = createDatabaseFinalizingGenerationRecoveryStore(client);
			expect(await recovery.recoverCandidate(payload, { now, staleBefore: now })).toBe("SKIPPED");
			expect(
				await recovery.listCandidates({ now, staleBefore: now, limit: 100 }),
			).not.toContainEqual({ jobId: job.id });
			const polling = createDatabaseReconciliationStore(client);
			expect(await polling.getPollingState(attempt.id)).toBeNull();
			expect(
				await polling.claimStale({ attemptId: attempt.id, limit: 1, leaseSeconds: 60, now }),
			).toEqual([]);
			const callbacks = createDatabaseProviderEventStore(client);
			expect(await callbacks.claimProviderEvent(event.id)).toBeNull();
			const fakeClaim = {
				eventId: event.id,
				attemptId: attempt.id,
				processingToken: "foreign",
			} as never;
			await callbacks.markProviderRecoveryUnavailable!(fakeClaim);
			await callbacks.recordProviderEventFailure(fakeClaim, "PROVIDER_ERROR");
			expect(await snapshot()).toEqual(before);
		},
	);

	it.each([
		{ label: "early callback without task ID", taskId: null, canonicalKey: true },
		{ label: "callback after task binding", taskId: "seeapi-bound", canonicalKey: true },
		{
			label: "provider namespace without canonical key",
			taskId: "seeapi-bound",
			canonicalKey: false,
		},
	])("keeps SeeAPI $label out of legacy callback processing and settlement", async (variant) => {
		const quote = await client.generationQuote.create({
			data: {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				productKey: "video-kling-2.6",
				catalogVersion: "isolation-test",
				pricingVersion: "isolation-test",
				credits: 5n,
				costMicros: 0n,
				inputSnapshot: {},
				pricingSnapshot: {},
				expiresAt: new Date(Date.now() + 60_000),
			},
		});
		const job = await client.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				quoteId: quote.id,
				idempotencyKey: crypto.randomUUID(),
				productKey: quote.productKey,
				catalogVersion: quote.catalogVersion,
				pricingVersion: quote.pricingVersion,
				creditsReserved: 5n,
				inputSnapshot: {},
				pricingSnapshot: {},
				executionEngine: "video-workflow-v1",
				status: "FINALIZING",
				nextFinalizeAt: new Date(0),
			},
		});
		const account = await client.creditAccount.upsert({
			where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
			create: { ownerType: "USER", ownerId, reservedCredits: 5n },
			update: {},
		});
		await client.creditReservation.create({
			data: { accountId: account.id, jobId: job.id, amount: 5n },
		});
		const attempt = await client.generationAttempt.create({
			data: {
				jobId: job.id,
				attemptNumber: 1,
				provider: "kie",
				providerModelId: "kling-2.6/text-to-video",
				providerTaskId: crypto.randomUUID(),
				status: "SUCCEEDED",
				requestSnapshot: {},
			},
		});
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId,
				kind: "OUTPUT",
				status: "VERIFYING",
				verificationEngine: "video-workflow-v1",
				verificationProvider: "seeapi",
				verificationProviderTaskId: variant.taskId,
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				objectKey: `test/${crypto.randomUUID()}.mp4`,
				mimeType: "video/mp4",
				byteSize: 16n,
				checksum: "a".repeat(64),
				storageEtag: "sealed-etag",
				finalizedAt: now,
			},
		});
		const event = await client.providerWebhookEvent.create({
			data: {
				provider: "seeapi-video-v1",
				providerEventId: variant.canonicalKey
					? `video-v1:${asset.id}:1:1`
					: `${ownerId}:${crypto.randomUUID()}`,
				providerTaskId: variant.taskId,
				verifiedAt: now,
				envelope: {
					executionEngine: "video-workflow-v1",
					jobId: job.id,
					workflowInstanceId: `video-v1-${job.id}`,
					assetId: asset.id,
					generation: 1,
					attemptNumber: 1,
					checksum: asset.checksum,
					etag: asset.storageEtag,
					notifiedAt: null,
				},
			},
		});
		eventIds.push(event.id);
		const snapshot = () =>
			Promise.all([
				client.generationJob.findUniqueOrThrow({ where: { id: job.id } }),
				client.generationAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
				client.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }),
				client.providerWebhookEvent.findUniqueOrThrow({ where: { id: event.id } }),
				client.creditReservation.findUniqueOrThrow({ where: { jobId: job.id } }),
				client.creditAccount.findUniqueOrThrow({ where: { id: account.id } }),
				client.creditLedgerEntry.findMany({ where: { accountId: account.id } }),
				client.outboxEvent.findMany({
					where: { aggregateId: { in: [job.id, asset.id, event.id] } },
				}),
			]);
		const before = await snapshot();
		const payload = { providerWebhookEventId: event.id };
		expect(await unmanagedLegacyTask(client, payload)).toMatchObject({ outcome: "NOT_MANAGED" });
		const callbacks = createDatabaseProviderEventStore(client);
		const getProvider = vi.fn(() => {
			throw new Error("SeeAPI callback must not construct a legacy provider");
		});
		expect(await processProviderEvent(payload, { store: callbacks, getProvider })).toEqual({
			outcome: "SKIPPED",
		});
		expect(getProvider).not.toHaveBeenCalled();
		const fakeClaim = {
			eventId: event.id,
			attemptId: attempt.id,
			processingToken: "foreign",
		} as never;
		await expect(
			callbacks.recordProviderProgress(fakeClaim, {
				outputs: [],
				progress: null,
				providerCostMicros: null,
				failure: null,
				retryable: false,
				providerCharged: false,
			}),
		).rejects.toMatchObject({ code: "P2025" });
		await callbacks.markProviderRecoveryUnavailable(fakeClaim);
		await callbacks.recordProviderEventFailure(fakeClaim, "PROVIDER_ERROR");
		const settlement = createDatabaseSettlementStore(client);
		expect(await settleGeneration({ jobId: job.id, version: 0 }, { store: settlement })).toEqual({
			outcome: "SKIPPED",
		});
		await settlement.settle({
			jobId: job.id,
			reservationId: before[4].id,
			reservedCredits: 5n,
			chargeCredits: 5n,
			readyOutputCount: 1,
			failureCode: null,
			providerCostMicros: 0n,
		});
		expect(await snapshot()).toEqual(before);
	});

	it("never inspects, moderates, or requeues a video-owned asset", async () => {
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId,
				kind: "OUTPUT",
				status: "VERIFYING",
				verificationEngine: "video-workflow-v1",
				objectKey: `test/${crypto.randomUUID()}.mp4`,
				mimeType: "video/mp4",
				byteSize: 16n,
				checksum: "a".repeat(64),
				finalizedAt: now,
			},
		});
		const safety = new TestMediaSafetyAdapter("ALLOW");
		const moderate = vi.spyOn(safety, "submitVideo");
		const inspect = vi.fn(async () => {
			throw new Error("Unexpected storage inspection");
		});
		const dependencies = createDatabaseVerifyUploadDependencies(client, {
			safety,
			inspectPrivateMediaObject: inspect,
		});
		expect(await dependencies.verify(asset.id)).toEqual({ outboxCommitted: false });
		expect(
			await listVerificationRecoveryCandidates(client, { now, limit: 100 }, localSafetyEnvironment),
		).not.toContainEqual({ assetId: asset.id, allowQuarantinedReverification: false });
		expect(inspect).not.toHaveBeenCalled();
		expect(moderate).not.toHaveBeenCalled();
		expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).toEqual(asset);
	});

	it("preserves legacy defaults and their existing recovery route", async () => {
		const quote = await client.generationQuote.create({
			data: {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				productKey: "image-nano-banana-2-lite",
				catalogVersion: "isolation-test",
				pricingVersion: "isolation-test",
				credits: 5n,
				costMicros: 0n,
				inputSnapshot: {},
				pricingSnapshot: {},
				expiresAt: new Date(Date.now() + 60_000),
			},
		});
		const job = await client.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				quoteId: quote.id,
				idempotencyKey: crypto.randomUUID(),
				productKey: quote.productKey,
				catalogVersion: quote.catalogVersion,
				pricingVersion: quote.pricingVersion,
				creditsReserved: 5n,
				inputSnapshot: {},
				pricingSnapshot: {},
				status: "FINALIZING",
				nextFinalizeAt: new Date(0),
			},
		});
		expect(job.executionEngine).toBe("legacy");
		expect(await unmanagedLegacyTask(client, { jobId: job.id })).toBeNull();
		const recovery = createDatabaseFinalizingGenerationRecoveryStore(client);
		expect(await recovery.recoverCandidate({ jobId: job.id }, { now, staleBefore: now })).toBe(
			"RECOVERED",
		);
		expect(await client.outboxEvent.findFirst({ where: { aggregateId: job.id } })).toMatchObject({
			eventType: "GENERATION_SETTLE",
		});
		// Recovery scans oldest updatedAt first; keep this fixture inside the bounded
		// batch even when earlier suites leave more than 100 eligible assets behind.
		const oldestAsset = await client.mediaAsset.aggregate({ _min: { updatedAt: true } });
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `test/${crypto.randomUUID()}.png`,
				mimeType: "image/png",
				byteSize: 16n,
				updatedAt: new Date((oldestAsset._min.updatedAt ?? now).getTime() - 1),
			},
		});
		expect(asset.verificationEngine).toBe("legacy");
		expect(
			await listVerificationRecoveryCandidates(client, { now, limit: 100 }, localSafetyEnvironment),
		).toContainEqual({ assetId: asset.id, allowQuarantinedReverification: false });
	});
});
