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
async function bind(assetId: string, stage: "NEEDS_REVIEW" | "READY" | "FAILED" | "REJECTED") {
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
			status:
				stage === "READY"
					? "SUCCEEDED"
					: stage === "NEEDS_REVIEW"
						? "NEEDS_RECONCILIATION"
						: "FAILED",
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

async function deliveredOutput(deleteAfter: Date | null, createdAt = old) {
	const output = await asset("OUTPUT");
	const job = await bind(output.id, "READY");
	const validUntil = new Date(now.getTime() + 40 * 86_400_000);
	await db.assetModerationResult.create({
		data: {
			assetId: output.id,
			assetChecksum: "a".repeat(64),
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: "OUTPUT",
			provider: "retention-test",
			ruleVersion: "test",
			policyVersion: "test",
			status: "APPROVED",
			reasonCode: "ISOLATED_RETENTION_FIXTURE",
			categories: {},
			rawEnvelope: {},
			validUntil,
		},
	});
	await db.mediaAsset.update({
		where: { id: output.id },
		data: {
			status: "READY",
			deleteAfter,
			createdAt,
			checksum: "a".repeat(64),
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "retention-test",
			verificationRuleVersion: "test",
			verificationPolicyVersion: "test",
			verificationValidUntil: validUntil,
		},
	});
	return { output, job };
}

async function isCleanupCandidate(assetId: string, at = now) {
	return (await listVideoResourceCleanupCandidates({ limit: 100, now: at }, db)).some(
		(candidate) => candidate.id === assetId,
	);
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
		// Moderation evidence is append-only, including synthetic evidence in this isolated DB.
		await db.mediaAsset.updateMany({
			where: { ownerId, moderationResults: { some: {} } },
			data: { status: "DELETED", deletedAt: now, videoCleanupCompletedAt: now },
		});
		await db.mediaAsset.deleteMany({ where: { ownerId, moderationResults: { none: {} } } });
		await db.storageUsageReservation.deleteMany({ where: { ownerId } });
		await db.$disconnect();
	});
	it.each(["candidate scan", "transaction claim"] as const)(
		"preserves old delivered output until explicit retention expires in the %s",
		async (entry) => {
			const { output } = await deliveredOutput(new Date(now.getTime() + 7 * 86_400_000));
			if (entry === "candidate scan") expect(await isCleanupCandidate(output.id)).toBe(false);
			else expect(await claimVideoResourceCleanup(output.id, now, db)).toBeNull();
			expect(await db.mediaAsset.findUniqueOrThrow({ where: { id: output.id } })).toMatchObject({
				status: "READY",
				deletedAt: null,
			});
		},
	);
	it.each([-1, 0, 1])("uses the explicit output deadline at offset %i ms", async (offset) => {
		const { output } = await deliveredOutput(now, new Date(now.getTime() - 2 * 86_400_000));
		const at = new Date(now.getTime() + offset);
		expect(await isCleanupCandidate(output.id, at)).toBe(offset >= 0);
		const claim = await claimVideoResourceCleanup(output.id, at, db);
		if (offset >= 0) expect(claim).not.toBeNull();
		else expect(claim).toBeNull();
	});
	it("rechecks the deadline in the transaction after an earlier candidate scan", async () => {
		const { output } = await deliveredOutput(old);
		expect(await isCleanupCandidate(output.id)).toBe(true);
		await db.mediaAsset.update({
			where: { id: output.id },
			data: { deleteAfter: new Date(now.getTime() + 86_400_000) },
		});
		expect(await claimVideoResourceCleanup(output.id, now, db)).toBeNull();
	});
	it("keeps a delivered output with missing retention metadata for explicit repair", async () => {
		const { output } = await deliveredOutput(null);
		expect(await isCleanupCandidate(output.id)).toBe(false);
		expect(await claimVideoResourceCleanup(output.id, now, db)).toBeNull();
		await db.mediaAsset.update({
			where: { id: output.id },
			data: { status: "VERIFICATION_FAILED" },
		});
		// The successful owning job remains proof of delivery even if asset state later changes.
		expect(await isCleanupCandidate(output.id)).toBe(false);
		expect(await claimVideoResourceCleanup(output.id, now, db)).toBeNull();
	});
	it.each(["FAILED", "REJECTED"] as const)(
		"allows the age fallback only for an undelivered %s output without an explicit deadline",
		async (stage) => {
			const output = await asset("OUTPUT");
			await bind(output.id, stage);
			await db.mediaAsset.update({
				where: { id: output.id },
				data: {
					deleteAfter: null,
					status: stage === "FAILED" ? "VERIFICATION_FAILED" : "QUARANTINED",
					createdAt: new Date(now.getTime() - 30 * 86_400_000 + 1),
				},
			});
			expect(await isCleanupCandidate(output.id)).toBe(false);
			expect(await claimVideoResourceCleanup(output.id, now, db)).toBeNull();
			await db.mediaAsset.update({ where: { id: output.id }, data: { createdAt: old } });
			expect(await isCleanupCandidate(output.id)).toBe(true);
			expect(await claimVideoResourceCleanup(output.id, now, db)).not.toBeNull();
		},
	);
	it("honors an explicit future deadline on failed output instead of the age fallback", async () => {
		const output = await asset("OUTPUT");
		await bind(output.id, "FAILED");
		await db.mediaAsset.update({
			where: { id: output.id },
			data: { status: "VERIFICATION_FAILED", deleteAfter: new Date(now.getTime() + 1) },
		});
		expect(await isCleanupCandidate(output.id)).toBe(false);
		expect(await claimVideoResourceCleanup(output.id, now, db)).toBeNull();
	});
	it("retains job storage reservation through tombstoning until physical cleanup completes", async () => {
		const { output, job } = await deliveredOutput(now);
		const reservation = await db.storageUsageReservation.create({
			data: {
				ownerType: "USER",
				ownerId,
				bytes: 100n,
				status: "COMMITTED",
				referenceKey: `video-output:${job.id}`,
				expiresAt: old,
			},
		});
		const claim = await claimVideoResourceCleanup(output.id, now, db);
		expect(claim).not.toBeNull();
		expect(claim?.objectKeys).toContain(output.objectKey);
		expect(
			await db.storageUsageReservation.findUniqueOrThrow({ where: { id: reservation.id } }),
		).toMatchObject({ status: "COMMITTED", releasedAt: null });
		// A failed object deletion leaves the claim retryable and the bytes occupied.
		expect(await isCleanupCandidate(output.id)).toBe(true);
		const retried = await claimVideoResourceCleanup(output.id, now, db);
		expect(retried?.objectKeys).toEqual(claim!.objectKeys);
		await completeVideoResourceCleanup(retried!, now, db);
		await completeVideoResourceCleanup(retried!, now, db);
		expect(
			await db.storageUsageReservation.findUniqueOrThrow({ where: { id: reservation.id } }),
		).toMatchObject({ status: "RELEASED", releasedAt: now });
		expect(await isCleanupCandidate(output.id)).toBe(false);
		expect(
			await db.auditLog.count({
				where: { targetId: output.id, action: "VIDEO_RESOURCE_CLEANUP_COMPLETED" },
			}),
		).toBe(1);
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
	it.each([
		{
			label: "live job",
			jobStatus: "PROVIDER_PENDING",
			stage: "FAILED",
			attempt: null,
			uncertain: false,
		},
		{
			label: "manual review",
			jobStatus: "FAILED",
			stage: "NEEDS_REVIEW",
			attempt: null,
			uncertain: false,
		},
		{
			label: "uncertain attempt",
			jobStatus: "FAILED",
			stage: "FAILED",
			attempt: "SUBMISSION_UNCERTAIN",
			uncertain: false,
		},
		{
			label: "uncertainty flag",
			jobStatus: "FAILED",
			stage: "FAILED",
			attempt: "SUBMITTED",
			uncertain: true,
		},
		{
			label: "manual reconciliation",
			jobStatus: "FAILED",
			stage: "FAILED",
			attempt: "NEEDS_RECONCILIATION",
			uncertain: false,
		},
	] as const)("preserves an otherwise expired output protected by $label", async (scenario) => {
		const output = await asset("OUTPUT");
		const job = await bind(output.id, "FAILED");
		await db.generationJob.update({ where: { id: job.id }, data: { status: scenario.jobStatus } });
		await db.videoExecution.update({ where: { jobId: job.id }, data: { stage: scenario.stage } });
		if (scenario.attempt) {
			await db.generationAttempt.create({
				data: {
					jobId: job.id,
					attemptNumber: 1,
					provider: "kie",
					providerModelId: "test",
					status: scenario.attempt,
					uncertainSubmission: scenario.uncertain,
					requestSnapshot: {},
				},
			});
		}
		expect(await isCleanupCandidate(output.id)).toBe(false);
		expect(await claimVideoResourceCleanup(output.id, now, db)).toBeNull();
	});
	it("protects active review and uncertain attempts even after retention expires", async () => {
		const output = await asset("OUTPUT");
		const job = await bind(output.id, "NEEDS_REVIEW");
		expect(await claimVideoResourceCleanup(output.id, now, db)).toBeNull();
		expect(await isCleanupCandidate(output.id)).toBe(false);
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
		expect(await isCleanupCandidate(output.id)).toBe(false);
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
