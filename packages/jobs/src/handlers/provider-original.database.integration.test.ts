import { Readable } from "node:stream";

import { PrismaPg } from "@prisma/adapter-pg";
import { TestMediaSafetyAdapter, SeeapiSafetyAdapter } from "@repo/ai";
import {
	createCreditGrant,
	reserveCredits,
	claimProviderOriginalArchive,
	reserveProviderOriginalArchive,
	completeProviderOriginalArchive,
	retryProviderOriginalArchive,
	recoverProviderOriginalArchives,
	prepareWorkflowOutboxEvent,
	beginWorkflowOutboxExecution,
	completeWorkflowOutboxExecution,
	deferWorkflowOutboxExecution,
	failWorkflowOutboxExecution,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { runWithImageProcessor } from "@repo/storage/image-processing/context";
import { createSharpImageProcessor } from "@repo/storage/image-processing/sharp";
import { runWithRequestDefer } from "@repo/utils/request-lifecycle";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	createFinalizationDependencies,
	createDatabaseVerifyUploadDependencies,
	createDatabaseFinalizationStore,
	createDatabaseSettlementStore,
} from "../runtime";
import { archiveProviderOriginal } from "./archive-provider-original";
import { finalizeMedia } from "./finalize-media";
import { settleGeneration } from "./settle-generation";
import { executeTargetedEvent, prepareTargetedEvent } from "./targeted-event-delivery";

const mocks = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock("@repo/storage", async () => ({
	...(await vi.importActual<typeof import("@repo/storage")>("@repo/storage")),
	tryWriteImmutableGenerationImage: mocks.write,
}));

let db: PrismaClient;
beforeAll(() => {
	const url = new URL(process.env.TEST_DATABASE_URL!);
	if (url.hostname !== "127.0.0.1" || !url.pathname.endsWith("_test") || Number(url.port) < 49152)
		throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
	db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString(), max: 4 }) });
});
afterAll(async () => db?.$disconnect());

async function fixture(dispatchOverride?: (eventId: string) => Promise<void>, guest = false) {
	const ownerId = `origin-${crypto.randomUUID()}`;
	const common = {
		ownerId,
		ownerType: "USER" as const,
		submittedByUserId: ownerId,
		productKey: "image-nano-banana-2-lite",
		catalogVersion: "test",
		pricingVersion: "test",
		inputSnapshot: {},
		pricingSnapshot: {
			settlementPolicy: { unitCredits: "5", requestedOutputCount: 1, maxCharge: "5" },
		},
	};
	const account = await db.creditAccount.create({ data: { ownerId, ownerType: "USER" } });
	await createCreditGrant(
		{ accountId: account.id, amount: 20n, referenceKey: `grant:${ownerId}` },
		db,
	);
	const quote = await db.generationQuote.create({
		data: { ...common, credits: 5n, costMicros: 1n, expiresAt: new Date(Date.now() + 60_000) },
	});
	const job = await db.generationJob.create({
		data: {
			...common,
			quoteId: quote.id,
			idempotencyKey: ownerId,
			creditsReserved: 5n,
			status: "FINALIZING",
		},
	});
	await reserveCredits(
		{ accountId: account.id, jobId: job.id, amount: 5n, referenceKey: `reserve:${ownerId}` },
		db,
	);
	if (guest) {
		const now = new Date();
		await db.user.create({
			data: {
				id: ownerId,
				name: "Guest fixture",
				email: `${ownerId}@anonymous.invalid`,
				emailVerified: false,
				isAnonymous: true,
				createdAt: now,
				updatedAt: now,
			},
		});
		const trial = await db.guestMediaTrial.create({
			data: {
				ownerId,
				promotionPeriod: `period:${ownerId}`,
				eligibility: "CONSUMED",
				sponsorCredits: 5n,
				sourceSessionHash: `session:${ownerId}`,
				deviceHash: `device:${ownerId}`,
				ipHash: `ip:${ownerId}`,
				subnetHash: `subnet:${ownerId}`,
				capabilityVersion: "test",
				idempotencyFingerprint: ownerId,
				abuseEvidenceExpiresAt: new Date(Date.now() + 86_400_000),
				frozenQuotedRiskMicros: 3_500n,
				riskState: "COMMITTED",
				projectedDispatchAt: now,
				estimateExpiresAt: new Date(Date.now() + 60_000),
				consumedJobId: job.id,
				providerBoundaryAt: now,
				consumedAt: now,
				expiresAt: new Date(Date.now() + 86_400_000),
			},
		});
		await db.generationJob.update({
			where: { id: job.id },
			data: { serviceClass: "GUEST_SLOW", guestTrialId: trial.id },
		});
	}
	const attempt = await db.generationAttempt.create({
		data: {
			jobId: job.id,
			attemptNumber: 1,
			provider: "kie",
			providerModelId: "nano-banana-2-lite",
			status: "SUCCEEDED",
			requestSnapshot: {},
		},
	});
	const output = {
		kind: "remote-url" as const,
		url: "https://tempfile.aiquickdraw.com/original.png",
		trust: "untrusted-transfer-candidate" as const,
	};
	await db.generationAttemptTransferEnvelope.create({
		data: { attemptId: attempt.id, payload: { version: 1, outputs: [output] } },
	});
	const write = vi.fn(async () => {
		throw new Error("R2 must not gate finalization");
	});
	const dispatch = vi.fn(async (_eventId: string) => {});
	const deps = createFinalizationDependencies(
		{ ...process.env, MEDIA_PROVIDER_ORIGINAL_DELIVERY_ENABLED: "true" },
		{
			database: db,
			deferOutputReview: true,
			dispatchArchive: dispatchOverride ?? dispatch,
			storage: {
				openInspectedRemoteMedia: async () => ({
					contentType: "image/png",
					headers: { "content-length": "32" },
					status: 200,
					url: new URL(output.url),
					stream: Readable.from([Buffer.alloc(32)]),
				}),
				tryWriteImmutableGenerationImage: write,
			},
		},
	);
	const result = await finalizeMedia({ jobId: job.id, version: job.version }, deps);
	const asset = await db.mediaAsset.findFirstOrThrow({ where: { ownerId, kind: "OUTPUT" } });
	return { job, asset, result, dispatch, write, deps };
}

async function approve(assetId: string) {
	const review = createDatabaseVerifyUploadDependencies(db, {
		safety: new TestMediaSafetyAdapter("ALLOW"),
		moderationProvider: "test",
		prepareProviderImageModeration: async () => ({
			assetUrl: "data:image/jpeg;base64,AA==",
			bytes: 32,
			checksum: "a".repeat(64),
		}),
		headObject: async () => {
			throw new Error("R2 HEAD must not run");
		},
	});
	await review.verify(assetId);
}

async function preparedArchive(f: Awaited<ReturnType<typeof fixture>>) {
	return (await prepareTargetedEvent(
		{ eventId: f.dispatch.mock.calls[0]![0], workerId: `archive:${f.asset.id}` },
		{
			prepare: (input) => prepareWorkflowOutboxEvent(input, db),
			resolve: async () => null,
			complete: (input) => completeWorkflowOutboxExecution(input, db),
		},
	))!;
}

function archiveDelivery() {
	return {
		begin: (input: Parameters<typeof beginWorkflowOutboxExecution>[0]) =>
			beginWorkflowOutboxExecution(input, db),
		complete: (input: Parameters<typeof completeWorkflowOutboxExecution>[0]) =>
			completeWorkflowOutboxExecution(input, db),
		defer: (input: Parameters<typeof deferWorkflowOutboxExecution>[0]) =>
			deferWorkflowOutboxExecution(input, db),
		fail: (input: Parameters<typeof failWorkflowOutboxExecution>[0]) =>
			failWorkflowOutboxExecution(input, db),
		execute: (task: { payload: Record<string, unknown> }) =>
			archiveProviderOriginal(task.payload.assetId as string, db),
		recover: async () => ({ continuation: { eventIds: [] } }),
	};
}

describe("approved provider originals independent of archival", () => {
	it("submits SeeAPI before archival and retrieves the same accepted task without preparing or submitting twice", async () => {
		const f = await fixture();
		const taskId = `review_${f.asset.id}`;
		const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
			const pending = init?.method === "POST";
			return Response.json({
				id: taskId,
				object: "inference",
				model: "nsfw-filter-2",
				endpoint: "image-moderation",
				provider: "seeapi",
				status: pending ? "processing" : "succeeded",
				result: pending
					? null
					: { type: "json", data: { flagged: false, categories: { nsfw: [], special_care: [] } } },
				error: null,
			});
		});
		const adapter = new SeeapiSafetyAdapter({ apiKey: "fixture-only", fetch: fetcher });
		const prepare = vi.fn(async () => ({
			assetUrl: "data:image/jpeg;base64,AA==",
			bytes: 32,
			checksum: "a".repeat(64),
		}));
		const review = createDatabaseVerifyUploadDependencies(db, {
			moderationProvider: "seeapi",
			safety: Object.assign(new TestMediaSafetyAdapter("ERROR"), {
				imageInputProfile: "seeapi-nsfw-filter-2" as const,
				submitImage: adapter.submitImage.bind(adapter),
				retrieveImage: adapter.retrieveImage.bind(adapter),
			}),
			prepareProviderImageModeration: prepare,
			environment: {
				...process.env,
				NEXT_PUBLIC_SAAS_URL: "https://app.test",
				WORKFLOWS_DISPATCH_SECRET: "fixture-only-secret-at-least-32-characters",
				SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({ whkey_test: `whsec_${"k".repeat(20)}` }),
			},
		});
		await review.verify(f.asset.id);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			status: "VERIFYING",
			verificationProviderTaskId: taskId,
		});
		await db.mediaAsset.update({
			where: { id: f.asset.id },
			data: { verificationNextAttemptAt: new Date(0) },
		});
		await review.verify(f.asset.id, { queryOnly: true });
		expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
		expect(prepare).toHaveBeenCalledOnce();
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			status: "READY",
		});
		expect(await db.mediaOutputOrigin.findUnique({ where: { assetId: f.asset.id } })).toMatchObject(
			{ archiveState: "PENDING" },
		);
	});

	it("makes the guest watermarked result ready without a clean R2 staging object", async () => {
		// Exercise the Workers-only producer predicate; external image bytes are
		// covered separately by the storage test, not claimed as a live Images test.
		const f = await runWithImageProcessor(
			{ ...createSharpImageProcessor(), key: "cloudflare-images" },
			() => fixture(undefined, true),
		);
		expect(f.write).not.toHaveBeenCalled();
		await approve(f.asset.id);
		const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id: f.asset.id } });
		expect(asset).toMatchObject({
			status: "READY",
			retentionClass: "GUEST_TRIAL",
			watermarkVersion: "ezpic-guest-origin-v1",
			cleanStagingDeletedAt: null,
			outputStagingObjectKey: null,
		});
		expect(asset.watermarkedAt).toBeInstanceOf(Date);
		const attempt = await db.generationAttempt.findFirstOrThrow({ where: { jobId: f.job.id } });
		expect(
			await createDatabaseFinalizationStore(db).findPersistedCandidate(f.job.id, `${attempt.id}:0`),
		).toMatchObject({ approved: true });
		await settleGeneration(
			{ jobId: f.job.id, version: f.job.version },
			{ store: createDatabaseSettlementStore(db) },
		);
		expect(await db.generationJob.findUnique({ where: { id: f.job.id } })).toMatchObject({
			status: "SUCCEEDED",
		});
	});

	it("continues to review while the managed archive wake is still in flight", async () => {
		let finish!: () => void;
		const pending: Promise<unknown>[] = [];
		const f = await runWithRequestDefer(
			(work) => {
				pending.push(work);
			},
			() =>
				fixture(
					() =>
						new Promise<void>((resolve) => {
							finish = resolve;
						}),
				),
		);
		try {
			expect(pending).toHaveLength(1);
			await approve(f.asset.id);
			expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
				status: "READY",
			});
		} finally {
			finish();
			await Promise.all(pending);
		}
	});

	it("completes review and settlement while a receipt-bound R2 write is stalled, then ACKs the same archive once", async () => {
		const f = await fixture();
		const task = await preparedArchive(f);
		let finish!: () => void;
		mocks.write.mockImplementationOnce(async (input: { reserve(bytes: number): Promise<void> }) => {
			await input.reserve(32);
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return { bytes: 32, sha256: "a".repeat(64), etag: '"stored"', versionId: null };
		});
		const running = executeTargetedEvent(task, archiveDelivery());
		try {
			await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
			await approve(f.asset.id);
			await settleGeneration(
				{ jobId: f.job.id, version: f.job.version },
				{ store: createDatabaseSettlementStore(db) },
			);
			expect(await db.generationJob.findUnique({ where: { id: f.job.id } })).toMatchObject({
				status: "SUCCEEDED",
			});
			expect(
				await db.mediaOutputOrigin.findUnique({ where: { assetId: f.asset.id } }),
			).toMatchObject({ archiveState: "PENDING" });
		} finally {
			finish?.();
			await running;
		}
		expect(
			await db.outboxEvent.findUnique({ where: { id: task.outboxReceipt!.eventId } }),
		).toMatchObject({ status: "PROCESSED" });
		const count = mocks.write.mock.calls.length;
		await executeTargetedEvent(task, archiveDelivery());
		expect(mocks.write).toHaveBeenCalledTimes(count);
		expect(await db.mediaOutputOrigin.findUnique({ where: { assetId: f.asset.id } })).toMatchObject(
			{ archiveState: "ARCHIVED" },
		);
	});

	it("recovers a lost begin/preflight before an archive lease exists without reopening paid work", async () => {
		const f = await fixture();
		const task = await preparedArchive(f);
		await beginWorkflowOutboxExecution({ ...task.outboxReceipt!, timeoutSeconds: 900 }, db);
		await recoverProviderOriginalArchives(db);
		expect(
			await db.outboxEvent.findUnique({ where: { id: task.outboxReceipt!.eventId } }),
		).toMatchObject({ status: "LEASED" });
		await db.outboxEvent.update({
			where: { id: task.outboxReceipt!.eventId },
			data: { leasedUntil: new Date(0) },
		});
		await recoverProviderOriginalArchives(db);
		expect(
			await db.outboxEvent.findUnique({ where: { id: task.outboxReceipt!.eventId } }),
		).toMatchObject({ status: "PENDING", lastError: null, leaseToken: null });
		expect(await preparedArchive(f)).toMatchObject({
			taskId: "media-archive-output",
			payload: { assetId: f.asset.id },
		});
	});

	it("retains successful output when archival fails and queues only an archival retry", async () => {
		const f = await fixture();
		await approve(f.asset.id);
		await settleGeneration(
			{ jobId: f.job.id, version: f.job.version },
			{ store: createDatabaseSettlementStore(db) },
		);
		mocks.write.mockRejectedValueOnce(new Error("R2 unavailable"));
		const result = (await executeTargetedEvent(await preparedArchive(f), archiveDelivery())) as {
			continuation: { eventIds: string[] };
		};
		expect(result.continuation.eventIds).toHaveLength(1);
		expect(
			await db.outboxEvent.findUnique({ where: { id: result.continuation.eventIds[0] } }),
		).toMatchObject({ eventType: "MEDIA_OUTPUT_ARCHIVE" });
		expect(await db.generationJob.findUnique({ where: { id: f.job.id } })).toMatchObject({
			status: "SUCCEEDED",
		});
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			status: "READY",
		});
	});

	it("recovers a scanned enqueue whose Workflow died before claiming storage", async () => {
		const f = await fixture();
		const eventId = f.dispatch.mock.calls[0]![0];
		await db.outboxEvent.update({
			where: { id: eventId },
			data: { status: "PROCESSED", createdAt: new Date(0) },
		});
		await db.generationJob.update({ where: { id: f.job.id }, data: { status: "SUCCEEDED" } });
		await recoverProviderOriginalArchives(db);
		await recoverProviderOriginalArchives(db);
		const pending = await db.outboxEvent.findMany({
			where: { eventType: "MEDIA_OUTPUT_ARCHIVE", aggregateId: f.asset.id, status: "PENDING" },
		});
		expect(pending).toHaveLength(1);
		expect(pending[0]!.id).not.toBe(eventId);
		expect(await db.mediaOutputOrigin.findUnique({ where: { assetId: f.asset.id } })).toMatchObject(
			{ attempts: 1, lastErrorCode: "ORIGINAL_ARCHIVE_EXECUTION_LOST" },
		);
	});

	it("marks an archive-first checksum mismatch without approving the different archived copy", async () => {
		const f = await fixture();
		const claim = (await claimProviderOriginalArchive(f.asset.id, db))!;
		await reserveProviderOriginalArchive(
			{
				assetId: f.asset.id,
				ownerId: f.job.ownerId,
				token: claim.token,
				bytes: 32,
				maximumStorageBytes: 1_000_000n,
			},
			db,
		);
		await completeProviderOriginalArchive(
			{
				assetId: f.asset.id,
				ownerId: f.job.ownerId,
				token: claim.token,
				bytes: 32,
				checksum: "b".repeat(64),
				etag: null,
				versionId: null,
			},
			db,
		);
		await approve(f.asset.id);
		expect(await db.mediaOutputOrigin.findUnique({ where: { assetId: f.asset.id } })).toMatchObject(
			{ archiveState: "FAILED", lastErrorCode: "ORIGINAL_ARCHIVE_IDENTITY_CHANGED" },
		);
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			status: "READY",
			checksum: "a".repeat(64),
		});
	});

	it("meters a write that finishes after deletion and durably queues its exact cleanup", async () => {
		const f = await fixture();
		const claim = (await claimProviderOriginalArchive(f.asset.id, db))!;
		await reserveProviderOriginalArchive(
			{
				assetId: f.asset.id,
				ownerId: f.job.ownerId,
				token: claim.token,
				bytes: 32,
				maximumStorageBytes: 1_000_000n,
			},
			db,
		);
		await db.mediaAsset.update({
			where: { id: f.asset.id },
			data: { status: "DELETED", deletedAt: new Date() },
		});
		await db.storageUsageReservation.update({
			where: { referenceKey: `generation-output:${f.asset.id}` },
			data: { status: "RELEASED", releasedAt: new Date() },
		});
		await db.mediaOutputOrigin.update({
			where: { assetId: f.asset.id },
			data: { leaseToken: null, leasedUntil: null },
		});
		await completeProviderOriginalArchive(
			{
				assetId: f.asset.id,
				ownerId: f.job.ownerId,
				token: claim.token,
				bytes: 32,
				checksum: "a".repeat(64),
				etag: null,
				versionId: null,
			},
			db,
		);
		expect(
			await db.storageUsageReservation.findUnique({
				where: { referenceKey: `generation-output:${f.asset.id}` },
			}),
		).toMatchObject({ status: "COMMITTED", bytes: 32n });
		expect(
			await db.outboxEvent.findFirst({
				where: { aggregateId: f.asset.id, eventType: "MEDIA_OBJECT_DELETE" },
			}),
		).toMatchObject({ payload: { objectKey: f.asset.objectKey } });
		expect(await claimProviderOriginalArchive(f.asset.id, db)).toBeNull();
	});

	it("starts review without a storage PUT and settles exactly once while R2 remains pending", async () => {
		const f = await fixture();
		expect(f.result.outcome).toBe("WAITING_MODERATION");
		expect(f.write).not.toHaveBeenCalled();
		expect(f.dispatch).toHaveBeenCalledOnce();
		const archiveId = f.dispatch.mock.calls[0]![0];
		expect(
			await prepareWorkflowOutboxEvent({ eventId: archiveId, workerId: "archive-test" }, db),
		).toMatchObject({ eventType: "MEDIA_OUTPUT_ARCHIVE" });
		const review = createDatabaseVerifyUploadDependencies(db, {
			safety: new TestMediaSafetyAdapter("ALLOW"),
			moderationProvider: "test",
			prepareProviderImageModeration: async () => ({
				assetUrl: "data:image/jpeg;base64,AA==",
				bytes: 32,
				checksum: "a".repeat(64),
			}),
			headObject: async () => {
				throw new Error("R2 HEAD must not run");
			},
			inspectPrivateMediaObject: async () => {
				throw new Error("R2 inspection must not run");
			},
		});
		await review.verify(f.asset.id);
		const ready = await db.mediaAsset.findUniqueOrThrow({ where: { id: f.asset.id } });
		expect(ready.status).toBe("READY");
		expect(ready.checksum).toBe("a".repeat(64));
		expect(await db.mediaOutputOrigin.findUnique({ where: { assetId: f.asset.id } })).toMatchObject(
			{ archiveState: "PENDING", archivedAt: null },
		);
		const finalizer = createDatabaseFinalizationStore(db);
		expect(
			await finalizer.findPersistedCandidate(
				f.job.id,
				`${(await db.generationAttempt.findFirstOrThrow({ where: { jobId: f.job.id } })).id}:0`,
			),
		).toMatchObject({ approved: true });
		const store = createDatabaseSettlementStore(db);
		await settleGeneration({ jobId: f.job.id, version: f.job.version }, { store });
		await settleGeneration({ jobId: f.job.id, version: f.job.version }, { store });
		expect(await db.generationJob.findUnique({ where: { id: f.job.id } })).toMatchObject({
			status: "SUCCEEDED",
		});
		expect(await db.creditReservation.findUnique({ where: { jobId: f.job.id } })).toMatchObject({
			settledAmount: 5n,
		});
	});

	it("archives independently, retains the detector identity, and recovers expired leases after job success", async () => {
		const f = await fixture();
		const claim = await claimProviderOriginalArchive(f.asset.id, db);
		expect(claim).not.toBeNull();
		await reserveProviderOriginalArchive(
			{
				assetId: f.asset.id,
				ownerId: f.job.ownerId,
				token: claim!.token,
				bytes: 32,
				maximumStorageBytes: 1_000_000n,
			},
			db,
		);
		await db.mediaAsset.update({ where: { id: f.asset.id }, data: { checksum: "a".repeat(64) } });
		await completeProviderOriginalArchive(
			{
				assetId: f.asset.id,
				ownerId: f.job.ownerId,
				token: claim!.token,
				bytes: 32,
				checksum: "b".repeat(64),
				etag: null,
				versionId: null,
			},
			db,
		);
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			checksum: "a".repeat(64),
			status: "VERIFYING",
		});
		expect(await db.mediaOutputOrigin.findUnique({ where: { assetId: f.asset.id } })).toMatchObject(
			{ archiveChecksum: "b".repeat(64) },
		);
		const other = await fixture();
		const lease = await claimProviderOriginalArchive(other.asset.id, db);
		await db.generationJob.update({ where: { id: other.job.id }, data: { status: "SUCCEEDED" } });
		await db.mediaOutputOrigin.update({
			where: { assetId: other.asset.id },
			data: { leasedUntil: new Date(0) },
		});
		await recoverProviderOriginalArchives(db);
		expect(
			await db.mediaOutputOrigin.findUnique({ where: { assetId: other.asset.id } }),
		).toMatchObject({ leaseToken: null, archiveState: "PENDING" });
		expect(await retryProviderOriginalArchive(other.asset.id, lease!.token, db)).toBeNull();
	});

	it("keeps rejected output private even when the R2 copy is complete", async () => {
		const f = await fixture();
		const review = createDatabaseVerifyUploadDependencies(db, {
			safety: new TestMediaSafetyAdapter("REJECT"),
			moderationProvider: "test",
			prepareProviderImageModeration: async () => ({
				assetUrl: "data:image/jpeg;base64,AA==",
				bytes: 32,
				checksum: "c".repeat(64),
			}),
		});
		await review.verify(f.asset.id);
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			status: "QUARANTINED",
		});
	});
});
