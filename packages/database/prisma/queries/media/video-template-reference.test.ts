import { createHash } from "node:crypto";

import { createVideoEffectTemplateSnapshot } from "@repo/config/video-effects.server";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
	client: {} as unknown,
	settle: vi.fn(),
	release: vi.fn(),
}));
vi.mock("../../client", () => ({ getDatabaseClient: () => mocked.client }));
vi.mock("./credits", () => ({
	settleCreditsInTransaction: mocked.settle,
	releaseCreditsInTransaction: mocked.release,
	reserveCreditsInTransaction: vi.fn(),
}));

import type { Prisma } from "../../generated/client";
import type { MediaDatabaseClient } from "./types";
import { templateAdmissionData } from "./video-template-admission";
import {
	finalizeVideoTemplateReferenceInput,
	getVideoEffectiveInputSnapshot,
} from "./video-template-execution";
import {
	findApprovedVideoTemplateMotionReference,
	fingerprintVideoTemplateReferenceApproval,
} from "./video-template-reference";
import { videoTemplateSceneReservationBytes } from "./video-template-storage";
import { claimVideoProviderSubmission, recordVideoSubmissionAccepted } from "./video-v1-execution";
import { finalizeVideoDelivery } from "./video-v1-fulfillment";

function fixture() {
	const expiry = "2026-10-07T15:00:00.000Z";
	const visualProfile = createVideoVisualSafetyProfile("seeapi", 5);
	const textProfile = createVideoTextSafetyProfile();
	const rawEnvelope = {
		requestId: "reference-review",
		models: ["video-nsfw-filter"],
		complete: true,
		objectEtag: "reference-etag",
		seeapiConfirmationEventId: "reference-confirmation",
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
			taskId: "reference-review",
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
			version: "owned-reference-v1",
			fps: 30,
			audioTrackCount: 0,
			rights: { approvalId: "owned-test-receipt", validUntil: expiry },
		},
	};
	const reference = {
		assetId: "private-admin-reference",
		ownerId: "reference-admin",
		objectKey: "users/reference-admin/references/owned-v1.mp4",
		sha256: "a".repeat(64),
		etag: "reference-etag",
		storageVersionId: "reference-version",
		bytes: 1000,
		mimeType: "video/mp4" as const,
		durationSeconds: 5,
		width: 720,
		height: 1280,
		fps: 30,
		audioTrackCount: 0 as const,
		version: "owned-reference-v1",
		review: {
			decision: "ALLOW" as const,
			policyVersion: visualProfile.policyVersion,
			decisionHash: fingerprintVideoTemplateReferenceApproval(rawEnvelope),
			verificationGeneration: 1,
			validUntil: expiry,
		},
		rights: { approvalId: "owned-test-receipt", validUntil: expiry },
	};
	const request = {
		effectId: "rumpelstiltskin-solo" as const,
		presetKey: "standard" as const,
		inputs: { leftAssetId: "private-subject", rightAssetId: "private-subject" },
	};
	const template = createVideoEffectTemplateSnapshot(request, {
		RUMPELSTILTSKIN_APPROVED_MOTION_REFERENCE: JSON.stringify(reference),
	});
	const referenceAsset = {
		id: reference.assetId,
		ownerType: "USER",
		ownerId: reference.ownerId,
		kind: "OUTPUT",
		status: "READY",
		finalizedAt: new Date(),
		deletedAt: null,
		deleteAfter: null,
		objectKey: reference.objectKey,
		checksum: reference.sha256,
		storageEtag: reference.etag,
		storageVersionId: reference.storageVersionId,
		byteSize: BigInt(reference.bytes),
		mimeType: reference.mimeType,
		durationMillis: 5000n,
		width: 720,
		height: 1280,
		verificationEngine: "video-workflow-v1",
		verificationGeneration: 1,
		verificationAttemptCount: 1,
		verificationProvider: "seeapi",
		verificationProviderTaskId: "reference-review",
		verificationRuleVersion: visualProfile.ruleVersion,
		verificationPolicyVersion: visualProfile.policyVersion,
		verificationValidUntil: new Date(expiry),
	};
	const evidence = {
		assetId: reference.assetId,
		assetChecksum: reference.sha256,
		verificationGeneration: 1,
		attemptNumber: 1,
		evidenceKind: "OUTPUT",
		provider: "seeapi",
		providerTaskId: "reference-review",
		ruleVersion: visualProfile.ruleVersion,
		policyVersion: visualProfile.policyVersion,
		status: "APPROVED",
		rawEnvelope,
		validUntil: new Date(expiry),
	};
	const subject = {
		...referenceAsset,
		id: "private-subject",
		ownerId: "subject-owner",
		kind: "INPUT",
		status: "VERIFYING",
		objectKey: "users/subject-owner/subject.template-source.template-input.png",
		mimeType: "image/png",
		checksum: "b".repeat(64),
		storageEtag: "subject-etag",
		storageVersionId: null,
		verificationAttemptCount: 0,
	};
	const identity = {
		assetId: subject.id,
		checksum: subject.checksum,
		objectKey: subject.objectKey,
		storageEtag: subject.storageEtag,
		storageVersionId: subject.storageVersionId,
		verificationGeneration: 1,
	};
	const imageReview = {
		...identity,
		decision: { decision: "ALLOW", reasonCode: "IMAGE_ALLOWED" },
		ruleVersion: "video-safety-2026-10-04.1",
		safetyPolicyVersion: template.safetyPolicyVersion,
		validUntil: expiry,
		taskId: "subject-review",
	};
	const promptReview = {
		decision: "ALLOW",
		reasonCode: "WAFFO_PROMPT_ALLOWED",
		ruleVersion: textProfile.ruleVersion,
		evidence: {
			requestId: "text-review",
			models: ["waffo-prompt-sift"],
			operations: 1,
			waffo: {
				requestId: "text-review",
				action: "allow",
				semanticStatus: "scored",
				matchedCategories: [],
			},
		},
	};
	const inputReview = {
		status: "ALLOW",
		requestFingerprint: "frozen-request",
		textSafetyProfile: textProfile,
		left: imageReview,
		right: structuredClone(imageReview),
		motionTextDecision: promptReview,
		motionTextDecisionIdentity: {
			requestFingerprint: "frozen-request",
			promptVersion: template.video.promptVersion,
			promptHash: createHash("sha256").update(template.video.prompt).digest("hex"),
		},
	};
	const execution = {
		jobId: "reference-job",
		templateSnapshot: template,
		orderedRoleIdentities: [
			{ ...identity, role: "left" },
			{ ...identity, role: "right" },
		],
		inputReview,
		sceneState: "PENDING",
		sceneSubmissionUncertain: false,
		resolvedInputIdentity: null as unknown,
		sceneAssetId: null,
		sceneAsset: null,
		submittedAt: null,
		stageData: {},
	};
	const job = {
		id: "reference-job",
		ownerType: "USER",
		ownerId: "subject-owner",
		executionEngine: "video-workflow-v1",
		status: "RESERVED",
		creditsReserved: 7n,
		failureCode: null,
		updatedAt: new Date(),
		inputSnapshot: {
			duration: 5,
			resolution: "720p",
			aspectRatio: "9:16",
			sound: false,
			productKey: "video-seedance-2",
			mode: "image-to-video",
			textSafetyProfile: textProfile,
			visualSafetyProfile: visualProfile,
			audioSafetyPolicy: { schemaVersion: 1, mode: "not_requested" },
			videoEffectTemplate: template,
			roleInputIdentities: execution.orderedRoleIdentities,
			requestFingerprint: "frozen-request",
			inputIdentity: identity,
		},
		pricingSnapshot: { pricingDetails: { validUntil: expiry } },
		videoTemplateExecution: execution,
		videoExecution: {
			stage: "QUEUED",
			stateVersion: 1,
			stageData: {} as Record<string, unknown>,
		},
		reservation: { id: "credit-reservation", status: "ACTIVE" },
		attempts: [] as Array<Record<string, unknown>>,
		assets: [
			{ role: "INPUT", assetId: subject.id, assetChecksum: subject.checksum, asset: subject },
		],
	};
	const tx = {
		$executeRaw: vi.fn(async () => 1),
		$queryRaw: vi.fn(async () => [{ now: new Date() }]),
		user: { findFirst: vi.fn(async () => ({ id: reference.ownerId })) },
		mediaAsset: {
			findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
				where.id === reference.assetId ? referenceAsset : subject,
			),
			update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
				Object.assign(subject, data),
			),
		},
		assetModerationResult: {
			findFirst: vi.fn(async () => evidence),
			create: vi.fn(async () => ({})),
		},
		videoTemplateExecution: {
			findUnique: vi.fn(async () => ({ ...execution, job })),
			update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
				Object.assign(execution, data),
			),
		},
		generationJob: {
			findFirst: vi.fn(async () => job),
			findUnique: vi.fn(async () => job),
			update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
				Object.assign(job, data),
			),
		},
		generationAttempt: {
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				const attempt = { id: "paid-attempt", ...data };
				job.attempts = [attempt];
				return attempt;
			}),
			update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
				Object.assign(job.attempts[0]!, data),
			),
		},
		videoExecution: {
			update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
				Object.assign(job.videoExecution, data),
			),
		},
		storageUsageReservation: { findFirst: vi.fn(async () => ({ bytes: 104857600n })) },
		generationJobAsset: { findMany: vi.fn(async () => []) },
		auditLog: { createMany: vi.fn(async () => ({ count: 1 })) },
	};
	mocked.client = {
		$transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
	};
	return {
		template,
		reference,
		referenceAsset,
		evidence,
		request,
		tx,
		subject,
		job,
		execution,
		inputReview,
		visualProfile,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-07T14:00:00Z"));
	mocked.settle.mockReset();
	mocked.release.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("private approved motion reference binding", () => {
	it("requires the actual admin asset and complete persisted approval; the user binds only their subject", async () => {
		const f = fixture();
		await expect(
			findApprovedVideoTemplateMotionReference(
				f.template,
				f.tx as unknown as MediaDatabaseClient,
				new Date(),
			),
		).resolves.toBe(f.referenceAsset);
		const snapshot = await templateAdmissionData(
			"subject-owner",
			{ request: f.request, template: f.template },
			10000000,
			f.tx as unknown as MediaDatabaseClient,
			new Date(),
		);
		expect(snapshot.roleInputIdentities.map((value) => value.assetId)).toEqual([
			f.subject.id,
			f.subject.id,
		]);
		expect(JSON.stringify(snapshot.roleInputIdentities)).not.toContain(f.reference.assetId);
		expect(
			videoTemplateSceneReservationBytes({
				videoEffectTemplate: f.template,
			} as unknown as Prisma.JsonValue),
		).toBe(0n);
	});
	it.each([
		["checksum", "c".repeat(64)],
		["storageEtag", "changed"],
		["storageVersionId", "changed"],
		["objectKey", "users/reference-admin/different.mp4"],
		["ownerId", "other-owner"],
		["byteSize", 2000n],
		["durationMillis", 6000n],
		["width", 640],
		["verificationGeneration", 2],
		["status", "QUARANTINED"],
		["verificationPolicyVersion", "unapproved-policy"],
	])("rejects changed %s before an external call", async (field, changed) => {
		const f = fixture();
		Object.assign(f.referenceAsset, { [field]: changed });
		await expect(
			findApprovedVideoTemplateMotionReference(
				f.template,
				f.tx as unknown as MediaDatabaseClient,
				new Date(),
			),
		).rejects.toThrow("VIDEO_TEMPLATE_REFERENCE_IDENTITY_CHANGED");
	});
	it("does not accept a manifest hash without complete sampled-frame approval", async () => {
		const f = fixture();
		f.evidence.rawEnvelope.seeapiVideo.samplingComplete = false;
		if (f.template.schemaVersion === 2)
			f.template.approvedMotionReference.review.decisionHash =
				fingerprintVideoTemplateReferenceApproval(f.evidence.rawEnvelope);
		await expect(
			findApprovedVideoTemplateMotionReference(
				f.template,
				f.tx as unknown as MediaDatabaseClient,
				new Date(),
			),
		).rejects.toThrow("VIDEO_TEMPLATE_REFERENCE_APPROVAL_REQUIRED");
	});
	it("rejects substituted rights even if the envelope hash is recomputed", async () => {
		const f = fixture();
		f.evidence.rawEnvelope.rumpelstiltskinReferenceApproval.rights.approvalId = "different-rights";
		if (f.template.schemaVersion === 2)
			f.template.approvedMotionReference.review.decisionHash =
				fingerprintVideoTemplateReferenceApproval(f.evidence.rawEnvelope);
		await expect(
			findApprovedVideoTemplateMotionReference(
				f.template,
				f.tx as unknown as MediaDatabaseClient,
				new Date(),
			),
		).rejects.toThrow("VIDEO_TEMPLATE_REFERENCE_APPROVAL_REQUIRED");
	});
	it("rejects a revoked administrator and expired rights", async () => {
		const f = fixture();
		f.tx.user.findFirst.mockResolvedValueOnce(null as never);
		await expect(
			findApprovedVideoTemplateMotionReference(
				f.template,
				f.tx as unknown as MediaDatabaseClient,
				new Date(),
			),
		).rejects.toThrow("VIDEO_TEMPLATE_REFERENCE_OWNER_NOT_AUTHORIZED");
		if (f.template.schemaVersion === 2)
			f.template.approvedMotionReference.rights.validUntil = "2026-10-07T13:00:00Z";
		await expect(
			findApprovedVideoTemplateMotionReference(
				f.template,
				f.tx as unknown as MediaDatabaseClient,
				new Date(),
			),
		).rejects.toThrow("VIDEO_TEMPLATE_REFERENCE_IDENTITY_CHANGED");
	});
});

describe("reviewed reference input and paid send fence", () => {
	it("seals the single private subject with review evidence and creates no scene", async () => {
		const f = fixture();
		const identity = await finalizeVideoTemplateReferenceInput(f.job.id);
		expect(identity).toMatchObject({
			source: "subject-reference",
			assetId: f.subject.id,
			checksum: f.subject.checksum,
		});
		expect(f.execution.sceneAssetId).toBeNull();
		expect(f.execution.sceneState).toBe("READY");
		expect(f.tx.assetModerationResult.create).toHaveBeenCalledOnce();
		const snapshot = getVideoEffectiveInputSnapshot(
			f.job as unknown as Parameters<typeof getVideoEffectiveInputSnapshot>[0],
		);
		expect(snapshot.inputIdentity).toEqual(identity);
		await expect(finalizeVideoTemplateReferenceInput(f.job.id)).resolves.toEqual(identity);
		expect(f.tx.assetModerationResult.create).toHaveBeenCalledOnce();
	});
	it.each(["motionHash", "rightChecksum", "expiredSubject"])(
		"cannot seal a subject with %s",
		async (change) => {
			const f = fixture();
			if (change === "motionHash")
				f.inputReview.motionTextDecisionIdentity.promptHash = "d".repeat(64);
			if (change === "rightChecksum") f.inputReview.right.checksum = "d".repeat(64);
			if (change === "expiredSubject") f.inputReview.left.validUntil = "2026-10-07T13:00:00Z";
			await expect(finalizeVideoTemplateReferenceInput(f.job.id)).rejects.toThrow(
				"VIDEO_TEMPLATE_REFERENCE_INPUT_REVIEW_REQUIRED",
			);
			expect(f.tx.assetModerationResult.create).not.toHaveBeenCalled();
		},
	);
	it.each(["expiry", "deletion"])(
		"rechecks first submit but records accepted facts and settles after reference %s",
		async (change) => {
			const f = fixture();
			await finalizeVideoTemplateReferenceInput(f.job.id);
			f.job.videoExecution.stageData = {
				inputReview: {
					status: "ALLOW",
					ruleVersion: "video-rule",
					requestFingerprint: "frozen-request",
					validUntil: "2026-10-08T00:00:00Z",
					textSafetyProfile: f.inputReview.textSafetyProfile,
					textDecision: f.inputReview.motionTextDecision,
				},
			};
			const input = {
				jobId: f.job.id,
				callbackTokenHash: "token-hash",
				providerModelId: "seedance2",
				ruleVersion: "video-rule",
			};
			const claimed = await claimVideoProviderSubmission(input);
			expect(claimed.claimed).toBe(true);
			const output = {
				...f.referenceAsset,
				id: "private-output",
				ownerId: f.job.ownerId,
				status: "VERIFYING",
				verificationValidUntil: new Date("2026-10-08T00:00:00Z"),
				moderationResults: [{ ...f.evidence, validUntil: new Date("2026-10-08T00:00:00Z") }],
			};
			vi.setSystemTime(new Date("2026-10-07T16:00:00Z"));
			if (change === "deletion")
				Object.assign(f.referenceAsset, { deletedAt: new Date(), status: "DELETED" });
			f.tx.mediaAsset.findFirst.mockClear();
			await expect(claimVideoProviderSubmission(input)).resolves.toMatchObject({ claimed: false });
			await recordVideoSubmissionAccepted(f.job.id, "paid-attempt", "provider-task");
			expect(f.tx.mediaAsset.findFirst).not.toHaveBeenCalled();
			f.job.assets = [
				{ role: "OUTPUT", assetId: output.id, assetChecksum: output.checksum, asset: output },
			] as never;
			f.job.status = "FINALIZING";
			f.job.videoExecution.stage = "FINALIZING";
			f.job.videoExecution.stageData = {
				outputSpec: {
					audioTracks: 0,
					audioTrackIds: [],
					checksum: output.checksum,
					etag: output.storageEtag,
				},
			};
			mocked.settle.mockImplementation(async () => {
				f.job.reservation.status = "SETTLED";
			});
			const result = await finalizeVideoDelivery(f.job.id, {
				assetId: output.id,
				checksum: output.checksum,
				etag: output.storageEtag,
				checkedAt: new Date(),
			});
			expect(result).toMatchObject({ stage: "READY", creditState: "SETTLED", canPlay: true });
			expect(mocked.settle).toHaveBeenCalledOnce();
			expect(f.tx.mediaAsset.findFirst).not.toHaveBeenCalled();
		},
	);
	it("does not create a paid attempt when approval expires while queued", async () => {
		const f = fixture();
		f.inputReview.left.validUntil = "2026-10-08T00:00:00Z";
		f.inputReview.right.validUntil = "2026-10-08T00:00:00Z";
		await finalizeVideoTemplateReferenceInput(f.job.id);
		f.job.videoExecution.stageData = {
			inputReview: {
				status: "ALLOW",
				ruleVersion: "video-rule",
				requestFingerprint: "frozen-request",
				validUntil: "2026-10-08T00:00:00Z",
				textSafetyProfile: f.inputReview.textSafetyProfile,
				textDecision: f.inputReview.motionTextDecision,
			},
		};
		vi.setSystemTime(new Date("2026-10-07T16:00:00Z"));
		await expect(finalizeVideoTemplateReferenceInput(f.job.id)).resolves.toBeTruthy();
		await expect(
			claimVideoProviderSubmission({
				jobId: f.job.id,
				callbackTokenHash: "token-hash",
				providerModelId: "seedance2",
				ruleVersion: "video-rule",
			}),
		).rejects.toThrow("VIDEO_TEMPLATE_REFERENCE_IDENTITY_CHANGED");
		expect(f.tx.generationAttempt.create).not.toHaveBeenCalled();
	});
});
