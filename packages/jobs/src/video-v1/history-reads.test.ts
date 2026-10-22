import { createVideoEffectTemplateSnapshot } from "@repo/config/video-effects.server";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({
	db: {},
	getDatabaseClient: () => {
		throw new Error("Unexpected database read outside the history query");
	},
}));
vi.mock("@repo/database/video-v1", () => ({
	createVideoJobRecord: vi.fn(),
	findExistingVideoAdmission: vi.fn(),
	getVideoJobRecord: vi.fn(),
	listVideoJobRecords: vi.fn(),
}));
vi.mock("@repo/database/video-template", () => ({
	createVideoTemplateQuoteRecord: vi.fn(),
	createVideoTemplateJobRecord: vi.fn(),
	findExistingVideoTemplateAdmission: vi.fn(),
	getVideoTemplateJobRecord: vi.fn(),
	listVideoTemplateJobRecords: vi.fn(),
}));
vi.mock("@repo/database/video-v1-fulfillment", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database/video-v1-fulfillment")>()),
	authorizeVideoPlayback: vi.fn(),
}));

import { listVideoTemplateJobRecords } from "@repo/database/video-template";
import { getVideoJobRecord, listVideoJobRecords } from "@repo/database/video-v1";
import {
	authorizeVideoPlayback,
	type VideoPlaybackSnapshot,
} from "@repo/database/video-v1-fulfillment";

import { getVideoPublicState, listVideoPublicStates } from "./admission";
import { listVideoTemplatePublicStates } from "./template-admission";

function historyRow(id: string) {
	const profile = createVideoVisualSafetyProfile("sightengine", 5);
	const expiry = new Date(Date.now() + 3600_000);
	const playback: VideoPlaybackSnapshot = {
		id,
		ownerType: "USER",
		ownerId: "owner",
		executionEngine: "video-workflow-v1",
		status: "SUCCEEDED",
		inputSnapshot: { duration: 5 },
		videoExecution: {
			stage: "READY",
			stageData: { outputSpec: { audioTracks: 0 } },
		},
		reservation: { status: "SETTLED" },
		assets: [
			{
				asset: {
					id: `output-${id}`,
					ownerType: "USER",
					ownerId: "owner",
					status: "READY",
					kind: "OUTPUT",
					objectKey: `private/${id}.mp4`,
					mimeType: "video/mp4",
					byteSize: 1000n,
					durationMillis: 5000n,
					checksum: "a".repeat(64),
					storageEtag: "private-etag",
					deletedAt: null,
					deleteAfter: expiry,
					verificationEngine: "video-workflow-v1",
					verificationProvider: profile.provider,
					verificationRuleVersion: profile.ruleVersion,
					verificationPolicyVersion: profile.policyVersion,
					verificationProviderTaskId: "private-task",
					verificationValidUntil: expiry,
					verificationGeneration: 1,
					verificationAttemptCount: 1,
					moderationResults: [
						{
							evidenceKind: "OUTPUT",
							status: "APPROVED",
							assetChecksum: "a".repeat(64),
							provider: profile.provider,
							providerTaskId: "private-task",
							verificationGeneration: 1,
							attemptNumber: 1,
							ruleVersion: profile.ruleVersion,
							policyVersion: profile.policyVersion,
							validUntil: expiry,
							rawEnvelope: { complete: true, objectEtag: "private-etag" },
						},
					],
				},
			},
		],
	};
	return {
		...playback,
		creditsReserved: 12n,
		pricingSnapshot: {},
		failureCode: null,
		updatedAt: new Date(0),
	};
}

beforeEach(() => vi.clearAllMocks());

describe("history playback without per-row database reloads", () => {
	it("evaluates a full ordinary page from its evidence while keeping detail reads current", async () => {
		const rows = Array.from({ length: 20 }, (_, index) => historyRow(`job-${index}`));
		rows[1]!.assets[0]!.asset.checksum = "b".repeat(64);
		vi.mocked(listVideoJobRecords).mockResolvedValue({ rows, nextCursor: "job-19" });
		const result = await listVideoPublicStates({ userId: "owner" }, { limit: 20 });
		expect(result.items).toHaveLength(20);
		expect(result.items.filter((item) => item.canPlay)).toHaveLength(19);
		expect(result.items[1]).toMatchObject({ jobId: "job-1", canPlay: false });
		expect(result.nextCursor).toBe("job-19");
		expect(listVideoJobRecords).toHaveBeenCalledExactlyOnceWith("owner", { limit: 20 }, {});
		expect(authorizeVideoPlayback).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toMatch(/private|checksum|storageEtag|moderationResults/);

		vi.mocked(getVideoJobRecord).mockResolvedValue(rows[0] as never);
		const grant = vi.fn((asset) => ({
			url: `/content/${asset.id}`,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			ownerId: "owner",
		}));
		const detail = await getVideoPublicState({ userId: "owner" }, "job-0", grant);
		expect(detail.canPlay).toBe(true);
		expect(detail.playback?.url).toBe("/content/output-job-0");
		expect(getVideoJobRecord).toHaveBeenCalledExactlyOnceWith("owner", "job-0", {});
		expect(grant).toHaveBeenCalledExactlyOnceWith(rows[0]!.assets[0]!.asset);
		expect(authorizeVideoPlayback).not.toHaveBeenCalled();
		// A later status request cannot reuse the earlier grant after evidence changes.
		rows[0]!.assets[0]!.asset.deletedAt = new Date();
		grant.mockClear();
		expect(await getVideoPublicState({ userId: "owner" }, "job-0", grant)).toMatchObject({
			canPlay: false,
		});
		expect(grant).not.toHaveBeenCalled();
	});

	it.each([
		[
			"owner",
			(row: ReturnType<typeof historyRow>) => {
				row.ownerId = "other";
			},
		],
		[
			"asset owner",
			(row: ReturnType<typeof historyRow>) => {
				row.assets[0]!.asset.ownerId = "other";
			},
		],
		[
			"expired evidence",
			(row: ReturnType<typeof historyRow>) => {
				row.assets[0]!.asset.verificationValidUntil = new Date(0);
			},
		],
		[
			"expired retention",
			(row: ReturnType<typeof historyRow>) => {
				row.assets[0]!.asset.deleteAfter = new Date(0);
			},
		],
		[
			"checksum",
			(row: ReturnType<typeof historyRow>) => {
				row.assets[0]!.asset.checksum = "b".repeat(64);
			},
		],
		[
			"pending review",
			(row: ReturnType<typeof historyRow>) => {
				row.assets[0]!.asset.status = "VERIFYING";
			},
		],
		[
			"rejected review",
			(row: ReturnType<typeof historyRow>) => {
				row.assets[0]!.asset.moderationResults[0]!.status = "REJECTED";
			},
		],
		[
			"unsettled credits",
			(row: ReturnType<typeof historyRow>) => {
				row.reservation!.status = "ACTIVE";
			},
		],
	] as const)("never issues an inline grant with invalid %s", async (_reason, mutate) => {
		const row = historyRow("job");
		mutate(row);
		vi.mocked(getVideoJobRecord).mockResolvedValue(row as never);
		const grant = vi.fn();
		const state = await getVideoPublicState({ userId: "owner" }, "job", grant);
		expect(state.canPlay).toBe(false);
		expect(state).not.toHaveProperty("playback");
		expect(grant).not.toHaveBeenCalled();
	});

	it("forwards template family and evaluates both variants without repeated playback reads", async () => {
		const rows = (["raindance-solo", "raindance-duo"] as const).map((effectId) => ({
			...historyRow(effectId),
			videoTemplateExecution: {
				templateSnapshot: createVideoEffectTemplateSnapshot({
					effectId,
					presetKey: "standard",
					inputs: {
						leftAssetId: "left",
						rightAssetId: effectId === "raindance-solo" ? "left" : "right",
					},
				}),
				sceneState: "READY",
				sceneSubmissionUncertain: false,
				updatedAt: new Date(0),
			},
		}));
		rows[1]!.assets[0]!.asset.deleteAfter = new Date(0);
		vi.mocked(listVideoTemplateJobRecords).mockResolvedValue({ rows, nextCursor: null });
		const result = await listVideoTemplatePublicStates(
			{ userId: "owner" },
			{ templateFamily: "raindance", limit: 20 },
		);
		expect(result.items.map((item) => [item.effectId, item.canPlay])).toEqual([
			["raindance-solo", true],
			["raindance-duo", false],
		]);
		expect(listVideoTemplateJobRecords).toHaveBeenCalledExactlyOnceWith(
			"owner",
			{ templateFamily: "raindance", limit: 20 },
			{},
		);
		expect(authorizeVideoPlayback).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toMatch(/private|checksum|storageEtag|moderationResults/);
	});
});
