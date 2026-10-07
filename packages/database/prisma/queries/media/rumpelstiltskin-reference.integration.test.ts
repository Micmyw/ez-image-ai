import { createHash, randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { createVideoEffectTemplateSnapshot } from "@repo/config/video-effects.server";
import { createVideoAudioSafetyPolicy } from "@repo/config/video-output";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runWithDatabaseClient } from "../../client";
import { PrismaClient, type Prisma } from "../../generated/client";
import { createCreditGrant, releaseCredits } from "./credits";
import {
	createVideoTemplateJobRecord,
	createVideoTemplateQuoteRecord,
} from "./video-template-admission";
import {
	claimVideoTemplateImageReview,
	finalizeVideoTemplateReferenceInput,
	getVideoEffectiveInputSnapshot,
	getVideoTemplateExecution,
	recordVideoTemplateImageReview,
	recordVideoTemplateReview,
} from "./video-template-execution";
import { fingerprintVideoTemplateReferenceApproval } from "./video-template-reference";

const textProfile = createVideoTextSafetyProfile();
const object = (value: unknown) => value as Record<string, unknown>;
const owners: string[] = [];
let db: PrismaClient;
const run = <T>(operation: () => T) => runWithDatabaseClient(db, operation);

beforeAll(() => {
	const raw = process.env.TEST_DATABASE_URL;
	if (!raw) throw new Error("TEST_DATABASE_URL_REQUIRED");
	const url = new URL(raw);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.pathname.includes("test"))
		throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
	db = new PrismaClient({ adapter: new PrismaPg({ connectionString: raw, max: 10 }) });
});

afterAll(async () => {
	if (!db) return;
	try {
		// Release only this suite's synthetic reservations; preserve immutable history.
		for (const ownerId of owners) {
			const jobs = await db.generationJob.findMany({
				where: { ownerId },
				include: { reservation: true },
			});
			for (const job of jobs) {
				if (job.reservation?.status === "ACTIVE")
					await releaseCredits(
						{
							reservationId: job.reservation.id,
							referenceKey: `reference-test-cleanup:${job.id}`,
						},
						db,
					);
				await db.videoExecution.update({ where: { jobId: job.id }, data: { stage: "FAILED" } });
				await db.generationJob.update({
					where: { id: job.id },
					data: { status: "FAILED", terminalAt: new Date() },
				});
			}
			await db.storageUsageReservation.updateMany({
				where: { ownerType: "USER", ownerId, status: "ACTIVE" },
				data: { status: "RELEASED", releasedAt: new Date() },
			});
		}
	} finally {
		await db.$disconnect();
	}
});

async function fixture(
	options: { wrongReferenceOwner?: boolean; missingRightsEvidence?: boolean } = {},
) {
	const ownerId = `reference-db-test-${randomUUID()}`;
	owners.push(ownerId);
	const referenceOwnerId = `reference-admin-${randomUUID()}`;
	const expiresAt = new Date(Date.now() + 3_600_000);
	const expiry = expiresAt.toISOString();
	const visualProfile = createVideoVisualSafetyProfile("seeapi", 5);
	const taskId = `synthetic-reference-review-${randomUUID()}`;
	const etag = `synthetic-reference-etag-${randomUUID()}`;
	const version = "synthetic-owned-reference-v1";
	const rights = { approvalId: `synthetic-rights-${randomUUID()}`, validUntil: expiry };
	await db.user.create({
		data: {
			id: referenceOwnerId,
			name: "Isolated reference test admin",
			email: `${referenceOwnerId}@example.invalid`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
			role: "admin",
		},
	});
	const account = await db.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{ accountId: account.id, amount: 100n, referenceKey: `grant:${ownerId}` },
		db,
	);
	// These are synthetic backend evidence records; no provider or storage is contacted.
	const rawEnvelope = {
		requestId: taskId,
		models: ["video-nsfw-filter"],
		complete: true,
		objectEtag: etag,
		seeapiConfirmationEventId: `synthetic-confirmation-${randomUUID()}`,
		visualSafetyProfile: visualProfile,
		audioSafetyPolicy: { schemaVersion: 1, mode: "not_requested" },
		video: {
			complete: true,
			durationMillis: 5000,
			frameCount: 8,
			firstFrameSeconds: 0,
			lastFrameSeconds: 4.8,
		},
		seeapiVideo: {
			taskId,
			model: "video-nsfw-filter",
			scope: "sampled_frames",
			samplingComplete: true,
			requestedFrames: 8,
			checkedFrames: 8,
			timestampSource: "frame_index_div_fps_estimate",
			reportSchemaVersion: 5,
			thresholdOffset: 0,
			strictSpecialCare: true,
			returnFrames: "none",
			flagged: false,
			flaggedFrameCount: 0,
			nsfw: [],
			specialCareReportedFrames: 0,
			maxFrameGapSeconds: 0.8,
		},
		rumpelstiltskinReferenceApproval: {
			version,
			fps: 30,
			audioTrackCount: 0,
			...(options.missingRightsEvidence ? {} : { rights }),
		},
	};
	const motion = await db.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId: referenceOwnerId,
			kind: "OUTPUT",
			status: "VERIFYING",
			objectKey: `users/${referenceOwnerId}/references/${randomUUID()}.mp4`,
			checksum: "a".repeat(64),
			storageEtag: etag,
			storageVersionId: `synthetic-version-${randomUUID()}`,
			byteSize: 1000n,
			mimeType: "video/mp4",
			durationMillis: 5000n,
			width: 720,
			height: 1280,
			finalizedAt: new Date(),
			verificationEngine: "video-workflow-v1",
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "seeapi",
			verificationProviderTaskId: taskId,
			verificationRuleVersion: visualProfile.ruleVersion,
			verificationPolicyVersion: visualProfile.policyVersion,
			verificationValidUntil: expiresAt,
		},
	});
	await db.assetModerationResult.create({
		data: {
			assetId: motion.id,
			assetChecksum: motion.checksum,
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: "OUTPUT",
			provider: "seeapi",
			providerTaskId: taskId,
			ruleVersion: visualProfile.ruleVersion,
			policyVersion: visualProfile.policyVersion,
			status: "APPROVED",
			reasonCode: "SYNTHETIC_TEST_REFERENCE_ALLOWED",
			categories: {},
			rawEnvelope,
			validUntil: expiresAt,
		},
	});
	// Exercise the existing READY guard rather than inserting a pre-approved asset.
	await db.mediaAsset.update({ where: { id: motion.id }, data: { status: "READY" } });
	const subject = await db.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			verificationEngine: "video-workflow-v1",
			objectKey: `users/${ownerId}/${randomUUID()}.template-source.template-input.png`,
			mimeType: "image/png",
			byteSize: 1000n,
			width: 720,
			height: 1280,
			checksum: "b".repeat(64),
			storageEtag: `synthetic-subject-etag-${randomUUID()}`,
			verificationGeneration: 1,
			finalizedAt: new Date(),
		},
	});
	const manifest = {
		assetId: motion.id,
		ownerId: options.wrongReferenceOwner ? ownerId : referenceOwnerId,
		objectKey: motion.objectKey,
		sha256: motion.checksum,
		etag: motion.storageEtag,
		storageVersionId: motion.storageVersionId,
		bytes: Number(motion.byteSize),
		mimeType: "video/mp4",
		durationSeconds: 5,
		width: 720,
		height: 1280,
		fps: 30,
		audioTrackCount: 0,
		version,
		review: {
			decision: "ALLOW",
			policyVersion: visualProfile.policyVersion,
			decisionHash: fingerprintVideoTemplateReferenceApproval(rawEnvelope),
			verificationGeneration: 1,
			validUntil: expiry,
		},
		rights,
	};
	const request = {
		effectId: "rumpelstiltskin-solo" as const,
		presetKey: "standard" as const,
		inputs: { leftAssetId: subject.id, rightAssetId: subject.id },
	};
	const template = createVideoEffectTemplateSnapshot(request, {
		RUMPELSTILTSKIN_APPROVED_MOTION_REFERENCE: JSON.stringify(manifest),
	});
	if (template.schemaVersion !== 2) throw new Error("REFERENCE_TEMPLATE_FIXTURE_REQUIRED");
	const base = {
		ownerId,
		request,
		template,
		price: {
			credits: 7n,
			providerCostMicros: 107500n,
			moderationCostMicros: 10000n,
			pricingBasis: "ISOLATED_TEST_NOT_FORMAL",
			pricingVersion: "REFERENCE_TEST_V1",
			pricingDetails: { validUntil: expiry },
		},
		visualSafetyProfile: visualProfile,
		textSafetyProfile: textProfile,
		audioSafetyPolicy: createVideoAudioSafetyPolicy(),
	};
	return { ownerId, subject, motion, account, base, expiry };
}

async function admitted() {
	const f = await fixture();
	const quote = await createVideoTemplateQuoteRecord(
		{ ...f.base, maximumInputBytes: 10_000_000 },
		db,
	);
	const input = {
		...f.base,
		quoteId: quote.quoteId,
		idempotencyKey: randomUUID(),
		limits: {
			ownerConcurrency: 50,
			globalConcurrency: 10000,
			providerConcurrency: 10000,
			maximumStorageBytes: 1_000_000_000n,
			maximumInputBytes: 10_000_000,
		},
	};
	const job = await createVideoTemplateJobRecord(input, db);
	return { ...f, quote, input, jobId: job.jobId };
}

async function reviewSubject(f: Awaited<ReturnType<typeof admitted>>) {
	const execution = await run(() => getVideoTemplateExecution(f.jobId));
	if (!execution) throw new Error("REFERENCE_TEST_EXECUTION_REQUIRED");
	const fingerprint = object(execution.job.inputSnapshot).requestFingerprint;
	const leftIdentity = object((execution.orderedRoleIdentities as Prisma.JsonArray)[0]);
	expect(await run(() => claimVideoTemplateImageReview(f.jobId, "left"))).toBe(true);
	await run(() =>
		recordVideoTemplateImageReview(f.jobId, "left", {
			...leftIdentity,
			decision: { decision: "ALLOW", reasonCode: "IMAGE_ALLOWED" },
			taskId: `synthetic-subject-review-${randomUUID()}`,
			ruleVersion: "video-safety-2026-10-04.1",
			safetyPolicyVersion: f.base.template.safetyPolicyVersion,
			validUntil: f.expiry,
		}),
	);
	const reviewed = await run(() => getVideoTemplateExecution(f.jobId));
	// Both roles refer to the same image, so reuse the single immutable receipt.
	await run(() =>
		recordVideoTemplateImageReview(f.jobId, "right", object(object(reviewed!.inputReview).left)),
	);
	expect(await run(() => claimVideoTemplateImageReview(f.jobId, "right"))).toBe(false);
	const requestId = `synthetic-waffo-${randomUUID()}`;
	await run(() =>
		recordVideoTemplateReview(f.jobId, "inputs", {
			status: "ALLOW",
			requestFingerprint: fingerprint,
			textSafetyProfile: textProfile,
			motionTextDecision: {
				decision: "ALLOW",
				reasonCode: "WAFFO_PROMPT_ALLOWED",
				ruleVersion: textProfile.ruleVersion,
				evidence: {
					requestId,
					models: ["waffo-prompt-sift"],
					operations: 1,
					waffo: { requestId, action: "allow", semanticStatus: "scored", matchedCategories: [] },
				},
			},
			motionTextDecisionIdentity: {
				requestFingerprint: fingerprint,
				promptVersion: f.base.template.video.promptVersion,
				promptHash: createHash("sha256").update(f.base.template.video.prompt).digest("hex"),
			},
		}),
	);
}

describe("Rumpelstiltskin reference template PostgreSQL binding", () => {
	it("admits one private subject, copies one review and resolves without creating a scene", async () => {
		const definitions = await db.$queryRaw<Array<{ definition: string }>>`
			SELECT pg_get_functiondef(p.oid) AS definition
			FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
			WHERE n.nspname='public' AND p.proname='guard_video_template_sealed_asset'`;
		expect(definitions[0]?.definition).toContain("approvedMotionReference");
		const f = await admitted();
		expect((await createVideoTemplateJobRecord(f.input, db)).jobId).toBe(f.jobId);
		expect(await db.videoExecution.count({ where: { jobId: f.jobId } })).toBe(1);
		expect(await db.outboxEvent.count({ where: { aggregateId: f.jobId } })).toBe(0);
		const bindings = await db.generationJobAsset.findMany({ where: { jobId: f.jobId } });
		expect(bindings.map((binding) => [binding.role, binding.assetId])).toEqual([
			["INPUT", f.subject.id],
		]);
		expect(await db.generationJobAsset.count({ where: { assetId: f.motion.id } })).toBe(0);
		expect(
			await db.storageUsageReservation.count({ where: { ownerId: f.ownerId, status: "ACTIVE" } }),
		).toBe(1);
		expect(
			(await db.creditAccount.findUniqueOrThrow({ where: { id: f.account.id } })).reservedCredits,
		).toBe(7n);
		await reviewSubject(f);
		const resolved = await run(() => finalizeVideoTemplateReferenceInput(f.jobId));
		expect(object(resolved)).toMatchObject({ source: "subject-reference", assetId: f.subject.id });
		expect(await run(() => finalizeVideoTemplateReferenceInput(f.jobId))).toEqual(resolved);
		const execution = await run(() => getVideoTemplateExecution(f.jobId));
		expect(execution).toMatchObject({ sceneState: "READY", sceneAssetId: null, submittedAt: null });
		expect(object(execution!.inputReview).sceneTextDecision).toBeUndefined();
		expect(object(execution!.inputReview).right).toEqual(object(execution!.inputReview).left);
		expect(
			await db.assetModerationResult.count({
				where: { assetId: f.subject.id, evidenceKind: "INPUT" },
			}),
		).toBe(1);
		expect(await db.mediaAsset.count({ where: { ownerId: f.ownerId } })).toBe(1);
		expect(
			getVideoEffectiveInputSnapshot({ ...execution!.job, videoTemplateExecution: execution }),
		).toMatchObject({
			inputAssetId: f.subject.id,
			inputIdentity: { source: "subject-reference", assetId: f.subject.id },
		});
	});

	it("rejects unreviewed subject resolution at the SQL trigger", async () => {
		const f = await admitted();
		await expect(
			db.videoTemplateExecution.update({
				where: { jobId: f.jobId },
				data: {
					sceneState: "READY",
					resolvedAt: new Date(),
					resolvedInputIdentity: {
						source: "subject-reference",
						assetId: f.subject.id,
						sourceReviewEvidence: {},
					},
				},
			}),
		).rejects.toThrow(/Reference input must bind its private reviewed subject/);
		expect(
			(await db.videoTemplateExecution.findUniqueOrThrow({ where: { jobId: f.jobId } }))
				.resolvedInputIdentity,
		).toBeNull();
	});

	it("freezes subject, motion bytes and parsed input identity in PostgreSQL", async () => {
		const f = await admitted();
		await reviewSubject(f);
		await run(() => finalizeVideoTemplateReferenceInput(f.jobId));
		await expect(
			db.mediaAsset.update({
				where: { id: f.subject.id },
				data: { storageEtag: "changed-subject" },
			}),
		).rejects.toThrow(/immutable/);
		// A lifecycle change may prevent new claims, but must not unseal frozen content.
		await db.mediaAsset.update({ where: { id: f.motion.id }, data: { status: "VERIFYING" } });
		for (const data of [{ byteSize: 1001n }, { durationMillis: 6000n }, { width: 721 }]) {
			await expect(db.mediaAsset.update({ where: { id: f.motion.id }, data })).rejects.toThrow(
				/Resolved template asset content is immutable/,
			);
		}
		const execution = await db.videoTemplateExecution.findUniqueOrThrow({
			where: { jobId: f.jobId },
		});
		await expect(
			db.videoTemplateExecution.update({
				where: { jobId: f.jobId },
				data: {
					resolvedInputIdentity: {
						...object(execution.resolvedInputIdentity),
						checksum: "c".repeat(64),
					} as Prisma.InputJsonValue,
				},
			}),
		).rejects.toThrow(/Template execution content and paid identities are immutable/);
		expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: f.motion.id } })).byteSize).toBe(
			1000n,
		);
		expect(
			(await db.mediaAsset.findUniqueOrThrow({ where: { id: f.subject.id } })).storageEtag,
		).toBe(f.subject.storageEtag);
	});

	it.each([
		{ options: { wrongReferenceOwner: true }, error: "VIDEO_TEMPLATE_REFERENCE_IDENTITY_CHANGED" },
		{
			options: { missingRightsEvidence: true },
			error: "VIDEO_TEMPLATE_REFERENCE_APPROVAL_REQUIRED",
		},
	])("rejects quote before reserving credits: $error", async ({ options, error }) => {
		const f = await fixture(options);
		await expect(
			createVideoTemplateQuoteRecord({ ...f.base, maximumInputBytes: 10_000_000 }, db),
		).rejects.toThrow(error);
		expect(await db.generationQuote.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await db.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(
			(await db.creditAccount.findUniqueOrThrow({ where: { id: f.account.id } })).reservedCredits,
		).toBe(0n);
	});
});
