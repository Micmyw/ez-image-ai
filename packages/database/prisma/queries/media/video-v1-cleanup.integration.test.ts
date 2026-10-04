import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import {
	claimVideoResourceCleanup,
	completeVideoResourceCleanup,
	listVideoResourceCleanupCandidates,
	listVideoStagingCleanup,
	completeVideoStagingCleanup,
} from "./video-v1-cleanup";
const ownerId = `video-cleanup-${randomUUID()}`;
const now = new Date();
const old = new Date(now.getTime() - 35 * 86_400_000);
let db: PrismaClient;
async function asset(kind: "INPUT" | "OUTPUT" = "INPUT") {
	return db.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind,
			verificationEngine: "video-workflow-v1",
			objectKey: `users/${ownerId}/${randomUUID()}.mp4`,
			mimeType: kind === "INPUT" ? "image/png" : "video/mp4",
			byteSize: 100n,
			createdAt: old,
			deleteAfter: old,
			status: "VERIFYING",
		},
	});
}
async function bind(assetId: string, stage: "NEEDS_REVIEW" | "READY") {
	const quote = await db.generationQuote.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "video-kling-2-6-v1",
			catalogVersion: "test",
			pricingVersion: "test",
			credits: 10n,
			costMicros: 0n,
			inputSnapshot: {},
			pricingSnapshot: {},
			expiresAt: new Date(now.getTime() + 60_000),
		},
	});
	const job = await db.generationJob.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: randomUUID(),
			productKey: quote.productKey,
			catalogVersion: "test",
			pricingVersion: "test",
			creditsReserved: 10n,
			inputSnapshot: {},
			pricingSnapshot: {},
			executionEngine: "video-workflow-v1",
			status: stage === "READY" ? "SUCCEEDED" : "NEEDS_RECONCILIATION",
		},
	});
	await db.videoExecution.create({
		data: {
			jobId: job.id,
			workflowInstanceId: `video-v1-${job.id}`,
			modelContractVersion: "test",
			stage,
		},
	});
	await db.generationJobAsset.create({
		data: { jobId: job.id, assetId, assetChecksum: "a".repeat(64), role: "OUTPUT" },
	});
	return job;
}
describe("video orphan resource isolation", () => {
	beforeAll(() => {
		const url = process.env.TEST_DATABASE_URL;
		if (!url) throw new Error("TEST_DATABASE_URL required");
		const parsed = new URL(url);
		if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !parsed.pathname.includes("test"))
			throw new Error("isolated test DB only");
		db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
	});
	afterAll(async () => {
		if (!db) return;
		await db.auditLog.deleteMany({
			where: {
				targetId: {
					in: (await db.mediaAsset.findMany({ where: { ownerId }, select: { id: true } })).map(
						(a) => a.id,
					),
				},
			},
		});
		await db.generationJob.deleteMany({ where: { ownerId } });
		await db.generationQuote.deleteMany({ where: { ownerId } });
		await db.mediaAsset.deleteMany({ where: { ownerId } });
		await db.storageUsageReservation.deleteMany({ where: { ownerId } });
		await db.$disconnect();
	});
	it("tombstones unbound expired input and releases storage only on completed cleanup", async () => {
		const input = await asset();
		await db.storageUsageReservation.create({
			data: {
				ownerType: "USER",
				ownerId,
				bytes: 100n,
				status: "COMMITTED",
				referenceKey: `generation-output:${input.id}`,
				expiresAt: old,
			},
		});
		const claimed = await claimVideoResourceCleanup(input.id, now, db);
		expect(claimed?.objectKeys).toEqual([input.objectKey]);
		expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: input.id } })).status).toBe(
			"DELETED",
		);
		expect(
			(
				await db.storageUsageReservation.findUniqueOrThrow({
					where: { referenceKey: `generation-output:${input.id}` },
				})
			).status,
		).toBe("COMMITTED");
		expect(
			(await listVideoResourceCleanupCandidates({ limit: 100, now }, db)).some(
				(a) => a.id === input.id,
			),
		).toBe(true);
		await completeVideoResourceCleanup(claimed!, now, db);
		expect(
			(
				await db.storageUsageReservation.findUniqueOrThrow({
					where: { referenceKey: `generation-output:${input.id}` },
				})
			).status,
		).toBe("RELEASED");
		expect(
			(await listVideoResourceCleanupCandidates({ limit: 100, now }, db)).some(
				(a) => a.id === input.id,
			),
		).toBe(false);
	});
	it("protects active review and uncertain attempts even after retention expires", async () => {
		const output = await asset("OUTPUT");
		const job = await bind(output.id, "NEEDS_REVIEW");
		expect(await claimVideoResourceCleanup(output.id, now, db)).toBeNull();
		expect(
			(await listVideoResourceCleanupCandidates({ limit: 100, now }, db)).some(
				(a) => a.id === output.id,
			),
		).toBe(false);
		await db.videoExecution.update({ where: { jobId: job.id }, data: { stage: "READY" } });
		await db.generationJob.update({ where: { id: job.id }, data: { status: "SUCCEEDED" } });
		await db.generationAttempt.create({
			data: {
				jobId: job.id,
				attemptNumber: 1,
				provider: "kie",
				providerModelId: "test",
				status: "SUBMISSION_UNCERTAIN",
				uncertainSubmission: true,
				requestSnapshot: {},
			},
		});
		expect(await claimVideoResourceCleanup(output.id, now, db)).toBeNull();
		expect(
			(await db.mediaAsset.findUniqueOrThrow({ where: { id: output.id } })).deletedAt,
		).toBeNull();
	});
	it("allows only terminal retained output and preserves non-video assets", async () => {
		const output = await asset("OUTPUT");
		await bind(output.id, "READY");
		expect(await claimVideoResourceCleanup(output.id, now, db)).not.toBeNull();
		const legacy = await db.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				objectKey: randomUUID(),
				mimeType: "image/png",
				byteSize: 1n,
				createdAt: old,
				deleteAfter: old,
			},
		});
		expect(await claimVideoResourceCleanup(legacy.id, now, db)).toBeNull();
	});
	it("clears completed staging only after signed write grace without deleting live final inputs", async () => {
		const input = await asset();
		const session = await db.mediaUploadSession.create({
			data: {
				assetId: input.id,
				tokenHash: randomUUID(),
				stagingObjectKey: `stage/${randomUUID()}`,
				status: "COMPLETED",
				completedAt: new Date(now.getTime() - 660_000),
				expectedBytes: 100n,
				expiresAt: old,
			},
		});
		const candidates = await listVideoStagingCleanup({ limit: 100, now }, db);
		const item = candidates.find((s) => s.sessionId === session.id);
		expect(item?.stagingKey).toBe(session.stagingObjectKey);
		await completeVideoStagingCleanup(item!, db);
		expect(
			(await db.mediaUploadSession.findUniqueOrThrow({ where: { id: session.id } }))
				.stagingObjectKey,
		).toBeNull();
		expect(
			(await db.mediaAsset.findUniqueOrThrow({ where: { id: input.id } })).deletedAt,
		).toBeNull();
	});
	it("recovers obsolete normalized source after staging was already cleared", async () => {
		const input = await asset();
		const normalizedKey = `${input.objectKey}.video-input.png`;
		await db.mediaAsset.update({ where: { id: input.id }, data: { objectKey: normalizedKey } });
		const session = await db.mediaUploadSession.create({
			data: {
				assetId: input.id,
				tokenHash: randomUUID(),
				stagingObjectKey: null,
				status: "COMPLETED",
				completedAt: old,
				expectedBytes: 100n,
				expiresAt: old,
			},
		});
		await db.storageUsageReservation.create({
			data: {
				ownerType: "USER",
				ownerId,
				bytes: 200n,
				status: "COMMITTED",
				referenceKey: `media-upload:${session.id}`,
				expiresAt: old,
			},
		});
		const item = (await listVideoStagingCleanup({ limit: 100, now }, db)).find(
			(s) => s.sessionId === session.id,
		);
		expect(item).toMatchObject({ stagingKey: null, sourceKey: input.objectKey });
		await completeVideoStagingCleanup(item!, db);
		expect(
			(
				await db.storageUsageReservation.findUniqueOrThrow({
					where: { referenceKey: `media-upload:${session.id}` },
				})
			).bytes,
		).toBe(100n);
		expect(
			(await listVideoStagingCleanup({ limit: 100, now }, db)).some(
				(s) => s.sessionId === session.id,
			),
		).toBe(false);
		expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: input.id } })).objectKey).toBe(
			normalizedKey,
		);
	});
});
