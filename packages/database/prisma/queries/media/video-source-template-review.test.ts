import { createSourceTemplateNoPromptReview } from "@repo/config/video-template-execution.server";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { VIDEO_V1_RULE_VERSION } from "@repo/config/video-v1";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sourceHotelTemplateFixture } from "../../../../config/test-support/source-hotel-template";

const mocked = vi.hoisted(() => ({ client: {} as unknown }));
vi.mock("../../client", () => ({ getDatabaseClient: () => mocked.client }));
vi.mock("./video-v1-storage", () => ({
	lockVideoOwnerStorage: vi.fn(),
	releaseVideoPreOutputCapacity: vi.fn(),
	videoOutputReservationBytes: () => 100n,
	videoOutputReservationKey: () => "output-job",
}));

import type { Prisma } from "../../generated/client";
import {
	assertSourceTemplateInputIdentities,
	assertSourceTemplateInputReview,
	claimSourceTemplateImageReview,
	findApprovedSourceTemplateReferences,
	recordSourceTemplateImageReview,
	recordSourceTemplateInputReview,
} from "./video-source-template-review";
import { claimVideoProviderSubmission } from "./video-v1-execution";

const now = new Date("2026-11-06T00:00:00.000Z");
const profile = createVideoTextSafetyProfile();
const textDecision = {
	decision: "ALLOW",
	reasonCode: "WAFFO_PROMPT_ALLOWED",
	ruleVersion: profile.ruleVersion,
	evidence: {
		requestId: "text-1",
		models: ["waffo-prompt-sift"],
		operations: 1,
		scores: {},
		waffo: {
			requestId: "text-1",
			action: "allow",
			semanticStatus: "scored",
			matchedCategories: [],
		},
	},
};
function imageDecision(taskId: string, result = "ALLOW") {
	return {
		decision: result,
		reasonCode: result === "REVIEW" ? "IMAGE_PROCESSING" : "SAFE",
		ruleVersion: VIDEO_V1_RULE_VERSION,
		evidence: {
			requestId: taskId,
			models: ["nsfw-filter-2"],
			operations: 1,
			scores: {},
			seeapi: { taskId, flagged: false, nsfw: [], specialCare: [] },
		},
	};
}
function fixture(count = 2) {
	const identities = Array.from({ length: count }, (_, index) => ({
		role: `performer-${index + 1}`,
		assetId: `input-${index + 1}`,
		checksum: String(index + 1).repeat(64),
		objectKey: `user/input-${index + 1}.png`,
		storageEtag: `etag-${index + 1}`,
		storageVersionId: null,
		verificationGeneration: 1,
	}));
	const template = {
		templateKey: "original-rap",
		version: "source-v1",
		provision: { id: "source-config", version: 1 },
		request: {
			templateKey: "original-rap",
			options: {},
			inputs: identities.map(({ role, assetId }) => ({ role, assetId })),
		},
		transport: {
			provider: "seeapi",
			modelId: "source-exact-model",
			endpoint: "source-endpoint",
			body: {},
			revision: "source-revision",
			prompt: "original source prompt",
			requiredAssetUrls: [],
			output: { durationSeconds: 10, resolution: "720p", aspectRatio: "9:16", sound: true },
		},
		references: [] as Array<Record<string, unknown>>,
	};
	const snapshot = {
		requestKind: "source-template-video",
		sourceTemplate: template,
		productKey: "source-template:original-rap",
		mode: count ? "image-to-video" : "text-to-video",
		prompt: template.transport.prompt,
		...(count ? { inputAssetId: identities[0]!.assetId } : {}),
		duration: 10,
		resolution: "720p",
		aspectRatio: "9:16",
		sound: true,
		roleInputIdentities: identities,
		inputIdentity: identities[0]
			? Object.fromEntries(Object.entries(identities[0]).filter(([key]) => key !== "role"))
			: null,
		requestFingerprint: "frozen-request",
		textSafetyProfile: profile,
	};
	const job = {
		id: "job",
		ownerType: "USER",
		ownerId: "user",
		inputSnapshot: snapshot,
		pricingSnapshot: {},
		videoExecution: {
			stage: "QUEUED",
			stageData: {} as Record<string, any>,
			inputReviewStartedAt: null,
		},
		videoTemplateExecution: null,
		attempts: [] as Array<Record<string, unknown>>,
		assets: identities.map((identity) => ({
			role: "INPUT",
			assetId: identity.assetId,
			assetChecksum: identity.checksum,
			asset: {
				...identity,
				id: identity.assetId,
				ownerType: "USER",
				ownerId: "user",
				kind: "INPUT",
				status: "VERIFYING",
				deletedAt: null,
				finalizedAt: now,
				deleteAfter: null,
			},
		})),
	};
	const tx = {
		$executeRaw: vi.fn(async () => 1),
		$queryRaw: vi.fn(async () => [{ now }]),
		generationJob: { findFirst: vi.fn(async () => job), update: vi.fn() },
		videoExecution: {
			update: vi.fn(async ({ data }: any) => {
				Object.assign(job.videoExecution, data);
				return job.videoExecution;
			}),
		},
		storageUsageReservation: { findFirst: vi.fn(async () => ({ status: "ACTIVE" })) },
		generationAttempt: {
			create: vi.fn(async ({ data }: any) => {
				const attempt = { id: "attempt", ...data };
				job.attempts.push(attempt);
				return attempt;
			}),
		},
		mediaAsset: { findFirst: vi.fn() },
		user: { findFirst: vi.fn(async () => ({ id: "admin" })) },
		assetModerationResult: { findFirst: vi.fn() },
	};
	mocked.client = {
		...tx,
		$transaction: (operation: (client: typeof tx) => unknown) => operation(tx),
	};
	const metadata = {
		requestFingerprint: "frozen-request",
		ruleVersion: VIDEO_V1_RULE_VERSION,
		textSafetyProfile: profile,
		textDecision,
	};
	const allowRole = async (role: string) => {
		await claimSourceTemplateImageReview("job", role);
		await recordSourceTemplateImageReview("job", role, {
			taskId: `task-${role}`,
			submissionUncertain: false,
		});
		await recordSourceTemplateImageReview("job", role, { decision: imageDecision(`task-${role}`) });
	};
	return { tx, job, snapshot, template, identities, metadata, allowRole };
}

describe("source template durable role review", () => {
	it("reviews customer inputs and claims once without rechecking published built-in material rows", async () => {
		const f = fixture(1);
		f.template.references.push({
			assetId: "published-reference",
			checksum: "a".repeat(64),
			objectKey: "users/admin/source-templates/fixed-version",
			storageEtag: "fixed-etag",
			storageVersionId: null,
			verificationGeneration: 1,
			ownerId: "admin",
			sourceUrl: "https://ezpic-template.example/scene",
			rightsEvidence: "release-receipt",
			validUntil: "2020-01-01T00:00:00.000Z",
		});
		await recordSourceTemplateInputReview("job", f.metadata);
		await f.allowRole("performer-1");
		await recordSourceTemplateInputReview("job", { status: "ALLOW" });
		const input = {
			jobId: "job",
			providerModelId: "source-exact-model",
			callbackTokenHash: "hash",
			ruleVersion: VIDEO_V1_RULE_VERSION,
		};
		expect(await claimVideoProviderSubmission(input)).toMatchObject({ claimed: true });
		expect(await claimVideoProviderSubmission(input)).toMatchObject({ claimed: false });
		expect(f.tx.mediaAsset.findFirst).not.toHaveBeenCalled();
		expect(f.tx.assetModerationResult.findFirst).not.toHaveBeenCalled();
		expect(f.tx.user.findFirst).not.toHaveBeenCalled();
	});
	it("requires both Hotel role approvals and exact no-prompt proof before one provider claim", async () => {
		const f = fixture(2);
		Object.assign(f.snapshot, sourceHotelTemplateFixture());
		const { textDecision: _unused, ...metadata } = f.metadata;
		await recordSourceTemplateInputReview("job", {
			...metadata,
			textReviewNotApplicable: createSourceTemplateNoPromptReview(f.snapshot),
		});
		await f.allowRole("performer-1");
		await expect(recordSourceTemplateInputReview("job", { status: "ALLOW" })).rejects.toThrow(
			"VIDEO_INPUT_REVIEW_REQUIRED",
		);
		await f.allowRole("performer-2");
		expect(await recordSourceTemplateInputReview("job", { status: "ALLOW" })).toBe(true);
		const review = f.job.videoExecution.stageData.inputReview;
		expect(() =>
			assertSourceTemplateInputReview(f.snapshot, { ...review, textDecision }, now),
		).toThrow("VIDEO_INPUT_REVIEW_REQUIRED");
		expect(() =>
			assertSourceTemplateInputReview(
				f.snapshot,
				{
					...review,
					textReviewNotApplicable: {
						...review.textReviewNotApplicable,
						requestFingerprint: "other",
					},
				},
				now,
			),
		).toThrow("VIDEO_INPUT_REVIEW_REQUIRED");
		const claim = await claimVideoProviderSubmission({
			jobId: "job",
			providerModelId: "hotel-lobby-ai",
			callbackTokenHash: "hash",
			ruleVersion: VIDEO_V1_RULE_VERSION,
		});
		expect(claim).toMatchObject({ claimed: true });
	});
	it("cannot apply a Hotel no-prompt proof to an ordinary source prompt", async () => {
		const f = fixture(2);
		await recordSourceTemplateInputReview("job", f.metadata);
		await f.allowRole("performer-1");
		await f.allowRole("performer-2");
		await recordSourceTemplateInputReview("job", { status: "ALLOW" });
		const proof = createSourceTemplateNoPromptReview({
			...sourceHotelTemplateFixture(),
			requestFingerprint: "frozen-request",
		});
		expect(() =>
			assertSourceTemplateInputReview(
				f.snapshot,
				{
					...f.job.videoExecution.stageData.inputReview,
					textDecision: undefined,
					textReviewNotApplicable: proof,
				},
				now,
			),
		).toThrow("VIDEO_INPUT_REVIEW_REQUIRED");
	});
	beforeEach(() => {
		vi.useRealTimers();
		vi.setSystemTime(now);
	});
	it("revalidates every role, including a changed second subject and role order", () => {
		const f = fixture();
		expect(assertSourceTemplateInputIdentities(f.job, now)).toHaveLength(2);
		f.job.assets[1]!.asset.ownerId = "another-user";
		expect(() => assertSourceTemplateInputIdentities(f.job, now)).toThrow(
			"VIDEO_INPUT_IDENTITY_CHANGED",
		);
		f.job.assets[1]!.asset.ownerId = "user";
		f.identities.reverse();
		expect(() => assertSourceTemplateInputIdentities(f.job, now)).toThrow(
			"VIDEO_SOURCE_TEMPLATE_IDENTITIES_INVALID",
		);
	});
	it("keeps an unknown review POST fenced across recovery", async () => {
		fixture();
		expect(await claimSourceTemplateImageReview("job", "performer-1")).toBe(true);
		expect(await claimSourceTemplateImageReview("job", "performer-1")).toBe(false);
		await expect(
			recordSourceTemplateImageReview("job", "performer-1", { submissionUncertain: false }),
		).rejects.toThrow("VIDEO_INPUT_REVIEW_IDENTITY_CHANGED");
	});
	it("requires every role approval and preserves original approval lifetime on stale PENDING/ALLOW", async () => {
		const f = fixture();
		await recordSourceTemplateInputReview("job", f.metadata);
		await f.allowRole("performer-1");
		await expect(recordSourceTemplateInputReview("job", { status: "ALLOW" })).rejects.toThrow(
			"VIDEO_INPUT_REVIEW_REQUIRED",
		);
		const first = structuredClone(f.job.videoExecution.stageData.inputReview.roles["performer-1"]);
		await recordSourceTemplateImageReview("job", "performer-1", {
			decision: imageDecision("task-performer-1", "REVIEW"),
		});
		expect(f.job.videoExecution.stageData.inputReview.roles["performer-1"]).toEqual(first);
		await f.allowRole("performer-2");
		await recordSourceTemplateInputReview("job", { status: "ALLOW" });
		expect(() =>
			assertSourceTemplateInputReview(f.snapshot, f.job.videoExecution.stageData.inputReview, now),
		).not.toThrow();
		expect(() =>
			assertSourceTemplateInputReview(
				f.snapshot,
				f.job.videoExecution.stageData.inputReview,
				new Date(now.getTime() + 3600_001),
			),
		).toThrow("VIDEO_INPUT_REVIEW_REQUIRED");
		await expect(
			recordSourceTemplateImageReview("job", "performer-1", { taskId: "other-task" }),
		).rejects.toThrow("VIDEO_INPUT_REVIEW_IDENTITY_CHANGED");
	});
	it("never promotes a static ALLOW flag without bound SeeAPI evidence", async () => {
		const f = fixture(1);
		await recordSourceTemplateInputReview("job", f.metadata);
		await claimSourceTemplateImageReview("job", "performer-1");
		await recordSourceTemplateImageReview("job", "performer-1", {
			taskId: "task",
			submissionUncertain: false,
			decision: { decision: "ALLOW", ruleVersion: VIDEO_V1_RULE_VERSION },
		});
		await expect(recordSourceTemplateInputReview("job", { status: "ALLOW" })).rejects.toThrow(
			"VIDEO_INPUT_REVIEW_REQUIRED",
		);
	});
	it("retains a rejection against a competing stale ALLOW", async () => {
		const f = fixture(1);
		await f.allowRole("performer-1");
		await recordSourceTemplateImageReview("job", "performer-1", {
			decision: imageDecision("task-performer-1", "REJECT"),
		});
		await recordSourceTemplateImageReview("job", "performer-1", {
			decision: imageDecision("task-performer-1"),
		});
		expect(f.job.videoExecution.stageData.inputReview.roles["performer-1"].decision.decision).toBe(
			"REJECT",
		);
	});
	it("supports source text-only rap without inventing image review", async () => {
		const f = fixture(0);
		await recordSourceTemplateInputReview("job", { ...f.metadata, status: "ALLOW" });
		expect(() =>
			assertSourceTemplateInputReview(f.snapshot, f.job.videoExecution.stageData.inputReview, now),
		).not.toThrow();
	});
	it("claims the frozen source provider once and rejects model substitution", async () => {
		const f = fixture();
		await recordSourceTemplateInputReview("job", f.metadata);
		await f.allowRole("performer-1");
		await f.allowRole("performer-2");
		await recordSourceTemplateInputReview("job", { status: "ALLOW" });
		const claim = {
			jobId: "job",
			callbackTokenHash: "hash",
			providerModelId: "source-exact-model",
			ruleVersion: VIDEO_V1_RULE_VERSION,
		};
		await expect(
			claimVideoProviderSubmission({ ...claim, providerModelId: "other-model" }),
		).rejects.toThrow("VIDEO_SOURCE_TEMPLATE_PROVIDER_CHANGED");
		expect(await claimVideoProviderSubmission(claim)).toMatchObject({
			claimed: true,
			attempt: { provider: "seeapi", status: "SUBMISSION_UNCERTAIN", uncertainSubmission: true },
		});
		expect(await claimVideoProviderSubmission(claim)).toMatchObject({ claimed: false });
		expect(f.tx.generationAttempt.create).toHaveBeenCalledOnce();
	});
	it("requires current administrator audio evidence bound to the exact source and rights", async () => {
		const f = fixture();
		const identity = {
			assetId: "audio",
			checksum: "a".repeat(64),
			objectKey: "admin/audio.mp3",
			storageEtag: "audio-etag",
			storageVersionId: null,
			verificationGeneration: 1,
		};
		const reference = {
			...identity,
			sourceUrl: "https://source.example/audio.mp3",
			ownerId: "admin",
			rightsEvidence: "rights-record",
			validUntil: "2026-11-07T00:00:00.000Z",
		};
		f.template.references.push(reference);
		const asset = {
			...identity,
			id: "audio",
			ownerType: "USER",
			ownerId: "admin",
			kind: "INPUT",
			mimeType: "audio/mpeg",
			status: "READY",
			finalizedAt: now,
			deletedAt: null,
			deleteAfter: null,
			verificationValidUntil: new Date(reference.validUntil),
			verificationPolicyVersion: "admin-audio-v1",
			verificationRuleVersion: "admin-audio-v1",
			verificationProvider: "administrator",
			verificationProviderTaskId: null,
			verificationAttemptCount: 1,
		};
		f.tx.mediaAsset.findFirst.mockResolvedValue(asset);
		const approval = {
			...identity,
			templateKey: f.template.templateKey,
			version: f.template.version,
			sourceUrl: reference.sourceUrl,
			rightsEvidence: reference.rightsEvidence,
			validUntil: reference.validUntil,
			decision: "ALLOW",
			reviewerId: "admin",
			reviewedAt: now.toISOString(),
			reviewKind: "administrator-audio",
		};
		const evidence = {
			validUntil: new Date(reference.validUntil),
			rawEnvelope: { sourceTemplateReferenceApproval: approval },
		};
		f.tx.assetModerationResult.findFirst.mockResolvedValue(evidence);
		expect(
			await findApprovedSourceTemplateReferences(
				f.template,
				f.tx as unknown as Prisma.TransactionClient,
				now,
			),
		).toHaveLength(1);
		approval.rightsEvidence = "different-rights";
		await expect(
			findApprovedSourceTemplateReferences(
				f.template,
				f.tx as unknown as Prisma.TransactionClient,
				now,
			),
		).rejects.toThrow("VIDEO_SOURCE_TEMPLATE_REFERENCE_APPROVAL_REQUIRED");
		approval.rightsEvidence = reference.rightsEvidence;
		asset.verificationProvider = "seeapi";
		await expect(
			findApprovedSourceTemplateReferences(
				f.template,
				f.tx as unknown as Prisma.TransactionClient,
				now,
			),
		).rejects.toThrow("VIDEO_SOURCE_TEMPLATE_REFERENCE_APPROVAL_REQUIRED");
	});
	it("recognizes explicit administrator source-image inspection without claiming a SeeAPI verdict", async () => {
		const f = fixture();
		const reference = {
			assetId: "source-image",
			checksum: "a".repeat(64),
			objectKey: "admin/source.png",
			storageEtag: "source-etag",
			storageVersionId: null,
			verificationGeneration: 1,
			sourceUrl: "https://source.example/scene.png",
			ownerId: "admin",
			rightsEvidence: "source-rights",
			validUntil: "2026-11-07T00:00:00.000Z",
		};
		f.template.references.push(reference);
		const asset = {
			...reference,
			id: reference.assetId,
			ownerType: "USER",
			kind: "INPUT",
			mimeType: "image/png",
			status: "READY",
			finalizedAt: now,
			deletedAt: null,
			deleteAfter: null,
			verificationValidUntil: new Date(reference.validUntil),
			verificationPolicyVersion: "source-inspection-v1",
			verificationRuleVersion: "source-inspection-v1",
			verificationProvider: "administrator",
			verificationProviderTaskId: null as string | null,
			verificationAttemptCount: 1,
		};
		const approval = {
			...reference,
			approvalReceiptId: "test-only-approval",
			approvalKind: "test-fixture",
			targetEnvironment: "local",
			templateKey: f.template.templateKey,
			version: f.template.version,
			decision: "ALLOW",
			reviewerId: "admin",
			reviewedAt: now.toISOString(),
			reviewKind: "administrator-image",
			sourceProvenance: {
				sourceRepository: "ez-airapvideo",
				sourceCommit: "b".repeat(40),
				sourceConfigKey: "original-rap",
				sourceRole: "scene",
				sourceAssetSha256: reference.checksum,
				sourceRevision: "source-v1",
				sourceUrlSha256: null,
				inspectionReceiptId: "test-only-inspection",
				inspector: "test-only-inspector",
				inspectionMethod: "visual-and-source-hash",
				inspectedAt: now.toISOString(),
			},
		};
		f.tx.mediaAsset.findFirst.mockResolvedValue(asset);
		f.tx.assetModerationResult.findFirst.mockResolvedValue({
			validUntil: new Date(reference.validUntil),
			rawEnvelope: { sourceTemplateReferenceApproval: approval },
		});
		const read = () =>
			findApprovedSourceTemplateReferences(
				f.template,
				f.tx as unknown as Prisma.TransactionClient,
				now,
			);
		expect(await read()).toHaveLength(1);
		approval.sourceProvenance.sourceAssetSha256 = "c".repeat(64);
		await expect(read()).rejects.toThrow("VIDEO_SOURCE_TEMPLATE_REFERENCE_APPROVAL_REQUIRED");
		approval.sourceProvenance.sourceAssetSha256 = reference.checksum;
		asset.verificationProviderTaskId = "invented-provider-task";
		await expect(read()).rejects.toThrow("VIDEO_SOURCE_TEMPLATE_REFERENCE_APPROVAL_REQUIRED");
		asset.verificationProviderTaskId = null;
		asset.verificationProvider = "seeapi";
		await expect(read()).rejects.toThrow("VIDEO_SOURCE_TEMPLATE_REFERENCE_APPROVAL_REQUIRED");
	});
});
