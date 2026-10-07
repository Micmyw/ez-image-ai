import {
	buildKieSeedanceReferenceRequest,
	type KieSeedanceReferenceInput,
} from "@repo/ai/media/providers/kie-seedance-reference";
import {
	buildKieVideoModelRequest,
	type KieVideoModelInput,
} from "@repo/ai/media/providers/kie-video-models";
import { buildKieVideoV1Request } from "@repo/ai/media/providers/kie-video-v1";
import { createVideoEffectTemplateSnapshot } from "@repo/config/video-effects.server";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { submitVideoAttempt, type VideoSubmissionDependencies } from "./submission";

const adapters = vi.hoisted(() => ({
	referenceSubmit: vi.fn(),
	modelSubmit: vi.fn(),
	legacySubmit: vi.fn(),
	retrieve: vi.fn(),
	runtimeGate: vi.fn(),
}));

// Keep the real serializers while isolating every paid provider and database boundary.
vi.mock("@repo/ai/media/providers/kie-seedance-reference", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@repo/ai/media/providers/kie-seedance-reference")>();
	return {
		...actual,
		KieSeedanceReferenceAdapter: class {
			submit = adapters.referenceSubmit;
			retrieve = adapters.retrieve;
		},
	};
});
vi.mock("@repo/ai/media/providers/kie-video-models", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/ai/media/providers/kie-video-models")>();
	return {
		...actual,
		KieVideoModelsAdapter: class {
			submit = adapters.modelSubmit;
			retrieve = adapters.retrieve;
		},
	};
});
vi.mock("@repo/ai/media/providers/kie-video-v1", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/ai/media/providers/kie-video-v1")>();
	return {
		...actual,
		KieVideoV1Adapter: class {
			submit = adapters.legacySubmit;
			retrieve = adapters.retrieve;
		},
	};
});
vi.mock("@repo/database/video-v1-execution", () => ({}));
vi.mock("@repo/database/video-template-execution", () => ({
	getVideoEffectiveInputSnapshot: (job: { inputSnapshot: unknown }) => job.inputSnapshot,
}));
vi.mock("@repo/storage", () => ({ createSignedReadUrl: vi.fn() }));
vi.mock("./template-runtime-gates", () => ({
	requireVideoTemplateRuntimeEnabled: adapters.runtimeGate,
}));

const subjectKey = "sealed/fixture-subject.png";
const motionKey = "private/fixture-approved-motion.mp4";
const subjectUrl = "https://private.example/subject.png?signature=fixture-subject";
const motionUrl = "https://private.example/motion.mp4?signature=fixture-motion";

// Syntactic local fixtures only; these do not represent real asset or rights approval.
const motionReference = {
	assetId: "fixture-motion",
	ownerId: "fixture-admin",
	objectKey: motionKey,
	sha256: "a".repeat(64),
	etag: "fixture-etag",
	storageVersionId: null,
	bytes: 1024,
	mimeType: "video/mp4",
	durationSeconds: 5,
	width: 720,
	height: 1280,
	fps: 30,
	audioTrackCount: 0,
	version: "fixture-motion-v1",
	review: {
		decision: "ALLOW",
		policyVersion: "seeapi-video-policy-2026-10-04.1",
		decisionHash: "b".repeat(64),
		verificationGeneration: 1,
		validUntil: "2099-01-01T00:00:00Z",
	},
	rights: { approvalId: "fixture-rights", validUntil: "2099-01-01T00:00:00Z" },
};

function fixture(kind: "reference" | "model" | "legacy" | "legacy-template" = "reference") {
	const now = new Date("2026-10-07T00:00:00Z");
	const template =
		kind === "reference" || kind === "legacy-template"
			? createVideoEffectTemplateSnapshot(
					{
						effectId: kind === "reference" ? "rumpelstiltskin-solo" : "raindance-solo",
						presetKey: "standard",
						inputs: { leftAssetId: "fixture-subject", rightAssetId: "fixture-subject" },
					},
					{ RUMPELSTILTSKIN_APPROVED_MOTION_REFERENCE: JSON.stringify(motionReference) },
				)
			: undefined;
	const attempts: Array<{
		id: string;
		providerTaskId: string | null;
		providerModelId: string;
		status: string;
	}> = [];
	const inputSnapshot: Record<string, unknown> = {
		schemaVersion: 1,
		textSafetyProfile: createVideoTextSafetyProfile(),
		mode: "image-to-video",
		prompt: template?.video.prompt ?? "Animate the uploaded portrait gently.",
		duration: 5,
		sound: false,
		aspectRatio: "9:16",
		requestFingerprint: "fixture-fingerprint",
		inputIdentity: {
			assetId: "fixture-subject",
			objectKey: subjectKey,
			checksum: "c".repeat(64),
			storageEtag: "fixture-subject-etag",
			storageVersionId: null,
			verificationGeneration: 1,
		},
		...(kind === "legacy"
			? {}
			: {
					productKey: template?.video.productKey ?? "video-seedance-2",
					resolution: "720p",
					inputAssetId: "fixture-subject",
				}),
		...(template ? { videoEffectTemplate: template } : {}),
	};
	const job = {
		id: "fixture-job",
		status: "QUEUED",
		createdAt: now,
		inputSnapshot,
		attempts,
		videoExecution: { stage: "QUEUED", providerSubmitStartedAt: now, stageData: {} },
	};
	const store = {
		getVideoExecutionContext: vi.fn(async () => job),
		claimVideoProviderSubmission: vi.fn(async (input: { providerModelId: string }) => {
			if (attempts[0]) return { claimed: false, attempt: attempts[0] };
			attempts.push({
				id: "fixture-attempt",
				providerTaskId: null,
				providerModelId: input.providerModelId,
				status: "SUBMISSION_UNCERTAIN",
			});
			return { claimed: true, attempt: attempts[0] };
		}),
		recordVideoSubmissionAccepted: vi.fn(
			async (_jobId: string, _attemptId: string, taskId: string) => {
				attempts[0]!.providerTaskId = taskId;
			},
		),
		markVideoSubmissionUncertain: vi.fn(async () => undefined),
		failVideoExecution: vi.fn(async () => true),
	};
	const signRead = vi.fn(async (key: string) => {
		if (key === subjectKey) return subjectUrl;
		if (key === motionKey) return motionUrl;
		throw new Error("UNEXPECTED_OBJECT_KEY");
	});
	const deps = {
		store,
		signRead,
		now: () => now,
		safety: {},
		moderateText: vi.fn(),
		env: {
			KIE_API_KEY: "fixture-key",
			KIE_WEBHOOK_SECRET: "fixture-secret",
			VIDEO_V1_CALLBACK_BASE_URL: "https://app.example",
		} as Record<string, string | undefined>,
	} as unknown as Partial<VideoSubmissionDependencies>;
	return { deps, store, signRead, inputSnapshot, attempts, template };
}

beforeEach(() => {
	vi.clearAllMocks();
	for (const submit of [adapters.referenceSubmit, adapters.modelSubmit, adapters.legacySubmit]) {
		submit.mockReset().mockResolvedValue({ status: "ACCEPTED", providerTaskId: "fixture-task" });
	}
	adapters.runtimeGate.mockReset().mockResolvedValue(undefined);
});

describe("Rumpelstiltskin reference submission", () => {
	it("builds references from the sealed subject and approved motion and dispatches only Seedance reference", async () => {
		const f = fixture();
		await expect(submitVideoAttempt("fixture-job", f.deps)).resolves.toMatchObject({
			status: "ACCEPTED",
		});
		expect(f.signRead.mock.calls).toEqual([[subjectKey], [motionKey]]);
		expect(adapters.referenceSubmit).toHaveBeenCalledTimes(1);
		expect(adapters.modelSubmit).not.toHaveBeenCalled();
		expect(adapters.legacySubmit).not.toHaveBeenCalled();
		const input = adapters.referenceSubmit.mock.calls[0]![0] as KieSeedanceReferenceInput;
		expect(buildKieSeedanceReferenceRequest(input)).toEqual({
			model: "bytedance/seedance-2",
			callBackUrl: expect.stringMatching(
				/^https:\/\/app\.example\/api\/webhooks\/video\/kie\/[a-f0-9]{64}$/,
			),
			input: {
				prompt: f.template!.video.prompt,
				duration: 5,
				resolution: "720p",
				aspect_ratio: "9:16",
				reference_image_urls: [subjectUrl],
				reference_video_urls: [motionUrl],
				generate_audio: false,
				nsfw_checker: true,
				web_search: false,
				return_last_frame: false,
			},
		});
		expect(input).not.toHaveProperty("imageUrl");
		expect(input).not.toHaveProperty("first_frame_url");
		expect(f.store.claimVideoProviderSubmission).toHaveBeenCalledWith(
			expect.objectContaining({ providerModelId: "bytedance/seedance-2" }),
		);
		expect(f.store.claimVideoProviderSubmission.mock.invocationCallOrder[0]).toBeLessThan(
			adapters.referenceSubmit.mock.invocationCallOrder[0]!,
		);
	});

	it("signs the persisted motion key even when environment or untrusted snapshot URLs change", async () => {
		const f = fixture();
		f.deps.env!.RUMPELSTILTSKIN_APPROVED_MOTION_REFERENCE = JSON.stringify({
			objectKey: "private/new-motion.mp4",
		});
		Object.assign(f.inputSnapshot, {
			imageUrl: "https://untrusted.example/identity.png",
			motionUrl: "https://untrusted.example/motion.mp4",
			referenceVideoUrls: ["https://untrusted.example/reference.mp4"],
		});
		await submitVideoAttempt("fixture-job", f.deps);
		expect(f.signRead).toHaveBeenCalledWith(motionKey);
		expect(adapters.referenceSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				referenceImageUrls: [subjectUrl],
				referenceVideoUrls: [motionUrl],
			}),
		);
	});

	it.each(["uncertain-result", "lost-response"])(
		"preserves the fence after %s and does not retry or fall back",
		async (failure) => {
			const f = fixture();
			if (failure === "lost-response")
				adapters.referenceSubmit.mockRejectedValueOnce(new Error("timeout"));
			else
				adapters.referenceSubmit.mockResolvedValueOnce({
					status: "UNCERTAIN",
					reasonCode: "VIDEO_PROVIDER_SUBMISSION_UNCERTAIN",
				});
			await expect(submitVideoAttempt("fixture-job", f.deps)).resolves.toMatchObject({
				status: "UNCERTAIN",
			});
			await expect(submitVideoAttempt("fixture-job", f.deps)).resolves.toMatchObject({
				status: "UNCERTAIN",
			});
			expect(adapters.referenceSubmit).toHaveBeenCalledTimes(1);
			expect(adapters.modelSubmit).not.toHaveBeenCalled();
			expect(adapters.legacySubmit).not.toHaveBeenCalled();
			expect(f.store.claimVideoProviderSubmission).toHaveBeenCalledTimes(1);
			expect(f.store.markVideoSubmissionUncertain).toHaveBeenCalledTimes(1);
			expect(f.store.failVideoExecution).not.toHaveBeenCalled();
			expect(f.attempts[0]?.providerModelId).toBe("bytedance/seedance-2");
		},
	);

	it("fails motion signing before claiming permission to send", async () => {
		const f = fixture();
		f.signRead.mockImplementation(async (key) => {
			if (key === subjectKey) return subjectUrl;
			throw new Error("FIXTURE_SIGNING_UNAVAILABLE");
		});
		await expect(submitVideoAttempt("fixture-job", f.deps)).rejects.toThrow(
			"FIXTURE_SIGNING_UNAVAILABLE",
		);
		expect(f.store.claimVideoProviderSubmission).not.toHaveBeenCalled();
		expect(adapters.referenceSubmit).not.toHaveBeenCalled();
	});

	it("honors a disabled template before fencing a paid request", async () => {
		const f = fixture();
		adapters.runtimeGate.mockRejectedValueOnce(new Error("VIDEO_EFFECT_DISABLED"));
		await expect(submitVideoAttempt("fixture-job", f.deps)).rejects.toThrow(
			"VIDEO_EFFECT_DISABLED",
		);
		expect(f.store.claimVideoProviderSubmission).not.toHaveBeenCalled();
		expect(adapters.referenceSubmit).not.toHaveBeenCalled();
	});

	it("rejects missing subject identity before claiming submission", async () => {
		const f = fixture();
		f.inputSnapshot.inputIdentity = null;
		await expect(submitVideoAttempt("fixture-job", f.deps)).rejects.toThrow(
			"VIDEO_INPUT_IDENTITY_MISSING",
		);
		expect(f.store.claimVideoProviderSubmission).not.toHaveBeenCalled();
		expect(adapters.referenceSubmit).not.toHaveBeenCalled();
	});
});

describe("existing submission paths remain distinct", () => {
	it("preserves ordinary Seedance image-to-video as a first-frame request", async () => {
		const f = fixture("model");
		await submitVideoAttempt("fixture-job", f.deps);
		expect(adapters.modelSubmit).toHaveBeenCalledTimes(1);
		expect(adapters.referenceSubmit).not.toHaveBeenCalled();
		expect(f.signRead.mock.calls).toEqual([[subjectKey]]);
		const body = buildKieVideoModelRequest(
			adapters.modelSubmit.mock.calls[0]![0] as KieVideoModelInput,
		);
		expect(body).toMatchObject({
			model: "bytedance/seedance-2",
			input: { first_frame_url: subjectUrl },
		});
		expect(body).not.toHaveProperty("input.reference_video_urls");
	});

	it("keeps Raindance schema 1 on its scene image and Seedance 1.5 adapter", async () => {
		const f = fixture("legacy-template");
		await submitVideoAttempt("fixture-job", f.deps);
		expect(adapters.modelSubmit).toHaveBeenCalledTimes(1);
		expect(adapters.referenceSubmit).not.toHaveBeenCalled();
		expect(f.signRead.mock.calls).toEqual([[subjectKey]]);
		expect(adapters.modelSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				productKey: "video-seedance-1-5-pro",
				imageUrl: subjectUrl,
				templateFixedLens: true,
			}),
		);
	});

	it("keeps historical no-productKey requests on legacy Kling", async () => {
		const f = fixture("legacy");
		await submitVideoAttempt("fixture-job", f.deps);
		expect(adapters.legacySubmit).toHaveBeenCalledTimes(1);
		expect(adapters.modelSubmit).not.toHaveBeenCalled();
		expect(adapters.referenceSubmit).not.toHaveBeenCalled();
		expect(buildKieVideoV1Request(adapters.legacySubmit.mock.calls[0]![0])).toMatchObject({
			model: "kling-2.6/image-to-video",
			input: { image_urls: [subjectUrl], duration: "5", sound: false },
		});
	});
});
