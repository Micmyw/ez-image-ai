import { TestMediaSafetyAdapter, type ProviderKey } from "@repo/ai";
import { ingestProviderEvent } from "@repo/database";
import { db } from "@repo/database/client";
import {
	abortMultipartObject,
	createDatabaseDispatchStore,
	createDatabaseFinalizationStore,
	createDatabaseSettlementStore,
	createDatabaseStorageCleanupDependencies,
	createDatabaseVerifyUploadDependencies,
	createFinalizationDependencies,
	databaseOutboxStore,
	deleteStorageObject,
	dispatchGeneration,
	dispatchOutbox,
	finalizeMedia,
	processProviderEvent,
	settleGeneration,
	verifyUpload,
} from "@repo/jobs";

import { LocalMediaE2EProvider, scenarioFromPrompt } from "./fixtures";
import { assertLocalMediaE2E } from "./guard";

const providers = new Map<ProviderKey, LocalMediaE2EProvider>();

export async function runPump(): Promise<never> {
	const { runId } = assertLocalMediaE2E();
	const workerId = `local-media-e2e-${runId}`;
	while (true) {
		await emitDelayedProviderEvents(runId);
		const result = await dispatchOutbox(
			{ workerId, limit: 50, leaseSeconds: 30 },
			{
				store: databaseOutboxStore,
				deliver: deliverLocally,
			},
		);
		await wait(result.claimed > 0 ? 20 : 100);
	}
}

async function deliverLocally(event: {
	eventType: string;
	aggregateId: string;
	payload: unknown;
}): Promise<void> {
	const payload = objectValue(event.payload);
	const jobId = stringValue(payload.jobId, event.aggregateId);
	switch (event.eventType) {
		case "JOB_CREATED":
		case "GENERATION_DISPATCH": {
			const job = await db.generationJob.findUniqueOrThrow({ where: { id: jobId } });
			await dispatchGeneration(
				{ jobId, version: integerValue(payload.version, job.version) },
				{
					store: createDatabaseDispatchStore(db),
					getProvider: providerFor,
				},
			);
			return;
		}
		case "PROVIDER_EVENT_RECEIVED":
			await processProviderEvent(
				{ providerWebhookEventId: stringValue(payload.providerWebhookEventId) },
				{
					store: (await import("@repo/jobs")).databaseProviderEventStore,
					getProvider: providerFor,
				},
			);
			return;
		case "GENERATION_FINALIZE":
		case "GENERATION_FINALIZE_RETRY": {
			const job = await db.generationJob.findUniqueOrThrow({ where: { id: jobId } });
			const scenario = scenarioFromPrompt(promptFrom(job.inputSnapshot));
			const dependencies = createFinalizationDependencies(process.env, {
				safety: new TestMediaSafetyAdapter(
					scenario === "moderation-rejection" ? "REJECT" : "ALLOW",
				),
				store: createDatabaseFinalizationStore(db),
			});
			await finalizeMedia({ jobId, version: job.version }, dependencies);
			return;
		}
		case "GENERATION_SETTLE":
		case "GENERATION_CANCEL_REQUESTED": {
			const job = await db.generationJob.findUniqueOrThrow({ where: { id: jobId } });
			await settleGeneration(
				{ jobId, version: job.version },
				{ store: createDatabaseSettlementStore(db) },
			);
			return;
		}
		case "MEDIA_ASSET_LEGACY_REVERIFY":
		case "MEDIA_ASSET_VERIFY":
		case "MEDIA_ASSET_MODERATION_REQUESTED": {
			const verifyDependencies = createDatabaseVerifyUploadDependencies(db, {
				safety: new TestMediaSafetyAdapter("ALLOW"),
				moderationProvider: "e2e-upload",
			});
			await verifyUpload(
				{
					assetId: stringValue(payload.assetId, event.aggregateId),
					...(event.eventType === "MEDIA_ASSET_LEGACY_REVERIFY" ||
					payload.allowQuarantinedReverification === true
						? { allowQuarantinedReverification: true }
						: {}),
				},
				{
					verify: (input, options) => verifyDependencies.verify(input, options),
				},
			);
			return;
		}
		case "MEDIA_OBJECT_DELETE":
			await deleteStorageObject(
				{
					assetId: stringValue(payload.assetId, event.aggregateId),
					objectKey: stringValue(payload.objectKey),
					...cleanupPayload(payload),
				},
				createDatabaseStorageCleanupDependencies(db),
			);
			return;
		case "MEDIA_UPLOAD_CLEANUP":
			if (typeof payload.multipartUploadId === "string") {
				await abortMultipartObject(
					{
						assetId: stringValue(payload.assetId, event.aggregateId),
						objectKey: stringValue(payload.objectKey),
						multipartUploadId: payload.multipartUploadId,
						...cleanupPayload(payload),
					},
					createDatabaseStorageCleanupDependencies(db),
				);
				return;
			}
			await deleteStorageObject(
				{
					assetId: stringValue(payload.assetId, event.aggregateId),
					objectKey: stringValue(payload.objectKey),
					...cleanupPayload(payload),
				},
				createDatabaseStorageCleanupDependencies(db),
			);
			return;
		case "MEDIA_MULTIPART_ABORT":
			await abortMultipartObject(
				{
					assetId: stringValue(payload.assetId, event.aggregateId),
					objectKey: stringValue(payload.objectKey),
					multipartUploadId: stringValue(payload.multipartUploadId),
					...cleanupPayload(payload),
				},
				createDatabaseStorageCleanupDependencies(db),
			);
			return;
		default:
			throw new Error(`LOCAL_MEDIA_E2E_UNSUPPORTED_OUTBOX: ${event.eventType}`);
	}
}

function cleanupPayload(payload: Record<string, unknown>): {
	cleanupObjectKeys?: string[];
	uploadSessionId?: string;
	reservationStatus?: "EXPIRED" | "RELEASED";
} {
	const cleanupObjectKeys = Array.isArray(payload.cleanupObjectKeys)
		? payload.cleanupObjectKeys.filter(
				(value): value is string => typeof value === "string" && value.length > 0,
			)
		: [];
	const uploadSessionId =
		typeof payload.uploadSessionId === "string" ? payload.uploadSessionId : undefined;
	const reservationStatus =
		payload.reservationStatus === "EXPIRED" || payload.reservationStatus === "RELEASED"
			? payload.reservationStatus
			: undefined;
	return {
		...(cleanupObjectKeys.length ? { cleanupObjectKeys } : {}),
		...(uploadSessionId && reservationStatus ? { uploadSessionId, reservationStatus } : {}),
	};
}

async function emitDelayedProviderEvents(runId: string): Promise<void> {
	const attempts = await db.generationAttempt.findMany({
		where: {
			status: { in: ["SUBMITTED", "RUNNING"] },
			providerTaskId: { startsWith: "e2e-" },
			updatedAt: { lte: new Date(Date.now() - 1_500) },
			job: { status: { in: ["PROVIDER_PENDING", "PROVIDER_RUNNING"] } },
		},
		include: { job: true },
	});
	for (const attempt of attempts) {
		if (scenarioFromPrompt(promptFrom(attempt.job.inputSnapshot)) !== "delayed-success") continue;
		await ingestProviderEvent(
			{
				provider: attempt.provider,
				providerEventId: `e2e:${runId}:complete:${attempt.id}`,
				providerTaskId: attempt.providerTaskId!,
				verifiedAt: new Date(),
				envelope: { status: "succeeded", runId },
			},
			db,
		);
	}
}

function providerFor(provider: ProviderKey): LocalMediaE2EProvider {
	let adapter = providers.get(provider);
	if (!adapter) {
		adapter = new LocalMediaE2EProvider(provider);
		providers.set(provider, adapter);
	}
	return adapter;
}

function promptFrom(value: unknown): string {
	const prompt = objectValue(value).prompt;
	return typeof prompt === "string" ? prompt : "";
}

function objectValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringValue(value: unknown, fallback?: string): string {
	const result = typeof value === "string" && value ? value : fallback;
	if (!result) throw new Error("LOCAL_MEDIA_E2E_PAYLOAD_INVALID");
	return result;
}

function integerValue(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

assertLocalMediaE2E();
runPump().catch(async (error) => {
	console.error(error);
	await db.$disconnect();
	process.exitCode = 1;
});
