import { call } from "@orpc/server";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), job: vi.fn() }));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.session } } }));
vi.mock("@repo/database/client", () => ({
	db: {},
	getDatabaseClient: () => {
		throw new Error("UNEXPECTED_SECOND_DATABASE_READ");
	},
}));
vi.mock("@repo/database/video-v1", async (original) => ({
	...(await original<typeof import("@repo/database/video-v1")>()),
	getVideoJobRecord: mocks.job,
}));

import { verifyPlaybackGrant } from "./playback-policy";
import { videoV1Router } from "./router";

const secret = "local-playback-fixture-".repeat(3);
function readyJob() {
	// Historical evidence uses the same retained approval contract as direct playback.
	const profile = createVideoVisualSafetyProfile("sightengine", 5);
	const expiry = new Date(Date.now() + 60_000);
	return {
		id: "job",
		ownerType: "USER",
		ownerId: "owner",
		executionEngine: "video-workflow-v1",
		status: "SUCCEEDED",
		inputSnapshot: { duration: 5 },
		pricingSnapshot: {},
		creditsReserved: 12n,
		failureCode: null,
		updatedAt: new Date(),
		videoExecution: { stage: "READY", stageData: { outputSpec: { audioTracks: 0 } } },
		reservation: { status: "SETTLED" },
		assets: [
			{
				asset: {
					id: "asset",
					ownerType: "USER",
					ownerId: "owner",
					status: "READY",
					kind: "OUTPUT",
					objectKey: "private/owner/asset.mp4",
					mimeType: "video/mp4",
					byteSize: 1000n,
					durationMillis: 5000n,
					checksum: "a".repeat(64),
					storageEtag: "private-etag",
					deletedAt: null as Date | null,
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
							rawEnvelope: { complete: true, objectEtag: "private-etag" },
						},
					],
				},
			},
		],
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("BETTER_AUTH_SECRET", secret);
	mocks.session.mockResolvedValue({ user: { id: "owner", isAnonymous: false }, session: {} });
	mocks.job.mockResolvedValue(readyJob());
});
afterEach(() => vi.unstubAllEnvs());
const read = (responseHeaders = new Headers()) =>
	call(
		videoV1Router.jobs.get,
		{ jobId: "job" },
		{ context: { headers: new Headers(), responseHeaders } },
	);

describe("private playback in the authorized video status response", () => {
	it("returns an owner-bound short-lived grant from a single current detail read", async () => {
		const responseHeaders = new Headers();
		const state = await read(responseHeaders);
		expect(mocks.session).toHaveBeenCalledOnce();
		expect(mocks.job).toHaveBeenCalledExactlyOnceWith("owner", "job", {});
		expect(state.canPlay).toBe(true);
		expect(state.playback?.ownerId).toBe("owner");
		expect(responseHeaders.get("cache-control")).toBe("private, no-store");
		const url = new URL(state.playback!.url, "https://site.test");
		expect(url.pathname).toBe("/api/video-v1/jobs/job/content");
		const expires = Number(url.searchParams.get("expires"));
		expect(expires).toBeLessThanOrEqual(Date.now() + 60_000);
		expect(
			verifyPlaybackGrant(
				{
					userId: "owner",
					jobId: "job",
					assetId: "asset",
					checksum: "a".repeat(64),
					expires,
					download: false,
				},
				url.searchParams.get("signature")!,
				secret,
			),
		).toBe(true);
		expect(
			verifyPlaybackGrant(
				{
					userId: "other",
					jobId: "job",
					assetId: "asset",
					checksum: "a".repeat(64),
					expires,
					download: false,
				},
				url.searchParams.get("signature")!,
				secret,
			),
		).toBe(false);
		expect(JSON.stringify(state)).not.toMatch(
			/private-etag|private\/owner|checksum|moderationResults|review-task/,
		);
	});
	it("does not issue grants for READY rows whose evidence has expired or been revoked", async () => {
		const job = readyJob();
		job.assets[0]!.asset.verificationValidUntil = new Date(0);
		mocks.job.mockResolvedValue(job);
		const state = await read();
		expect(state.canPlay).toBe(false);
		expect(state).not.toHaveProperty("playback");
	});
	it("denies an anonymous request before reading any job", async () => {
		mocks.session.mockResolvedValue({ user: { id: "owner", isAnonymous: true }, session: {} });
		await expect(read()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.job).not.toHaveBeenCalled();
	});
	it("does not issue a grant for another owner's projection even if it is READY", async () => {
		const job = readyJob();
		job.ownerId = "other";
		mocks.job.mockResolvedValue(job);
		expect(await read()).toMatchObject({ canPlay: false });
		expect(await read()).not.toHaveProperty("playback");
	});
});
