import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("../../client", () => ({
	getDatabaseClient: () => ({ generationJob: { findFirst: mocked.findFirst } }),
}));

import type { Prisma } from "../../generated/client";
import type { MediaDatabaseClient } from "./types";
import { listVideoTemplateJobRecords } from "./video-template-admission";
import { listVideoJobRecords } from "./video-v1";
import {
	authorizeVideoPlayback,
	authorizeVideoPlaybackSnapshot,
	videoPlaybackSelect,
	type VideoPlaybackSnapshot,
} from "./video-v1-fulfillment";

const now = new Date("2026-10-20T12:00:00.000Z");
const expiry = new Date("2026-10-21T12:00:00.000Z");

function reviewedJob(): VideoPlaybackSnapshot {
	const profile = createVideoVisualSafetyProfile("seeapi", 5);
	return {
		id: "job",
		ownerType: "USER",
		ownerId: "owner",
		executionEngine: "video-workflow-v1",
		status: "SUCCEEDED",
		inputSnapshot: {
			duration: 5,
			visualSafetyProfile: profile,
			audioSafetyPolicy: { schemaVersion: 1, mode: "not_requested" },
		},
		videoExecution: {
			stage: "READY",
			stageData: { outputSpec: { audioTracks: 0, audioTrackIds: [] } },
		},
		reservation: { status: "SETTLED" },
		assets: [
			{
				asset: {
					id: "output",
					ownerType: "USER",
					ownerId: "owner",
					status: "READY",
					kind: "OUTPUT",
					objectKey: "private/owner/output.mp4",
					mimeType: "video/mp4",
					byteSize: 1000n,
					durationMillis: 5000n,
					checksum: "a".repeat(64),
					storageEtag: "output-etag",
					deletedAt: null,
					deleteAfter: expiry,
					verificationEngine: "video-workflow-v1",
					verificationProvider: profile.provider,
					verificationRuleVersion: profile.ruleVersion,
					verificationPolicyVersion: profile.policyVersion,
					verificationProviderTaskId: "review-task",
					verificationValidUntil: expiry,
					verificationGeneration: 1,
					verificationAttemptCount: 1,
					moderationResults: [
						{
							evidenceKind: "OUTPUT",
							status: "APPROVED",
							assetChecksum: "a".repeat(64),
							provider: profile.provider,
							providerTaskId: "review-task",
							verificationGeneration: 1,
							attemptNumber: 1,
							ruleVersion: profile.ruleVersion,
							policyVersion: profile.policyVersion,
							validUntil: expiry,
							rawEnvelope: {
								requestId: "review-task",
								models: ["video-nsfw-filter"],
								complete: true,
								objectEtag: "output-etag",
								seeapiConfirmationEventId: "authenticated-confirmation",
								audioSafetyPolicy: { schemaVersion: 1, mode: "not_requested" },
								video: {
									complete: true,
									durationMillis: 5000,
									frameCount: 8,
									firstFrameSeconds: 0,
									lastFrameSeconds: 4.8,
								},
								seeapiVideo: {
									taskId: "review-task",
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
							},
						},
					],
				},
			},
		],
	};
}

const asset = (job: VideoPlaybackSnapshot) => job.assets[0]!.asset;
const evidence = (job: VideoPlaybackSnapshot) => asset(job).moderationResults[0]!;
const envelope = (job: VideoPlaybackSnapshot) => evidence(job).rawEnvelope as Prisma.JsonObject;
type Mutation = (job: VideoPlaybackSnapshot) => void;
const denied: Array<[string, Mutation]> = [
	[
		"another owner",
		(job) => {
			job.ownerId = "other";
		},
	],
	[
		"an organization job",
		(job) => {
			job.ownerType = "ORGANIZATION";
		},
	],
	[
		"another execution engine",
		(job) => {
			job.executionEngine = "legacy";
		},
	],
	[
		"an unsuccessful job",
		(job) => {
			job.status = "FINALIZING";
		},
	],
	[
		"a pending execution",
		(job) => {
			job.videoExecution!.stage = "OUTPUT_REVIEW";
		},
	],
	[
		"an unsettled reservation",
		(job) => {
			job.reservation!.status = "ACTIVE";
		},
	],
	[
		"missing output",
		(job) => {
			job.assets = [];
		},
	],
	[
		"another asset owner",
		(job) => {
			asset(job).ownerId = "other";
		},
	],
	[
		"an input asset",
		(job) => {
			asset(job).kind = "INPUT";
		},
	],
	[
		"an unready asset",
		(job) => {
			asset(job).status = "VERIFYING";
		},
	],
	[
		"a deleted asset",
		(job) => {
			asset(job).deletedAt = now;
		},
	],
	[
		"expired retention",
		(job) => {
			asset(job).deleteAfter = now;
		},
	],
	[
		"expired review",
		(job) => {
			asset(job).verificationValidUntil = now;
			evidence(job).validUntil = now;
		},
	],
	[
		"missing moderation",
		(job) => {
			asset(job).moderationResults = [];
		},
	],
	[
		"unapproved latest moderation",
		(job) => {
			evidence(job).status = "PENDING";
		},
	],
	[
		"changed checksum",
		(job) => {
			asset(job).checksum = "b".repeat(64);
		},
	],
	[
		"changed ETag",
		(job) => {
			asset(job).storageEtag = "replacement";
		},
	],
	[
		"a newer verification generation",
		(job) => {
			asset(job).verificationGeneration = 2;
		},
	],
	[
		"a different moderation task",
		(job) => {
			asset(job).verificationProviderTaskId = "other-task";
		},
	],
	[
		"missing authenticated confirmation",
		(job) => {
			delete envelope(job).seeapiConfirmationEventId;
		},
	],
	[
		"incomplete visual coverage",
		(job) => {
			(envelope(job).seeapiVideo as Prisma.JsonObject).checkedFrames = 7;
		},
	],
	[
		"missing frozen audio policy",
		(job) => {
			delete envelope(job).audioSafetyPolicy;
		},
	],
	[
		"historical audio requiring transcript review",
		(job) => {
			job.inputSnapshot = {
				...(job.inputSnapshot as Prisma.JsonObject),
				audioSafetyPolicy: { schemaVersion: 1, mode: "required" },
			};
			job.videoExecution!.stageData = { outputSpec: { audioTracks: 1, audioTrackIds: [2] } };
		},
	],
];

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe("video history and playback evidence", () => {
	it("uses the same approval for a list snapshot and a fresh playback read", async () => {
		const job = reviewedJob();
		mocked.findFirst.mockResolvedValue(job);
		expect(authorizeVideoPlaybackSnapshot("owner", job, now)).toEqual(asset(job));
		expect(await authorizeVideoPlayback("owner", "job")).toEqual(asset(job));
		expect(mocked.findFirst).toHaveBeenCalledExactlyOnceWith({
			where: {
				id: "job",
				ownerType: "USER",
				ownerId: "owner",
				executionEngine: "video-workflow-v1",
				status: "SUCCEEDED",
			},
			select: videoPlaybackSelect,
		});
		expect(videoPlaybackSelect).not.toHaveProperty("attempts");
		expect(videoPlaybackSelect).not.toHaveProperty("videoTemplateExecution");
	});

	it.each(denied)("denies %s in both history and fresh playback", async (_reason, mutate) => {
		const job = reviewedJob();
		mutate(job);
		mocked.findFirst.mockResolvedValue(job);
		expect(authorizeVideoPlaybackSnapshot("owner", job, now)).toBeNull();
		expect(await authorizeVideoPlayback("owner", "job")).toBeNull();
	});

	it("rechecks expiry even when the same request-local projection was previously playable", () => {
		const job = reviewedJob();
		expect(authorizeVideoPlaybackSnapshot("owner", job, now)).not.toBeNull();
		expect(authorizeVideoPlaybackSnapshot("owner", job, expiry)).toBeNull();
		expect(mocked.findFirst).not.toHaveBeenCalled();
	});
});

function historyClient() {
	const generationJob = { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() };
	return { generationJob, client: { generationJob } as unknown as MediaDatabaseClient };
}

describe("bounded owner-scoped video history reads", () => {
	it("loads a full ordinary page and its latest output evidence in one findMany call", async () => {
		const db = historyClient();
		db.generationJob.findMany.mockResolvedValue(
			Array.from({ length: 21 }, (_, index) => ({ id: `job-${index}` })),
		);
		const result = await listVideoJobRecords("owner", { limit: 20 }, db.client);
		expect(result.rows).toHaveLength(20);
		expect(result.nextCursor).toBe("job-19");
		expect(db.generationJob.findMany).toHaveBeenCalledExactlyOnceWith({
			where: { ownerType: "USER", ownerId: "owner", executionEngine: "video-workflow-v1" },
			select: {
				...videoPlaybackSelect,
				creditsReserved: true,
				pricingSnapshot: true,
				failureCode: true,
				updatedAt: true,
			},
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: 21,
		});
		expect(db.generationJob.findFirst).not.toHaveBeenCalled();
	});

	it.each([
		["hotel-lobby", ["hotel-lobby-duo"]],
		["raindance", ["raindance-solo", "raindance-duo"]],
		["rumpelstiltskin", ["rumpelstiltskin-solo"]],
	] as const)(
		"filters %s before pagination and validates its cursor in the same owner/family",
		async (family, effectIds) => {
			const db = historyClient();
			db.generationJob.findFirst.mockResolvedValue({
				id: "cursor",
				videoExecution: { jobId: "cursor" },
				reservation: { id: "reservation" },
			});
			await listVideoTemplateJobRecords(
				"owner",
				{ templateFamily: family, cursor: "cursor", limit: 2 },
				db.client,
			);
			const where = {
				ownerType: "USER",
				ownerId: "owner",
				executionEngine: "video-workflow-v1",
				videoTemplateExecution: {
					is: {
						OR: effectIds.map((effectId) => ({
							templateSnapshot: { path: ["effectId"], equals: effectId },
						})),
					},
				},
			};
			expect(db.generationJob.findFirst).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ where: { ...where, id: "cursor" } }),
			);
			expect(db.generationJob.findMany).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ where, cursor: { id: "cursor" }, skip: 1, take: 3 }),
			);
			expect(db.generationJob.findMany.mock.calls[0]![0].select.videoTemplateExecution).toEqual({
				select: {
					templateSnapshot: true,
					sceneState: true,
					sceneSubmissionUncertain: true,
					updatedAt: true,
				},
			});
		},
	);

	it("keeps omitted template family compatible with all of the owner's templates", async () => {
		const db = historyClient();
		await listVideoTemplateJobRecords("owner", {}, db.client);
		expect(db.generationJob.findMany).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				where: {
					ownerType: "USER",
					ownerId: "owner",
					executionEngine: "video-workflow-v1",
					videoTemplateExecution: { isNot: null },
				},
				take: 21,
			}),
		);
		expect(db.generationJob.findFirst).not.toHaveBeenCalled();
	});

	it("rejects a cursor outside the owner/family without issuing the page read", async () => {
		const db = historyClient();
		db.generationJob.findFirst.mockResolvedValue(null);
		await expect(
			listVideoTemplateJobRecords(
				"owner",
				{ templateFamily: "raindance", cursor: "other-family-or-owner" },
				db.client,
			),
		).rejects.toThrow("NOT_FOUND");
		expect(db.generationJob.findMany).not.toHaveBeenCalled();
		await expect(
			listVideoJobRecords("owner", { cursor: "other-owner" }, db.client),
		).rejects.toThrow("NOT_FOUND");
		expect(db.generationJob.findMany).not.toHaveBeenCalled();
	});
});
