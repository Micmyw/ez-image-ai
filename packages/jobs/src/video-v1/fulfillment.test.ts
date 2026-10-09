/* oxlint-disable typescript/unbound-method -- Assertions inspect mock call history without invoking methods. */
import type { MediaSafetyAdapter, ModerationDecision } from "@repo/ai";
import { readVideoAudioSafetyPolicy, videoOutputConstraints } from "@repo/config/video-output";
import {
	readVideoVisualSafetyProfile,
	createVideoVisualSafetyProfile,
} from "@repo/config/video-safety";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
	claimReview: vi.fn(),
	beginSubmission: vi.fn(),
	recordTask: vi.fn(),
	recordReview: vi.fn(),
	releaseReview: vi.fn(),
	needsReview: vi.fn(),
	fail: vi.fn(),
	claimStore: vi.fn(),
	completeStore: vi.fn(),
	releaseStore: vi.fn(),
	inspect: vi.fn(),
	transfer: vi.fn(),
	snapshot: vi.fn(),
	finalize: vi.fn(),
	sign: vi.fn(),
	seeapiClaim: vi.fn(),
	seeapiRecord: vi.fn(),
	callbackUrl: vi.fn(),
}));
vi.mock("@repo/database/video-v1-fulfillment", () => ({
	claimVideoOutputReview: async (jobId: string, deadlineSeconds: number) => {
		const claim = await mocks.claimReview(jobId, deadlineSeconds);
		return { ...claim, reviewContext: claim.reviewContext ?? currentReviewContext };
	},
	beginVideoReviewSubmission: mocks.beginSubmission,
	recordVideoReviewTask: mocks.recordTask,
	recordVideoOutputReview: mocks.recordReview,
	releaseVideoReviewLease: mocks.releaseReview,
	markVideoNeedsReview: mocks.needsReview,
	failVideoDelivery: mocks.fail,
	claimVideoOutputStorage: mocks.claimStore,
	completeVideoOutputStorage: mocks.completeStore,
	releaseVideoStorageLease: mocks.releaseStore,
	getVideoFulfillmentSnapshot: mocks.snapshot,
	finalizeVideoDelivery: mocks.finalize,
}));
vi.mock("./output-storage", () => ({
	inspectVideoObject: mocks.inspect,
	transferVideoOutput: mocks.transfer,
}));
vi.mock("@repo/storage", () => ({ createSignedReadUrl: mocks.sign }));
vi.mock("@repo/database/video-v1-seeapi-events", () => ({
	claimSeeapiVideoConfirmation: mocks.seeapiClaim,
	recordSeeapiVideoConfirmation: mocks.seeapiRecord,
}));
vi.mock("./seeapi-callback-url", () => ({ createSeeapiVideoCallbackUrl: mocks.callbackUrl }));
vi.mock("./seeapi-webhooks", () => ({ notifyPendingSeeapiVideoModerationEvents: vi.fn() }));
import { reviewStoredVideo, storeVideoOutput } from "./fulfillment";
const asset = {
	id: "sealed-output",
	objectKey: "users/u/video/immutable.mp4",
	checksum: "a".repeat(64),
	storageEtag: "immutable-etag",
	byteSize: 1000n,
	verificationProviderTaskId: "moderation-1",
	verificationGeneration: 1,
	verificationAttemptCount: 1,
	verificationDeadlineAt: new Date(Date.now() + 60000),
};
const object = {
	bytes: 1000,
	checksum: asset.checksum,
	etag: asset.storageEtag,
	durationMillis: 5000,
	width: 1280,
	height: 720,
	audioTracks: 0,
	videoTracks: 1,
};
let currentReviewContext: {
	visualSafetyProfile: ReturnType<typeof readVideoVisualSafetyProfile>;
	audioSafetyPolicy: ReturnType<typeof readVideoAudioSafetyPolicy>;
	constraints: ReturnType<typeof videoOutputConstraints>;
	durationMillis: number;
	outputSpec: { audioTracks?: number; audioTrackIds?: number[] };
};
function setReviewContext(fixture: {
	inputSnapshot: unknown;
	videoExecution: {
		stageData: { outputSpec?: { audioTracks?: number; audioTrackIds?: number[] } };
	};
	assets: { asset: { durationMillis?: bigint; [key: string]: unknown } }[];
}) {
	const constraints = videoOutputConstraints(fixture.inputSnapshot);
	currentReviewContext = {
		visualSafetyProfile: readVideoVisualSafetyProfile(fixture.inputSnapshot),
		audioSafetyPolicy: readVideoAudioSafetyPolicy(fixture.inputSnapshot),
		constraints,
		durationMillis: Number(
			fixture.assets[0]?.asset.durationMillis ?? constraints.durationSeconds * 1000,
		),
		outputSpec: fixture.videoExecution.stageData.outputSpec ?? {},
	};
}
function adapter(result: ModerationDecision): MediaSafetyAdapter {
	return {
		moderateText: vi.fn(),
		moderateImage: vi.fn(),
		submitVideo: vi.fn(async () => ({
			moderationTaskId: "moderation-1",
			status: "QUEUED" as const,
			ruleVersion: "test",
			idempotency: { key: "key", providerSupported: false, replayed: false },
		})),
		retrieveVideo: vi.fn(async () => result),
	};
}
describe("video fulfillment stage recovery", () => {
	afterEach(() => {
		expect(mocks.snapshot).not.toHaveBeenCalled();
	});
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.inspect.mockResolvedValue(object);
		mocks.sign.mockResolvedValue("https://private.invalid/signed-no-log");
		mocks.beginSubmission.mockResolvedValue(undefined);
		mocks.seeapiClaim.mockResolvedValue({
			status: "CLAIMED",
			eventId: "event",
			token: "confirmation",
			providerTaskId: "moderation-1",
			assetId: asset.id,
			readAttemptCount: 1,
			nextRetryAt: new Date(Date.now() + 61000).toISOString(),
		});
		mocks.seeapiRecord.mockResolvedValue({ status: "COMPLETE" });
		mocks.callbackUrl.mockResolvedValue(
			"https://example.com/api/webhooks/video-v1/seeapi/sealed-output?proof=server-proof",
		);
		setReviewContext({
			inputSnapshot: {
				duration: 5,
				visualSafetyProfile: createVideoVisualSafetyProfile("seeapi", 5),
				audioSafetyPolicy: { schemaVersion: 1, mode: "not_requested" },
			},
			videoExecution: { stageData: { outputSpec: { audioTracks: 0, audioTrackIds: [] } } },
			assets: [{ asset: { ...asset, durationMillis: 5000n } }],
		});
		mocks.claimReview.mockResolvedValue({ status: "QUERY", token: "token", asset });
	});
	it.each([
		{ status: "APPROVED", expected: { status: "ALLOW" } },
		{ status: "REJECTED", expected: { status: "REJECT", reasonCode: "SEXUAL_CONTENT" } },
	])(
		"preserves the persisted $status result ahead of historical policy holds",
		async ({ status, expected }) => {
			mocks.claimReview.mockResolvedValue({
				status,
				token: null,
				asset,
				reasonCode: "SEXUAL_CONTENT",
				reviewContext: {
					...currentReviewContext,
					visualSafetyProfile: createVideoVisualSafetyProfile("sightengine", 5),
					audioSafetyPolicy: { schemaVersion: 1, mode: "required" },
					outputSpec: { audioTracks: 1 },
				},
			});
			const safety = adapter({ decision: "ALLOW", reasonCode: "unused", ruleVersion: "test" });
			expect(await reviewStoredVideo("job", {}, safety)).toEqual(expected);
			expect(safety.submitVideo).not.toHaveBeenCalled();
			expect(safety.retrieveVideo).not.toHaveBeenCalled();
			expect(mocks.needsReview).not.toHaveBeenCalled();
		},
	);
	it.each([true, false])(
		"preserves a BUSY SeeAPI lease/callback wait (active lease: %s)",
		async (leased) => {
			const leasedUntil = new Date(Date.now() + 30_000);
			mocks.claimReview.mockResolvedValue({
				status: "BUSY",
				token: null,
				asset: { ...asset, verificationLeasedUntil: leased ? leasedUntil : null },
			});
			const safety = adapter({ decision: "ALLOW", reasonCode: "unused", ruleVersion: "test" });
			expect(await reviewStoredVideo("job", {}, safety)).toMatchObject({
				status: "PENDING",
				waitFor: leased ? "confirmation-retry" : "callback",
				deadlineAt: asset.verificationDeadlineAt.toISOString(),
				...(leased ? { nextRetryAt: leasedUntil.toISOString() } : {}),
			});
			expect(safety.submitVideo).not.toHaveBeenCalled();
			expect(safety.retrieveVideo).not.toHaveBeenCalled();
		},
	);
	it("holds EXPIRED moderation without another paid submission", async () => {
		mocks.claimReview.mockResolvedValue({ status: "EXPIRED", token: null, asset });
		const safety = adapter({ decision: "ALLOW", reasonCode: "unused", ruleVersion: "test" });
		expect(await reviewStoredVideo("job", {}, safety)).toEqual({
			status: "ERROR",
			reasonCode: "VIDEO_MODERATION_DEADLINE",
			retryable: false,
		});
		expect(mocks.needsReview).toHaveBeenCalledWith("job", "VIDEO_MODERATION_DEADLINE");
		expect(safety.submitVideo).not.toHaveBeenCalled();
		expect(safety.retrieveVideo).not.toHaveBeenCalled();
	});
	it("a completed private object is adopted after a DB fault without another transfer", async () => {
		mocks.claimStore.mockResolvedValue({
			status: "CLAIMED",
			token: "transfer",
			asset,
			maxBytes: 10000,
			sourceUrl: "https://provider.invalid/result",
		});
		mocks.completeStore
			.mockRejectedValueOnce(new Error("DB interrupted"))
			.mockResolvedValueOnce(asset);
		await expect(storeVideoOutput("job", {})).rejects.toThrow("DB interrupted");
		expect(mocks.releaseStore).toHaveBeenCalledWith("job", asset.id, "transfer");
		expect(await storeVideoOutput("job", {})).toEqual({
			assetId: asset.id,
			checksum: asset.checksum,
			byteSize: "1000",
		});
		expect(mocks.transfer).not.toHaveBeenCalled();
	});
	it.each(["transfer", "recovery", "stored"] as const)(
		"passes the frozen audio policy through the %s storage path",
		async (path) => {
			const constraints = videoOutputConstraints({
				productKey: "video-kling-3",
				duration: 5,
				sound: true,
				resolution: "720p",
				aspectRatio: "16:9",
				audioSafetyPolicy: { schemaVersion: 1, mode: "not_requested" },
			});
			const output = { ...object, bytes: 30_000_000, audioTracks: 1, audioTrackIds: [2] };
			mocks.claimStore.mockResolvedValue({
				status: path === "stored" ? "STORED" : "CLAIMED",
				token: path === "stored" ? null : "transfer",
				asset: { ...asset, byteSize: BigInt(output.bytes) },
				maxBytes: 100 * 1024 * 1024,
				sourceUrl: "https://provider.invalid/result",
				constraints,
			});
			mocks.inspect.mockResolvedValue(path === "transfer" ? null : output);
			mocks.transfer.mockResolvedValue(output);
			expect(await storeVideoOutput("job", {})).toEqual({
				assetId: asset.id,
				checksum: asset.checksum,
				byteSize: "30000000",
			});
			expect(mocks.inspect).toHaveBeenCalledWith(
				asset.objectKey,
				path === "stored"
					? { checksum: asset.checksum, etag: asset.storageEtag, bytes: output.bytes }
					: undefined,
				constraints,
			);
			if (path === "transfer")
				expect(mocks.transfer).toHaveBeenCalledWith(expect.objectContaining({ constraints }));
			else expect(mocks.transfer).not.toHaveBeenCalled();
		},
	);
	it("submits the immutable stored identity, then immediately consumes a final whole-video ALLOW", async () => {
		mocks.claimReview
			.mockResolvedValueOnce({
				status: "SUBMIT",
				token: "submit",
				asset: { ...asset, verificationProviderTaskId: null },
			})
			.mockResolvedValueOnce({ status: "QUERY", token: "query", asset });
		const safety = adapter({
			decision: "ALLOW",
			reasonCode: "NO_POLICY_MATCH",
			ruleVersion: "test",
			evidence: {
				requestId: "moderation-1",
				models: ["nudity"],
				operations: 1,
				scores: {},
				video: { complete: true, frameCount: 5, firstFrameSeconds: 0, lastFrameSeconds: 4.9 },
			},
		});
		expect(await reviewStoredVideo("job", { SEEAPI_API_KEY: "fixture" }, safety)).toEqual({
			status: "ALLOW",
		});
		expect(mocks.sign).toHaveBeenCalledWith(expect.objectContaining({ key: asset.objectKey }));
		expect(mocks.recordReview).toHaveBeenCalledWith(
			expect.objectContaining({
				checksum: asset.checksum,
				etag: asset.storageEtag,
				complete: true,
				decision: "ALLOW",
			}),
		);
		expect(safety.submitVideo).toHaveBeenCalledTimes(1);
		expect(safety.retrieveVideo).toHaveBeenCalledTimes(1);
		expect(mocks.claimReview).toHaveBeenCalledTimes(2);
		expect(mocks.beginSubmission.mock.invocationCallOrder[0]).toBeGreaterThan(
			mocks.sign.mock.invocationCallOrder[0]!,
		);
		expect(vi.mocked(safety.submitVideo).mock.invocationCallOrder[0]).toBeGreaterThan(
			mocks.beginSubmission.mock.invocationCallOrder[0]!,
		);
	});
	it("sends actual output duration to NSFW review even when it differs from the requested length", async () => {
		const inputSnapshot = {
			duration: 5,
			visualSafetyProfile: createVideoVisualSafetyProfile("seeapi", 5),
			audioSafetyPolicy: { schemaVersion: 1, mode: "not_requested" },
		};
		setReviewContext({
			inputSnapshot,
			videoExecution: { stageData: { outputSpec: { audioTracks: 1, audioTrackIds: [2] } } },
			assets: [{ asset: { ...asset, durationMillis: 6000n } }],
		});
		mocks.inspect.mockResolvedValue({ ...object, durationMillis: 6000 });
		mocks.claimReview
			.mockResolvedValueOnce({
				status: "SUBMIT",
				token: "submit",
				asset: { ...asset, verificationProviderTaskId: null },
			})
			.mockResolvedValueOnce({ status: "QUERY", token: "query", asset });
		const safety = adapter({
			decision: "REVIEW",
			reasonCode: "VIDEO_PROCESSING",
			ruleVersion: "test",
		});
		await reviewStoredVideo("job", { SEEAPI_API_KEY: "fixture" }, safety);
		expect(safety.submitVideo).toHaveBeenCalledWith(
			expect.objectContaining({ video: { durationMillis: 6000, audioTrackIds: [2] } }),
		);
		expect(safety.retrieveVideo).toHaveBeenCalledWith(
			expect.objectContaining({ video: { durationMillis: 6000, audioTrackIds: [2] } }),
		);
	});
	it("retries a local inspection failure before acquiring the paid moderation fence", async () => {
		mocks.claimReview.mockResolvedValue({ status: "SUBMIT", token: "submit", asset });
		mocks.inspect.mockRejectedValueOnce(new Error("R2_UNAVAILABLE"));
		const safety = adapter({
			decision: "REVIEW",
			reasonCode: "VIDEO_PROCESSING",
			ruleVersion: "test",
		});
		await expect(reviewStoredVideo("job", { SEEAPI_API_KEY: "fixture" }, safety)).rejects.toThrow(
			"R2_UNAVAILABLE",
		);
		expect(mocks.releaseReview).toHaveBeenCalledWith(asset.id, "submit");
		expect(mocks.beginSubmission).not.toHaveBeenCalled();
		expect(safety.submitVideo).not.toHaveBeenCalled();
		expect(mocks.needsReview).not.toHaveBeenCalled();
	});
	it("never sends moderation when the durable submission fence could not be confirmed", async () => {
		mocks.claimReview.mockResolvedValue({ status: "SUBMIT", token: "submit", asset });
		mocks.beginSubmission.mockRejectedValueOnce(new Error("DB_RESPONSE_LOST"));
		const safety = adapter({
			decision: "ALLOW",
			reasonCode: "NO_POLICY_MATCH",
			ruleVersion: "test",
		});
		await expect(reviewStoredVideo("job", { SEEAPI_API_KEY: "fixture" }, safety)).rejects.toThrow(
			"DB_RESPONSE_LOST",
		);
		expect(safety.submitVideo).not.toHaveBeenCalled();
	});
	it("nonterminal confirmation and missing terminal coverage fail closed", async () => {
		expect(
			(
				await reviewStoredVideo(
					"job",
					{},
					adapter({ decision: "REVIEW", reasonCode: "VIDEO_PROCESSING", ruleVersion: "test" }),
				)
			).status,
		).toBe("ERROR");
		expect(
			(
				await reviewStoredVideo(
					"job",
					{},
					adapter({ decision: "ALLOW", reasonCode: "NO_POLICY_MATCH", ruleVersion: "test" }),
				)
			).status,
		).toBe("ERROR");
		expect(mocks.recordReview).not.toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
	});
	it("moderation uncertainty never re-submits or releases user credits", async () => {
		mocks.claimReview.mockResolvedValue({ status: "UNCERTAIN", token: null, asset });
		const safety = adapter({
			decision: "ALLOW",
			reasonCode: "NO_POLICY_MATCH",
			ruleVersion: "test",
		});
		expect(await reviewStoredVideo("job", { SEEAPI_API_KEY: "fixture" }, safety)).toMatchObject({
			status: "ERROR",
			retryable: false,
		});
		expect(mocks.needsReview).toHaveBeenCalledWith("job", "VIDEO_MODERATION_SUBMISSION_UNCERTAIN");
		expect(safety.submitVideo).not.toHaveBeenCalled();
		expect(mocks.fail).not.toHaveBeenCalled();
	});
	it("content rejection is persisted against sealed bytes then releases once", async () => {
		expect(
			await reviewStoredVideo(
				"job",
				{},
				adapter({ decision: "REJECT", reasonCode: "SEXUAL_CONTENT", ruleVersion: "test" }),
			),
		).toEqual({ status: "REJECT", reasonCode: "SEXUAL_CONTENT" });
		expect(mocks.recordReview).toHaveBeenCalledWith(
			expect.objectContaining({ checksum: asset.checksum, decision: "REJECT" }),
		);
		expect(mocks.fail).toHaveBeenCalledWith("job", "SEXUAL_CONTENT", true);
	});
	it("parks a completed SeeAPI REVIEW without labeling it a definite rejection or releasing credits", async () => {
		const visualSafetyProfile = createVideoVisualSafetyProfile("seeapi", 5);
		setReviewContext({
			inputSnapshot: { duration: 5, visualSafetyProfile },
			videoExecution: { stageData: { outputSpec: { audioTracks: 0 } } },
			assets: [{ asset: { ...asset, durationMillis: 5000n } }],
		});
		const safety = adapter({
			decision: "REVIEW",
			reasonCode: "SEEAPI_CONTENT_REVIEW",
			ruleVersion: visualSafetyProfile.ruleVersion,
		});
		expect(
			await reviewStoredVideo("job", { VIDEO_V1_VIDEO_SAFETY_ADAPTER: "sightengine" }, safety),
		).toMatchObject({ status: "ERROR", reasonCode: "SEEAPI_CONTENT_REVIEW", retryable: false });
		expect(safety.retrieveVideo).toHaveBeenCalledWith(
			expect.objectContaining({
				visualSafetyProfile,
				ruleVersion: visualSafetyProfile.ruleVersion,
			}),
		);
		expect(mocks.needsReview).toHaveBeenCalledWith("job", "SEEAPI_CONTENT_REVIEW");
		expect(mocks.recordReview).not.toHaveBeenCalled();
		expect(mocks.fail).not.toHaveBeenCalled();
	});
	it("holds a historical Sightengine task without calling either provider or changing its snapshot", async () => {
		setReviewContext({
			inputSnapshot: { duration: 5 },
			videoExecution: { stageData: { outputSpec: { audioTracks: 0 } } },
			assets: [{ asset: { ...asset, durationMillis: 5000n } }],
		});
		const safety = adapter({
			decision: "REVIEW",
			reasonCode: "VIDEO_PROCESSING",
			ruleVersion: "test",
		});
		expect(
			await reviewStoredVideo("job", { VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi" }, safety),
		).toEqual({ status: "ERROR", reasonCode: "MODERATION_PROVIDER_RETIRED", retryable: false });
		expect(safety.retrieveVideo).not.toHaveBeenCalled();
		expect(safety.submitVideo).not.toHaveBeenCalled();
		expect(mocks.needsReview).toHaveBeenCalledWith("job", "MODERATION_PROVIDER_RETIRED");
	});
	it("sends one SeeAPI POST then waits for a persisted callback without a timed query", async () => {
		const profile = createVideoVisualSafetyProfile("seeapi", 5);
		setReviewContext({
			inputSnapshot: { duration: 5, visualSafetyProfile: profile },
			videoExecution: { stageData: { outputSpec: { audioTracks: 0 } } },
			assets: [{ asset: { ...asset, durationMillis: 5000n } }],
		});
		mocks.claimReview.mockResolvedValueOnce({
			status: "SUBMIT",
			token: "submit",
			asset: { ...asset, verificationProviderTaskId: null },
		});
		mocks.seeapiClaim.mockResolvedValue({ status: "WAITING" });
		const safety = adapter({
			decision: "REVIEW",
			reasonCode: "VIDEO_PROCESSING",
			ruleVersion: profile.ruleVersion,
		});
		expect(await reviewStoredVideo("job", { SEEAPI_API_KEY: "fixture" }, safety)).toMatchObject({
			status: "PENDING",
			waitFor: "callback",
		});
		expect(safety.submitVideo).toHaveBeenCalledTimes(1);
		expect(safety.submitVideo).toHaveBeenCalledWith(
			expect.objectContaining({ callbackUrl: expect.stringContaining("proof=server-proof") }),
		);
		expect(safety.retrieveVideo).not.toHaveBeenCalled();
		expect(mocks.seeapiRecord).not.toHaveBeenCalled();
		expect(mocks.callbackUrl.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.beginSubmission.mock.invocationCallOrder[0]!,
		);
	});
	it.each(["processing", "error", "invalid"])(
		"consumes at most one confirmation GET for %s and parks without polling",
		async (outcome) => {
			const profile = createVideoVisualSafetyProfile("seeapi", 5);
			setReviewContext({
				inputSnapshot: { duration: 5, visualSafetyProfile: profile },
				videoExecution: { stageData: { outputSpec: { audioTracks: 0 } } },
				assets: [{ asset: { ...asset, durationMillis: 5000n } }],
			});
			const decision = {
				decision: outcome === "processing" ? ("REVIEW" as const) : ("ERROR" as const),
				reasonCode:
					outcome === "processing"
						? "VIDEO_PROCESSING"
						: outcome === "invalid"
							? "MODERATION_INVALID_RESPONSE"
							: "MODERATION_UNAVAILABLE",
				ruleVersion: profile.ruleVersion,
			};
			const safety = adapter(decision);
			expect(await reviewStoredVideo("job", { SEEAPI_API_KEY: "fixture" }, safety)).toMatchObject({
				status: "ERROR",
				retryable: false,
			});
			mocks.seeapiClaim.mockResolvedValue({ status: "CONSUMED", eventId: "event", decision });
			expect(await reviewStoredVideo("job", { SEEAPI_API_KEY: "fixture" }, safety)).toMatchObject({
				status: "ERROR",
				retryable: false,
			});
			expect(safety.retrieveVideo).toHaveBeenCalledTimes(1);
			expect(safety.submitVideo).not.toHaveBeenCalled();
			expect(mocks.needsReview).toHaveBeenCalled();
		},
	);
	it("uses persisted 1s/3s confirmation retries and holds after three transient GET failures", async () => {
		const profile = createVideoVisualSafetyProfile("seeapi", 5);
		setReviewContext({
			inputSnapshot: { duration: 5, visualSafetyProfile: profile },
			videoExecution: { stageData: { outputSpec: { audioTracks: 0 } } },
			assets: [{ asset: { ...asset, durationMillis: 5000n } }],
		});
		const decision: ModerationDecision = {
			decision: "ERROR",
			reasonCode: "MODERATION_SERVICE_ERROR",
			ruleVersion: profile.ruleVersion,
		};
		const safety = adapter(decision);
		mocks.seeapiRecord
			.mockResolvedValueOnce({
				status: "RETRY",
				nextRetryAt: new Date(Date.now() + 1000).toISOString(),
				readAttemptCount: 1,
			})
			.mockResolvedValueOnce({
				status: "RETRY",
				nextRetryAt: new Date(Date.now() + 3000).toISOString(),
				readAttemptCount: 2,
			});
		expect(await reviewStoredVideo("job", { SEEAPI_API_KEY: "fixture" }, safety)).toMatchObject({
			status: "PENDING",
			waitFor: "confirmation-retry",
			retryAfterSeconds: 1,
		});
		expect(await reviewStoredVideo("job", { SEEAPI_API_KEY: "fixture" }, safety)).toMatchObject({
			status: "PENDING",
			waitFor: "confirmation-retry",
			retryAfterSeconds: 3,
		});
		expect(mocks.needsReview).not.toHaveBeenCalled();
		expect(await reviewStoredVideo("job", { SEEAPI_API_KEY: "fixture" }, safety)).toMatchObject({
			status: "ERROR",
			retryable: false,
		});
		mocks.seeapiClaim.mockResolvedValue({ status: "CONSUMED", eventId: "event", decision });
		await reviewStoredVideo("job", { SEEAPI_API_KEY: "fixture" }, safety);
		expect(safety.retrieveVideo).toHaveBeenCalledTimes(3);
		expect(safety.submitVideo).not.toHaveBeenCalled();
	});
	it("persists thrown timeout and waits through an active read lease without an extra GET", async () => {
		const profile = createVideoVisualSafetyProfile("seeapi", 5);
		setReviewContext({
			inputSnapshot: { duration: 5, visualSafetyProfile: profile },
			videoExecution: { stageData: { outputSpec: { audioTracks: 0 } } },
			assets: [{ asset: { ...asset, durationMillis: 5000n } }],
		});
		const safety = adapter({
			decision: "ERROR",
			reasonCode: "unused",
			ruleVersion: profile.ruleVersion,
		});
		vi.mocked(safety.retrieveVideo).mockRejectedValueOnce(
			new DOMException("timed out", "TimeoutError"),
		);
		const nextRetryAt = new Date(Date.now() + 1000).toISOString();
		mocks.seeapiRecord.mockResolvedValue({ status: "RETRY", nextRetryAt, readAttemptCount: 1 });
		expect(await reviewStoredVideo("job", { SEEAPI_API_KEY: "fixture" }, safety)).toMatchObject({
			status: "PENDING",
			waitFor: "confirmation-retry",
			nextRetryAt,
		});
		expect(mocks.seeapiRecord).toHaveBeenCalledWith(
			expect.objectContaining({
				decision: {
					decision: "ERROR",
					reasonCode: "MODERATION_TIMEOUT",
					ruleVersion: profile.ruleVersion,
				},
			}),
		);
		mocks.seeapiClaim.mockResolvedValue({ status: "RETRY", nextRetryAt, readAttemptCount: 1 });
		await reviewStoredVideo("job", { SEEAPI_API_KEY: "fixture" }, safety);
		expect(safety.retrieveVideo).toHaveBeenCalledTimes(1);
		expect(mocks.needsReview).not.toHaveBeenCalled();
	});
	it("preserves native audio under the explicit policy without calling audio review or inventing evidence", async () => {
		const profile = createVideoVisualSafetyProfile("seeapi", 5);
		setReviewContext({
			inputSnapshot: {
				productKey: "video-kling-3",
				duration: 5,
				sound: true,
				resolution: "720p",
				aspectRatio: "16:9",
				visualSafetyProfile: profile,
				audioSafetyPolicy: { schemaVersion: 1, mode: "not_requested" },
			},
			videoExecution: { stageData: { outputSpec: { audioTracks: 1, audioTrackIds: [2] } } },
			assets: [{ asset: { ...asset, durationMillis: 5000n } }],
		});
		const safety = adapter({
			decision: "ALLOW",
			reasonCode: "NO_POLICY_MATCH",
			ruleVersion: profile.ruleVersion,
			evidence: {
				requestId: "moderation-1",
				models: ["video-nsfw-filter"],
				operations: 1,
				scores: {},
				video: {
					complete: true,
					durationMillis: 5000,
					frameCount: 8,
					firstFrameSeconds: 0,
					lastFrameSeconds: 4.9,
				},
			},
		});
		expect(await reviewStoredVideo("job", {}, safety)).toEqual({ status: "ALLOW" });
		expect(mocks.recordReview.mock.calls[0]?.[0].evidence.audio).toBeUndefined();
	});
	it("holds a historical required-audio task without silently changing its frozen policy", async () => {
		const profile = createVideoVisualSafetyProfile("seeapi", 5);
		setReviewContext({
			inputSnapshot: {
				productKey: "video-kling-3",
				duration: 5,
				sound: true,
				resolution: "720p",
				aspectRatio: "16:9",
				visualSafetyProfile: profile,
			},
			videoExecution: { stageData: { outputSpec: { audioTracks: 1, audioTrackIds: [2] } } },
			assets: [{ asset: { ...asset, durationMillis: 5000n } }],
		});
		const safety = adapter({
			decision: "ALLOW",
			reasonCode: "NO_POLICY_MATCH",
			ruleVersion: profile.ruleVersion,
		});
		expect(await reviewStoredVideo("job", {}, safety)).toEqual({
			status: "ERROR",
			reasonCode: "VIDEO_AUDIO_REVIEW_NOT_ENABLED",
			retryable: false,
		});
		expect(safety.submitVideo).not.toHaveBeenCalled();
		expect(safety.retrieveVideo).not.toHaveBeenCalled();
		expect(mocks.recordReview).not.toHaveBeenCalled();
	});
	it.each([
		{ durationMillis: 30_001, byteSize: 1000n },
		{ durationMillis: 30_000, byteSize: 100_000_001n },
	])(
		"fails SeeAPI byte/duration preflight before acquiring the paid-send fence",
		async ({ durationMillis, byteSize }) => {
			const visualSafetyProfile = createVideoVisualSafetyProfile("seeapi", 30);
			setReviewContext({
				inputSnapshot: {
					productKey: "video-minimax-h3",
					duration: 30,
					resolution: "1080p",
					aspectRatio: "16:9",
					sound: false,
					visualSafetyProfile,
				},
				videoExecution: { stageData: { outputSpec: { audioTracks: 0 } } },
				assets: [{ asset: { ...asset, durationMillis: BigInt(durationMillis), byteSize } }],
			});
			mocks.claimReview.mockResolvedValue({
				status: "SUBMIT",
				token: "submit",
				asset: { ...asset, byteSize, verificationProviderTaskId: null },
			});
			const safety = adapter({
				decision: "ALLOW",
				reasonCode: "NO_POLICY_MATCH",
				ruleVersion: visualSafetyProfile.ruleVersion,
			});
			expect(await reviewStoredVideo("job", { SEEAPI_API_KEY: "fixture" }, safety)).toMatchObject({
				status: "ERROR",
				reasonCode: "VIDEO_SEEAPI_INPUT_LIMIT_EXCEEDED",
				retryable: false,
			});
			expect(mocks.beginSubmission).not.toHaveBeenCalled();
			expect(mocks.inspect).not.toHaveBeenCalled();
			expect(safety.submitVideo).not.toHaveBeenCalled();
		},
	);
});
