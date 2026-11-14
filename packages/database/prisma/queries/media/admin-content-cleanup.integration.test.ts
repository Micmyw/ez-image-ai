import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "../../generated/client";
import {
	executeAdminContentCleanup,
	listRecentAdminContentCleanupPlans,
	previewAdminContentCleanup,
} from "./admin-content-cleanup";
import { claimMediaStorageCleanupTransaction } from "./storage-cleanup";

let db: PrismaClient;
const prefix = `admin-cleanup-test-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const admin = `${prefix}-admin`;
const created: string[] = [];
beforeAll(async () => {
	const connectionString = process.env.TEST_DATABASE_URL;
	if (!connectionString || connectionString === process.env.DATABASE_URL)
		throw new Error("UNSAFE_TEST_DATABASE");
	const url = new URL(connectionString);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname))
		throw new Error("UNSAFE_TEST_DATABASE");
	db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
	await db.$connect();
});
afterAll(async () => {
	vi.unstubAllEnvs();
	// Append-only proof rows deliberately remain in this isolated, task-owned test database.
	// Unique fixture IDs avoid interfering with other integration tests; never disable triggers.
	await db?.$disconnect();
});
async function asset(patch: Record<string, unknown> = {}) {
	const id = `${prefix}-${created.length}`;
	created.push(id);
	return db.mediaAsset.create({
		data: {
			id,
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "QUARANTINED",
			retentionClass: "GUEST_TRIAL",
			objectKey: `users/${ownerId}/assets/${id}.png`,
			byteSize: 512n,
			mimeType: "image/png",
			checksum: "a".repeat(64),
			finalizedAt: new Date(),
			...patch,
		},
	});
}
function preview(
	assetIds: string[],
	extra: Partial<Parameters<typeof previewAdminContentCleanup>[0]> = {},
) {
	return previewAdminContentCleanup(
		{
			assetIds,
			reason: "Remove selected test fixture",
			includeExpiredInternalDiagnostics: false,
			...extra,
		},
		admin,
		db,
	);
}
function execute(plan: Awaited<ReturnType<typeof preview>>) {
	return executeAdminContentCleanup(
		{ planId: plan.planId, planHash: plan.planHash, confirmation: plan.confirmation },
		admin,
		db,
	);
}

describe("exact administrator cleanup plans on PostgreSQL", () => {
	it("previews without deleting and queues a durable exact-object tombstone, retaining quota and immutable evidence", async () => {
		vi.stubEnv("MEDIA_IMAGE_AUTO_DELETE_ENABLED", "false");
		const item = await asset();
		await db.storageUsageReservation.create({
			data: {
				ownerType: "USER",
				ownerId,
				bytes: 512n,
				referenceKey: `media-draft:${item.id}`,
				status: "COMMITTED",
				expiresAt: new Date(0),
			},
		});
		const evidence = await db.assetModerationResult.create({
			data: {
				assetId: item.id,
				assetChecksum: item.checksum!,
				verificationGeneration: 0,
				attemptNumber: 0,
				evidenceKind: "INPUT",
				provider: "seeapi",
				ruleVersion: "test",
				policyVersion: "test",
				status: "REJECTED",
				reasonCode: "SEEAPI_CONTENT_NOT_ALLOWED",
				categories: [],
				rawEnvelope: { retained: true },
			},
		});
		const plan = await preview([item.id]);
		expect(plan).toMatchObject({ assetCount: 1, assetBytes: "512", logCount: 0 });
		expect(JSON.stringify(plan)).not.toMatch(/objectKey|users\/|checksum/);
		expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
			"QUARANTINED",
		);
		expect(await execute(plan)).toMatchObject({ queuedAssets: 1, replayed: false });
		expect(await execute(plan)).toMatchObject({ queuedAssets: 1, replayed: true });
		expect(
			await db.outboxEvent.count({
				where: { aggregateId: item.id, eventType: "MEDIA_OBJECT_DELETE" },
			}),
		).toBe(1);
		expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
			"DELETED",
		);
		expect(
			(
				await db.storageUsageReservation.findUniqueOrThrow({
					where: { referenceKey: `media-draft:${item.id}` },
				})
			).status,
		).toBe("COMMITTED");
		expect(
			await db.assetModerationResult.findUnique({ where: { id: evidence.id } }),
		).not.toBeNull();
		expect(
			await claimMediaStorageCleanupTransaction(
				{ assetId: item.id, objectKeys: [item.objectKey], releasesReservation: true },
				db,
			),
		).toBe("DELETE");
		await db.mediaAsset.update({ where: { id: item.id }, data: { checksum: "b".repeat(64) } });
		expect(
			await claimMediaStorageCleanupTransaction(
				{ assetId: item.id, objectKeys: [item.objectKey], releasesReservation: true },
				db,
			),
		).toEqual({ outcome: "DEFER", retainedObjectKey: item.objectKey });
	});
	it("rejects altered identity, another administrator, changed checksum and confirmation mismatch atomically", async () => {
		const item = await asset();
		const plan = await preview([item.id]);
		await expect(
			executeAdminContentCleanup(
				{ ...plan, confirmation: plan.confirmation },
				`${admin}-other`,
				db,
			),
		).rejects.toThrow("ADMIN_CLEANUP_PLAN_INVALID");
		await expect(
			executeAdminContentCleanup(
				{ planId: plan.planId, planHash: "0".repeat(64), confirmation: plan.confirmation },
				admin,
				db,
			),
		).rejects.toThrow("ADMIN_CLEANUP_PLAN_INVALID");
		await expect(
			executeAdminContentCleanup(
				{ planId: plan.planId, planHash: plan.planHash, confirmation: "delete all" },
				admin,
				db,
			),
		).rejects.toThrow("ADMIN_CLEANUP_CONFIRMATION_REQUIRED");
		await db.mediaAsset.update({ where: { id: item.id }, data: { checksum: "c".repeat(64) } });
		await expect(execute(plan)).rejects.toThrow("ADMIN_CLEANUP_PLAN_STALE");
		expect(await db.outboxEvent.count({ where: { aggregateId: item.id } })).toBe(0);
	});
	it.each([
		[{ verificationSubmissionUncertain: true }, "UNCERTAIN_REVIEW"],
		[{ verificationLeaseToken: randomUUID() }, "ACTIVE_REVIEW"],
		[{ status: "VERIFYING" }, "ASSET_NOT_TERMINAL"],
		[{ outputTransferToken: randomUUID() }, "ACTIVE_TRANSFER"],
	])("blocks unsafe asset state %s", async (patch, expected) => {
		const item = await asset(patch);
		const plan = await preview([item.id]);
		expect(plan.assets[0]?.blocked).toContain(expected);
		expect(plan.assetCount).toBe(0);
	});
	it("blocks an active storage reservation and retains every copy proof journal", async () => {
		const item = await asset();
		await db.storageUsageReservation.create({
			data: {
				ownerType: "USER",
				ownerId,
				bytes: 512n,
				referenceKey: `media-draft:${item.id}`,
				status: "ACTIVE",
				expiresAt: new Date(0),
			},
		});
		expect((await preview([item.id])).assets[0]?.blocked).toContain("ACTIVE_STORAGE_RESERVATION");
		await db.storageUsageReservation.update({
			where: { referenceKey: `media-draft:${item.id}` },
			data: { status: "COMMITTED" },
		});
		for (const eventType of ["ACCOUNT_INPUT_COPY_REVIEW_SOURCE", "ACCOUNT_INPUT_COPY_READBACK"])
			await db.outboxEvent.create({
				data: {
					eventType,
					aggregateType: "MEDIA_ASSET",
					aggregateId: item.id,
					dedupeKey: `${prefix}:${eventType}:${item.id}`,
					status: "PROCESSED",
					processedAt: new Date(),
					payload: { immutable: true },
				},
			});
		const copying = await db.outboxEvent.create({
			data: {
				eventType: "ACCOUNT_INPUT_COPY_INTENT",
				aggregateType: "MEDIA_ASSET",
				aggregateId: item.id,
				dedupeKey: `${prefix}:copy:${item.id}`,
				status: "PROCESSED",
				payload: {
					source: { assetId: item.id },
					target: { assetId: "target" },
					phase: "READY",
					uncertainWriter: true,
				},
			},
		});
		expect((await preview([item.id])).assets[0]?.blocked).toContain("ACTIVE_OR_UNCERTAIN_COPY");
		await db.outboxEvent.update({
			where: { id: copying.id },
			data: {
				payload: {
					source: { assetId: item.id },
					target: { assetId: "target" },
					phase: "READY",
					uncertainWriter: false,
				},
			},
		});
		await execute(await preview([item.id]));
		expect(
			await db.outboxEvent.count({
				where: { aggregateId: item.id, eventType: { startsWith: "ACCOUNT_INPUT_COPY_" } },
			}),
		).toBe(3);
	});
	it("deletes only selected expired internal telemetry and preserves real and recent visitors", async () => {
		const ids = ["old-internal", "old-real", "new-internal"].map((suffix) => `${prefix}-${suffix}`);
		await db.growthEvent.createMany({
			data: ids.map((id, index) => ({
				id,
				sessionHash: "test",
				name: "generation_ui_error",
				device: "test",
				internal: index !== 1,
				createdAt: index === 2 ? new Date() : new Date("2025-01-01T00:00:00Z"),
				diagnostics: { safe: "test" },
			})),
		});
		const plan = await preview([], {
			includeExpiredInternalDiagnostics: true,
			diagnosticEventIds: ids,
		});
		expect(plan.logCount).toBe(1);
		expect(await execute(plan)).toMatchObject({ deletedLogs: 1, queuedAssets: 0 });
		expect(
			await db.growthEvent.findMany({ where: { id: { in: ids } }, select: { id: true } }),
		).toEqual(expect.arrayContaining([{ id: ids[1] }, { id: ids[2] }]));
	});
	it("rechecks a newly active copy before tombstoning and rolls back the whole plan", async () => {
		const first = await asset();
		const second = await asset();
		const plan = await preview([first.id, second.id]);
		await db.outboxEvent.create({
			data: {
				eventType: "ACCOUNT_INPUT_COPY_INTENT",
				aggregateType: "MEDIA_ASSET",
				aggregateId: second.id,
				dedupeKey: `${prefix}:late-copy:${second.id}`,
				payload: { source: { assetId: second.id }, phase: "COPYING", uncertainWriter: false },
			},
		});
		await expect(execute(plan)).rejects.toThrow("ADMIN_CLEANUP_PLAN_STALE");
		expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
			"QUARANTINED",
		);
		expect(
			await db.outboxEvent.count({
				where: { aggregateId: first.id, eventType: "MEDIA_OBJECT_DELETE" },
			}),
		).toBe(0);
	});
	it("retains an unexpired claimed SUBMITTED draft before any generation job exists", async () => {
		const item = await asset();
		await db.generationDraft.create({
			data: {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				claimTokenHash: randomUUID(),
				assetId: item.id,
				inputSnapshot: { prompt: "Still editing after login" },
				status: "SUBMITTED",
				expiresAt: new Date(Date.now() + 60_000),
			},
		});
		expect((await preview([item.id])).assets[0]?.blocked).toContain("ACTIVE_DRAFT");
		expect(await db.generationJobAsset.count({ where: { assetId: item.id } })).toBe(0);
	});
	it("protects unconsumed guest completion receipts that may still create a draft", async () => {
		const item = await asset();
		await db.mediaUploadSession.create({
			data: {
				assetId: item.id,
				tokenHash: randomUUID(),
				status: "COMPLETED",
				expectedBytes: item.byteSize,
				completedAt: new Date(),
				expiresAt: new Date(Date.now() + 60_000),
			},
		});
		expect((await preview([item.id])).assets[0]?.blocked).toContain("UNCONSUMED_GUEST_UPLOAD");
	});
	it("requeues a failed physical cleanup with exactly the same durable event and object", async () => {
		const item = await asset();
		const plan = await preview([item.id]);
		await execute(plan);
		const event = await db.outboxEvent.findUniqueOrThrow({
			where: { dedupeKey: `admin-media-object-delete:${plan.planId}:${item.id}` },
		});
		await db.outboxEvent.update({
			where: { id: event.id },
			data: { status: "DEAD_LETTER", attempts: 12, lastError: "STORAGE_TEMPORARY" },
		});
		expect(await execute(plan)).toMatchObject({ replayed: true, requeuedAssets: 1 });
		const retried = await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
		expect(retried).toMatchObject({
			status: "PENDING",
			attempts: 0,
			payload: event.payload,
			dedupeKey: event.dedupeKey,
		});
		expect(
			await db.outboxEvent.count({
				where: { aggregateId: item.id, eventType: "MEDIA_OBJECT_DELETE" },
			}),
		).toBe(1);
	});
	it("blocks live and uncertain bound provider jobs while preserving financial snapshots", async () => {
		const item = await asset();
		const quote = await db.generationQuote.create({
			data: {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				productKey: "image-minimax-h3",
				catalogVersion: "test",
				pricingVersion: "test",
				credits: 5n,
				costMicros: 1n,
				inputSnapshot: { prompt: "test" },
				pricingSnapshot: { immutable: "billing-proof" },
				expiresAt: new Date(Date.now() + 60_000),
			},
		});
		const job = await db.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				quoteId: quote.id,
				idempotencyKey: `${prefix}-job`,
				productKey: quote.productKey,
				catalogVersion: "test",
				pricingVersion: "test",
				creditsReserved: 5n,
				inputSnapshot: quote.inputSnapshot!,
				pricingSnapshot: quote.pricingSnapshot!,
				status: "PROVIDER_PENDING",
			},
		});
		await db.generationJobAsset.create({
			data: {
				jobId: job.id,
				assetId: item.id,
				role: "INPUT",
				position: 0,
				assetChecksum: item.checksum!,
			},
		});
		expect((await preview([item.id])).assets[0]?.blocked).toContain("ACTIVE_JOB_OR_RESERVATION");
		await db.generationJob.update({
			where: { id: job.id },
			data: { status: "FAILED", terminalAt: new Date() },
		});
		const attempt = await db.generationAttempt.create({
			data: {
				jobId: job.id,
				attemptNumber: 1,
				provider: "kie",
				providerModelId: "test",
				status: "FAILED",
				uncertainSubmission: true,
				completedAt: new Date(),
				requestSnapshot: { immutable: true },
			},
		});
		expect((await preview([item.id])).assets[0]?.blocked).toContain("ACTIVE_JOB_OR_RESERVATION");
		expect(
			(await db.generationQuote.findUniqueOrThrow({ where: { id: quote.id } })).pricingSnapshot,
		).toEqual({ immutable: "billing-proof" });
		expect(
			(await db.generationAttempt.findUniqueOrThrow({ where: { id: attempt.id } }))
				.uncertainSubmission,
		).toBe(true);
	});
	it("restores only this actor's confirmed plans without exposing private object identity", async () => {
		const item = await asset();
		const pendingOnly = await preview([item.id]);
		expect(
			(await listRecentAdminContentCleanupPlans(admin, db)).map((plan) => plan.planId),
		).not.toContain(pendingOnly.planId);
		await execute(pendingOnly);
		const plans = await listRecentAdminContentCleanupPlans(admin, db);
		expect(plans).toHaveLength(5);
		expect(plans.map((plan) => plan.planId)).toContain(pendingOnly.planId);
		expect(JSON.stringify(plans)).not.toMatch(/objectKey|users\/|checksum/);
		expect(await listRecentAdminContentCleanupPlans(`${admin}-other`, db)).toEqual([]);
	});
});
