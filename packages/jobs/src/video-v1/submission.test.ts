import {
	buildKieVideoModelRequest,
	type KieVideoModelInput,
} from "@repo/ai/media/providers/kie-video-models";
import { buildKieVideoV1Request } from "@repo/ai/media/providers/kie-video-v1";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { VIDEO_V1_RULE_VERSION } from "@repo/config/video-v1";
import { describe, expect, it, vi } from "vitest";

import {
	confirmVideoProviderResult,
	reviewVideoInput,
	submitVideoAttempt,
	type VideoSubmissionDependencies,
} from "./submission";

vi.mock("@repo/database/video-v1-execution", () => ({}));
vi.mock("@repo/storage", () => ({ createSignedReadUrl: vi.fn() }));

function fixture(mode: "text-to-video" | "image-to-video" = "text-to-video") {
	const now = new Date("2026-10-04T00:00:00Z");
	const attempt: {
		id: string;
		providerTaskId: string | null;
		providerModelId: string;
		status: string;
	}[] = [];
	const stageData: Record<string, unknown> = {};
	const job = {
		id: "job-1",
		createdAt: now,
		failureCode: null,
		inputSnapshot: {
			textSafetyProfile: createVideoTextSafetyProfile(),
			mode,
			prompt: "A red balloon",
			duration: 5,
			sound: false,
			aspectRatio: "16:9",
			requestFingerprint: "fingerprint",
			inputIdentity:
				mode === "image-to-video"
					? { objectKey: "sealed/input", checksum: "sha256", assetId: "input-1" }
					: null,
		},
		attempts: attempt,
		videoExecution: {
			stage: "QUEUED",
			inputReviewStartedAt: null,
			providerSubmitStartedAt: now,
			stageData,
		},
	};
	const store = {
		getVideoExecutionContext: vi.fn(async () => job),
		assertVideoInputIdentity: vi.fn(),
		recordVideoInputReview: vi.fn(async (_jobId: string, patch: Record<string, unknown>) => {
			stageData.inputReview = {
				...((stageData.inputReview as Record<string, unknown>) ?? {}),
				...patch,
			};
		}),
		claimVideoImageReview: vi.fn(async () => true),
		claimVideoProviderSubmission: vi.fn(async (input: { providerModelId: string }) => {
			if (attempt[0]) return { claimed: false, attempt: attempt[0] };
			attempt.push({
				id: "attempt-1",
				providerTaskId: null,
				status: "SUBMISSION_UNCERTAIN",
				providerModelId: input.providerModelId,
			});
			return { claimed: true, attempt: attempt[0] };
		}),
		recordVideoSubmissionAccepted: vi.fn(
			async (_jobId: string, _attemptId: string, taskId: string) => {
				attempt[0]!.providerTaskId = taskId;
			},
		),
		markVideoSubmissionUncertain: vi.fn(async () => undefined),
		failVideoExecution: vi.fn(async () => true),
		recordVideoProviderSuccess: vi.fn(async () => undefined),
		consumeVideoProviderEvents: vi.fn(async () => undefined),
	};
	const allow = {
		decision: "ALLOW" as const,
		reasonCode: "SAFE",
		ruleVersion: VIDEO_V1_RULE_VERSION,
	};
	const provider = {
		submit: vi.fn<VideoSubmissionDependencies["provider"]["submit"]>(async () => ({
			status: "ACCEPTED" as const,
			providerTaskId: "task-1",
		})),
		retrieve: vi.fn<VideoSubmissionDependencies["provider"]["retrieve"]>(async () => ({
			status: "PENDING" as const,
		})),
	};
	const safety = {
		moderateText: vi.fn(async () => allow),
		moderateImage: vi.fn(async () => allow),
		submitVideo: vi.fn(),
		retrieveVideo: vi.fn(),
	};
	const textAllow = {
		decision: "ALLOW" as const,
		reasonCode: "WAFFO_PROMPT_ALLOWED",
		ruleVersion: createVideoTextSafetyProfile().ruleVersion,
		evidence: {
			requestId: "waffo-request-1",
			models: ["waffo-prompt-sift"],
			operations: 1,
			scores: {},
			waffo: {
				requestId: "waffo-request-1",
				action: "allow" as const,
				semanticStatus: "scored",
				matchedCategories: [],
			},
		},
	};
	const moderateText = vi.fn(async () => textAllow);
	const deps = {
		store,
		provider,
		safety,
		moderateText,
		signRead: vi.fn(async () => "https://private.example/sealed-input"),
		now: () => now,
		env: {
			KIE_API_KEY: "test-only",
			KIE_WEBHOOK_SECRET: "test-only-secret",
			VIDEO_V1_CALLBACK_BASE_URL: "https://example.test",
		},
	} as unknown as VideoSubmissionDependencies;
	return { deps, job, store, provider, safety, allow, textAllow, moderateText, attempt };
}

describe("video V1 paid submission fence", () => {
	it("preserves the exact legacy no-productKey Kling 2.6 request", async () => {
		const f = fixture();
		await submitVideoAttempt("job-1", f.deps);
		const submitted = f.provider.submit.mock.calls[0]![0];
		expect(submitted).not.toHaveProperty("productKey");
		expect(buildKieVideoV1Request(submitted)).toEqual({
			model: "kling-2.6/text-to-video",
			callBackUrl: expect.any(String),
			input: { prompt: "A red balloon", duration: "5", sound: false, aspect_ratio: "16:9" },
		});
	});
	it.each([
		["text-to-video", "video-seedance-2", 8, "1080p", "16:9", true, "bytedance/seedance-2"],
		["image-to-video", "video-minimax-h3", 10, "768p", "source", true, "minimax-h3/image-to-video"],
	] as const)(
		"builds the persisted %s model contract before fencing one paid request",
		async (mode, productKey, duration, resolution, aspectRatio, sound, providerModelId) => {
			const f = fixture(mode);
			Object.assign(f.job.inputSnapshot, {
				productKey,
				duration,
				resolution,
				aspectRatio,
				sound,
				...(mode === "image-to-video" ? { inputAssetId: "input-1" } : {}),
			});
			await submitVideoAttempt("job-1", f.deps);
			const submitted = f.provider.submit.mock.calls[0]![0];
			expect(submitted).toMatchObject({ productKey, duration, resolution, aspectRatio, sound });
			expect(buildKieVideoModelRequest(submitted as KieVideoModelInput)).toMatchObject({
				model: providerModelId,
			});
			expect(f.store.claimVideoProviderSubmission).toHaveBeenCalledWith(
				expect.objectContaining({ providerModelId }),
			);
			expect(f.store.claimVideoProviderSubmission.mock.invocationCallOrder[0]).toBeLessThan(
				f.provider.submit.mock.invocationCallOrder[0]!,
			);
		},
	);
	it.each([
		{ duration: 10 }, // Legacy requests stay fixed at five seconds.
		{ productKey: "unknown", resolution: "720p" },
		{ productKey: "video-seedance-2", duration: 99, resolution: "720p" },
		{ productKey: "video-minimax-h3-turbo", duration: 5, resolution: "768p", sound: true },
	])("rejects invalid persisted input before claim or paid call: %j", async (patch) => {
		const f = fixture();
		Object.assign(f.job.inputSnapshot, patch);
		await expect(submitVideoAttempt("job-1", f.deps)).rejects.toThrow();
		expect(f.store.claimVideoProviderSubmission).not.toHaveBeenCalled();
		expect(f.provider.submit).not.toHaveBeenCalled();
	});
	it("rejects an invalid signed input URL before the irreversible send fence", async () => {
		const f = fixture("image-to-video");
		f.deps.signRead = vi.fn(async () => "http://private.example/unsealed");
		await expect(submitVideoAttempt("job-1", f.deps)).rejects.toThrow();
		expect(f.store.claimVideoProviderSubmission).not.toHaveBeenCalled();
		expect(f.provider.submit).not.toHaveBeenCalled();
	});
	it("dispatches the selected persisted model through the real adapter with one mocked HTTP send", async () => {
		const f = fixture();
		Object.assign(f.job.inputSnapshot, {
			productKey: "video-seedance-2",
			duration: 8,
			resolution: "1080p",
			sound: true,
		});
		const overrides: Partial<VideoSubmissionDependencies> = { ...f.deps };
		delete overrides.provider;
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ code: 200, data: { taskId: "real-adapter-mock-task" } })),
			);
		try {
			expect(await submitVideoAttempt("job-1", overrides)).toMatchObject({
				status: "ACCEPTED",
				providerTaskId: "real-adapter-mock-task",
			});
			expect(fetch).toHaveBeenCalledTimes(1);
			const [url, options] = fetch.mock.calls[0]!;
			expect(url).toBe("https://api.kie.ai/api/v1/jobs/createTask");
			if (typeof options?.body !== "string") throw new Error("Expected JSON request body");
			expect(JSON.parse(options.body)).toMatchObject({
				model: "bytedance/seedance-2",
				input: { duration: 8, generate_audio: true, resolution: "1080p" },
			});
			expect(f.attempt[0]!.providerModelId).toBe("bytedance/seedance-2");
		} finally {
			fetch.mockRestore();
		}
	});
	it("a replay after accepted taskId persistence fails never submits a second paid request", async () => {
		const f = fixture();
		f.store.recordVideoSubmissionAccepted.mockRejectedValueOnce(new Error("database disconnected"));
		expect(await submitVideoAttempt("job-1", f.deps)).toMatchObject({
			status: "UNCERTAIN",
			attemptId: "attempt-1",
		});
		expect(await submitVideoAttempt("job-1", f.deps)).toMatchObject({
			status: "UNCERTAIN",
			attemptId: "attempt-1",
		});
		expect(f.provider.submit).toHaveBeenCalledTimes(1);
		expect(f.store.claimVideoProviderSubmission).toHaveBeenCalledTimes(1);
		expect(f.store.failVideoExecution).not.toHaveBeenCalled();
	});
	it("simultaneous replays share the durable claim and one paid call", async () => {
		const f = fixture();
		await Promise.all(Array.from({ length: 20 }, () => submitVideoAttempt("job-1", f.deps)));
		expect(f.provider.submit).toHaveBeenCalledTimes(1);
		expect(f.attempt).toHaveLength(1);
	});
	it("a timeout keeps the same attempt and does not release credits", async () => {
		const f = fixture();
		f.provider.submit.mockRejectedValueOnce(new Error("network timeout"));
		await submitVideoAttempt("job-1", f.deps);
		await submitVideoAttempt("job-1", f.deps);
		expect(f.provider.submit).toHaveBeenCalledTimes(1);
		expect(f.store.markVideoSubmissionUncertain).toHaveBeenCalled();
		expect(f.store.failVideoExecution).not.toHaveBeenCalled();
	});
	it("does not send if the durable database claim fails", async () => {
		const f = fixture();
		f.store.claimVideoProviderSubmission.mockRejectedValueOnce(new Error("claim rolled back"));
		await expect(submitVideoAttempt("job-1", f.deps)).rejects.toThrow("claim rolled back");
		expect(f.provider.submit).not.toHaveBeenCalled();
	});
	it("generates a secret callback token but stores only its hash", async () => {
		const f = fixture();
		await submitVideoAttempt("job-1", f.deps);
		const callback = (f.provider.submit.mock.calls[0] as unknown as [{ callbackUrl: string }])[0]
			.callbackUrl;
		const hash = (
			f.store.claimVideoProviderSubmission.mock.calls[0] as unknown as [
				{ callbackTokenHash: string },
			]
		)[0].callbackTokenHash;
		expect(callback.split("/").at(-1)).toMatch(/^[a-f0-9]{64}$/);
		expect(callback).not.toContain(hash);
	});
});

describe("input moderation", () => {
	it("consumes synchronous input moderation and submits immediately without a polling delay", async () => {
		const f = fixture("image-to-video");
		const retrieveImage = vi.fn();
		f.deps.safety = {
			...f.safety,
			submitImage: vi.fn(async () => ({
				moderationTaskId: "review-1",
				status: "RUNNING" as const,
				ruleVersion: VIDEO_V1_RULE_VERSION,
				idempotency: { key: "test", providerSupported: false, replayed: false },
				completedDecision: f.allow,
			})),
			retrieveImage,
		};
		expect(await reviewVideoInput("job-1", f.deps)).toEqual({ status: "ALLOW" });
		expect(retrieveImage).not.toHaveBeenCalled();
		expect(await submitVideoAttempt("job-1", f.deps)).toMatchObject({ status: "ACCEPTED" });
		expect(f.provider.submit).toHaveBeenCalledTimes(1);
	});
	it("does not resubmit asynchronous image review on subsequent pending checks", async () => {
		const f = fixture("image-to-video");
		const submitImage = vi.fn(async () => ({
			moderationTaskId: "review-1",
			status: "RUNNING" as const,
			ruleVersion: VIDEO_V1_RULE_VERSION,
			idempotency: { key: "test", providerSupported: false, replayed: false },
		}));
		const retrieveImage = vi
			.fn()
			.mockResolvedValueOnce({
				decision: "REVIEW",
				reasonCode: "IMAGE_PROCESSING",
				ruleVersion: VIDEO_V1_RULE_VERSION,
			})
			.mockResolvedValueOnce(f.allow);
		f.deps.safety = { ...f.safety, submitImage, retrieveImage };
		expect(await reviewVideoInput("job-1", f.deps)).toMatchObject({ status: "PENDING" });
		expect(await reviewVideoInput("job-1", f.deps)).toEqual({ status: "ALLOW" });
		expect(submitImage).toHaveBeenCalledTimes(1);
		expect(retrieveImage).toHaveBeenCalledTimes(2);
	});
	it("never treats unavailable text review as approval", async () => {
		const f = fixture();
		f.deps.moderateText = vi.fn(async () => ({
			decision: "ERROR" as const,
			reasonCode: "NOT_CONFIGURED",
			ruleVersion: createVideoTextSafetyProfile().ruleVersion,
		}));
		expect(await reviewVideoInput("job-1", f.deps)).toMatchObject({
			status: "ERROR",
			reasonCode: "NOT_CONFIGURED",
		});
		expect(f.provider.submit).not.toHaveBeenCalled();
	});
	it("rejects a changed immutable asset before moderation or submission", async () => {
		const f = fixture("image-to-video");
		f.store.assertVideoInputIdentity.mockImplementationOnce(() => {
			throw new Error("identity changed");
		});
		expect(await reviewVideoInput("job-1", f.deps)).toMatchObject({
			status: "REJECT",
			reasonCode: "VIDEO_INPUT_IDENTITY_CHANGED",
		});
		expect(f.moderateText).not.toHaveBeenCalled();
	});
	it("uses only the Waffo path and binds its actual rule to the persisted input", async () => {
		const f = fixture();
		expect(await reviewVideoInput("job-1", f.deps)).toEqual({ status: "ALLOW" });
		expect(f.moderateText).toHaveBeenCalledWith({
			text: "A red balloon",
			ruleVersion: createVideoTextSafetyProfile().ruleVersion,
		});
		expect(f.safety.moderateText).not.toHaveBeenCalled();
		expect(f.store.recordVideoInputReview).toHaveBeenLastCalledWith(
			"job-1",
			expect.objectContaining({
				status: "ALLOW",
				textSafetyProfile: createVideoTextSafetyProfile(),
			}),
		);
		expect(await reviewVideoInput("job-1", f.deps)).toEqual({ status: "ALLOW" });
		expect(f.moderateText).toHaveBeenCalledTimes(1);
	});
	it.each(["missing", "wrong-rule", "wrong-fingerprint", "expired"])(
		"does not reuse a %s cached approval",
		async (mutation) => {
			const f = fixture();
			await reviewVideoInput("job-1", f.deps);
			const review = f.job.videoExecution.stageData.inputReview as Record<string, unknown>;
			if (mutation === "missing") delete review.textSafetyProfile;
			if (mutation === "wrong-rule")
				review.textSafetyProfile = { ...createVideoTextSafetyProfile(), ruleVersion: "old-rule" };
			if (mutation === "wrong-fingerprint") review.requestFingerprint = "other-prompt";
			if (mutation === "expired") review.validUntil = "2026-10-03T00:00:00Z";
			expect(await reviewVideoInput("job-1", f.deps)).toEqual({ status: "ALLOW" });
			expect(f.moderateText).toHaveBeenCalledTimes(2);
		},
	);
	it("does not create new paid work for historical input without a text profile", async () => {
		const f = fixture();
		delete (f.job.inputSnapshot as { textSafetyProfile?: unknown }).textSafetyProfile;
		expect(await reviewVideoInput("job-1", f.deps)).toMatchObject({
			status: "ERROR",
			reasonCode: "VIDEO_TEXT_SAFETY_PROFILE_INVALID",
		});
		await expect(submitVideoAttempt("job-1", f.deps)).rejects.toThrow(
			"VIDEO_TEXT_SAFETY_PROFILE_INVALID",
		);
		expect(f.moderateText).not.toHaveBeenCalled();
		expect(f.store.claimVideoProviderSubmission).not.toHaveBeenCalled();
		expect(f.provider.submit).not.toHaveBeenCalled();
	});
	it("preserves historical accepted attempts without reinterpreting text evidence", async () => {
		const f = fixture();
		delete (f.job.inputSnapshot as { textSafetyProfile?: unknown }).textSafetyProfile;
		f.attempt.push({
			id: "old-attempt",
			providerTaskId: "old-task",
			providerModelId: "kling-2.6/text-to-video",
			status: "SUBMITTED",
		});
		expect(await reviewVideoInput("job-1", f.deps)).toEqual({ status: "ALLOW" });
		expect(await submitVideoAttempt("job-1", f.deps)).toEqual({
			status: "ACCEPTED",
			attemptId: "old-attempt",
			providerTaskId: "old-task",
		});
		expect(f.moderateText).not.toHaveBeenCalled();
		expect(f.provider.submit).not.toHaveBeenCalled();
	});
	it("rejects an ALLOW-shaped decision without the full enforced Waffo evidence", async () => {
		const f = fixture();
		f.deps.moderateText = vi.fn(async () => ({
			...f.allow,
			ruleVersion: createVideoTextSafetyProfile().ruleVersion,
		}));
		expect(await reviewVideoInput("job-1", f.deps)).toMatchObject({
			status: "ERROR",
			reasonCode: "VIDEO_TEXT_REVIEW_INVALID",
		});
		expect(f.provider.submit).not.toHaveBeenCalled();
	});
});

describe("authoritative provider confirmation", () => {
	it("queries the same paid task and persists only authenticated output", async () => {
		const f = fixture();
		f.attempt.push({
			id: "attempt-1",
			providerTaskId: "task-1",
			status: "SUBMITTED",
			providerModelId: "kling-2.6/text-to-video",
		});
		const retrieve = vi.fn(async () => ({
			status: "SUCCEEDED" as const,
			outputUrl: "https://authoritative.example/video.mp4",
			providerCostMicros: null,
			providerCreditsConsumed: null,
			providerCompletedAt: null,
		}));
		f.deps.provider.retrieve = retrieve;
		expect(await confirmVideoProviderResult("job-1", f.deps)).toEqual({
			status: "SUCCEEDED",
			attemptId: "attempt-1",
		});
		expect(retrieve).toHaveBeenCalledWith("task-1");
		expect(f.store.recordVideoProviderSuccess).toHaveBeenCalledWith(
			expect.objectContaining({ outputUrl: "https://authoritative.example/video.mp4" }),
		);
		expect(f.provider.submit).not.toHaveBeenCalled();
	});
	it("keeps unknown submissions pending without querying invented task IDs or resending", async () => {
		const f = fixture();
		f.attempt.push({
			id: "attempt-1",
			providerTaskId: null,
			status: "SUBMISSION_UNCERTAIN",
			providerModelId: "kling-2.6/text-to-video",
		});
		expect(await confirmVideoProviderResult("job-1", f.deps)).toMatchObject({
			status: "PENDING",
			deadlineAt: "2026-10-04T00:30:00.000Z",
		});
		expect(f.provider.retrieve).not.toHaveBeenCalled();
		expect(f.provider.submit).not.toHaveBeenCalled();
		expect(f.store.failVideoExecution).not.toHaveBeenCalled();
	});
	it("retrieves using only the persisted product and matching provider model", async () => {
		const f = fixture();
		Object.assign(f.job.inputSnapshot, {
			productKey: "video-seedance-2",
			duration: 8,
			resolution: "1080p",
			sound: true,
		});
		await submitVideoAttempt("job-1", f.deps);
		expect(await confirmVideoProviderResult("job-1", f.deps)).toMatchObject({ status: "PENDING" });
		expect(f.provider.retrieve).toHaveBeenCalledWith("task-1", "video-seedance-2");
		f.attempt[0]!.providerModelId = "kling-2.6/text-to-video";
		f.provider.retrieve.mockClear();
		await expect(confirmVideoProviderResult("job-1", f.deps)).rejects.toThrow(
			"VIDEO_PROVIDER_MODEL_IDENTITY_MISMATCH",
		);
		expect(f.provider.retrieve).not.toHaveBeenCalled();
		expect(f.store.recordVideoProviderSuccess).not.toHaveBeenCalled();
		expect(f.store.failVideoExecution).not.toHaveBeenCalled();
	});
	it("an uncertain new-model submission never falls back to legacy Kling or resubmits", async () => {
		const f = fixture();
		Object.assign(f.job.inputSnapshot, {
			productKey: "video-seedance-2",
			duration: 8,
			resolution: "1080p",
			sound: true,
		});
		f.provider.submit.mockRejectedValueOnce(new Error("provider timeout"));
		expect(await submitVideoAttempt("job-1", f.deps)).toMatchObject({ status: "UNCERTAIN" });
		expect(await submitVideoAttempt("job-1", f.deps)).toMatchObject({ status: "UNCERTAIN" });
		expect(f.provider.submit).toHaveBeenCalledTimes(1);
		expect(f.attempt[0]!.providerModelId).toBe("bytedance/seedance-2");
		expect(f.store.failVideoExecution).not.toHaveBeenCalled();
	});
});
