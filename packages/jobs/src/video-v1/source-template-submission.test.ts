import { resolveSourceTemplateRequest } from "@repo/ai/media/rap-templates";
import { sourceTemplateInternalRequestSchema } from "@repo/config/video-template-execution.server";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database/video-v1-execution", () => ({}));
vi.mock("@repo/storage", () => ({ createSignedReadUrl: vi.fn() }));
import {
	submitVideoAttempt,
	confirmVideoProviderResult,
	prepareFrozenSourceTemplateRequest,
	type VideoSubmissionDependencies,
} from "./submission";

function fixture(templateKey: "original-rap" | "source-hotel-lobby" = "original-rap") {
	const roles = [1, 2].map((number) => ({
		role: `performer-${number}` as "performer-1" | "performer-2",
		assetId: `asset-${number}`,
		checksum: String(number).repeat(64),
		objectKey: `private/portrait-${number}.png`,
		storageEtag: `etag-${number}`,
		storageVersionId: null,
		verificationGeneration: 0,
	}));
	const transport = resolveSourceTemplateRequest({
		templateKey,
		userImageUrls: roles.map((role) => `https://ezpic-template.example/user/${role.role}`),
		configs: {},
	});
	const request = sourceTemplateInternalRequestSchema.parse({
		requestKind: "source-template-video",
		productKey: `source-template:${templateKey}`,
		mode: "image-to-video",
		inputAssetId: roles[0]!.assetId,
		prompt: transport.prompt,
		duration: transport.output.durationSeconds,
		resolution: transport.output.resolution,
		aspectRatio: transport.output.aspectRatio,
		sound: true,
		sourceTemplate: {
			templateKey,
			version: "test-v1",
			provision: { id: "config", version: 1 },
			request: {
				templateKey,
				options: {},
				inputs: roles.map(({ role, assetId }) => ({ role, assetId })),
			},
			transport,
			references: [],
		},
	});
	const attempts: Array<{
		id: string;
		provider: string;
		providerModelId: string;
		providerTaskId: string | null;
		status: string;
	}> = [];
	const job = {
		id: "job",
		createdAt: new Date(),
		status: "QUEUED",
		inputSnapshot: {
			...request,
			roleInputIdentities: roles,
			inputIdentity: roles[0],
			requestFingerprint: "frozen",
			textSafetyProfile: createVideoTextSafetyProfile(),
		},
		attempts,
		videoExecution: { stage: "QUEUED", providerSubmitStartedAt: new Date() },
	};
	const store = {
		getVideoExecutionContext: vi.fn(async () => job),
		claimVideoProviderSubmission: vi.fn(async () => {
			if (attempts[0]) return { claimed: false, attempt: attempts[0] };
			attempts.push({
				id: "attempt",
				provider: "seeapi",
				providerModelId: transport.modelId,
				providerTaskId: null,
				status: "SUBMISSION_UNCERTAIN",
			});
			return { claimed: true, attempt: attempts[0] };
		}),
		recordVideoSubmissionAccepted: vi.fn(async (_job: string, _attempt: string, id: string) => {
			attempts[0]!.providerTaskId = id;
		}),
		markVideoSubmissionUncertain: vi.fn(),
		failVideoExecution: vi.fn(),
		consumeVideoProviderEvents: vi.fn(),
		recordVideoProviderSuccess: vi.fn(),
		recordVideoProviderAccounting: vi.fn(),
	};
	const sourceProvider = {
		submit: vi.fn<VideoSubmissionDependencies["sourceProvider"]["submit"]>(async () => ({
			status: "ACCEPTED" as const,
			providerTaskId: "source-task",
		})),
		retrieve: vi.fn<VideoSubmissionDependencies["sourceProvider"]["retrieve"]>(async () => ({
			status: "PENDING" as const,
		})),
	};
	const legacy = { submit: vi.fn(), retrieve: vi.fn() };
	const signRead = vi.fn(async (key: string) => `https://private.example/${key}`);
	const deps = {
		callbacks: {
			claimSourceTemplateCallback: vi.fn(async () => "callback-event"),
			finishSourceTemplateCallback: vi.fn(),
		},
		store,
		sourceProvider,
		provider: legacy,
		signRead,
		safety: {},
		moderateText: vi.fn(),
		now: () => new Date(),
		env: {
			SEEAPI_API_KEY: "local-test-only",
			NEXT_PUBLIC_SAAS_URL: "https://example.test",
			VIDEO_SEEAPI_CALLBACK_SECRET: "test-callback-secret-1234567890123456",
			SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
				whkey_test: "whsec_test-callback-secret-123456789",
			}),
		},
	} as unknown as VideoSubmissionDependencies;
	return { deps, job, roles, attempts, store, sourceProvider, legacy, signRead };
}
describe("source submission uses the existing irreversible send fence", () => {
	it.each(["SUCCEEDED", "FAILED"] as const)(
		"source %s confirmation only consumes its addressed receipt",
		async (status) => {
			const f = fixture();
			await submitVideoAttempt("job", f.deps);
			f.sourceProvider.retrieve.mockResolvedValueOnce(
				status === "SUCCEEDED"
					? {
							status,
							outputUrl: "https://provider.example/result.mp4",
							providerCostMicros: null,
							providerCreditsConsumed: null,
							providerCompletedAt: null,
						}
					: {
							status,
							reasonCode: "PROVIDER_FAILED",
							providerCostMicros: null,
							providerCreditsConsumed: null,
						},
			);
			expect(await confirmVideoProviderResult("job", f.deps)).toMatchObject({ status });
			expect(f.deps.callbacks.finishSourceTemplateCallback).toHaveBeenCalledExactlyOnceWith(
				"callback-event",
			);
			expect(f.store.consumeVideoProviderEvents).not.toHaveBeenCalled();
		},
	);
	it("does not query without a persisted callback, including unknown submission", async () => {
		const f = fixture();
		vi.mocked(f.deps.callbacks.claimSourceTemplateCallback).mockResolvedValue(null);
		await submitVideoAttempt("job", f.deps);
		expect(f.sourceProvider.submit.mock.calls[0]?.[0].body).toHaveProperty(
			"callback_url",
			expect.stringMatching(
				/^https:\/\/example\.test\/api\/webhooks\/video-source\/seeapi\/[a-f0-9]{64}$/,
			),
		);
		for (let i = 0; i < 3; i++)
			expect(await confirmVideoProviderResult("job", f.deps)).toMatchObject({
				status: "PENDING",
				waitFor: "callback",
			});
		expect(f.sourceProvider.retrieve).not.toHaveBeenCalled();
		f.attempts[0]!.providerTaskId = null;
		expect(await confirmVideoProviderResult("job", f.deps)).toMatchObject({
			status: "PENDING",
			waitFor: "callback",
		});
		expect(f.sourceProvider.submit).toHaveBeenCalledOnce();
	});
	it("holds a failed callback confirmation without repeating a read or generation", async () => {
		const f = fixture();
		await submitVideoAttempt("job", f.deps);
		f.sourceProvider.retrieve.mockRejectedValueOnce(new Error("network"));
		expect(await confirmVideoProviderResult("job", f.deps)).toMatchObject({ status: "ERROR" });
		expect(f.deps.callbacks.finishSourceTemplateCallback).toHaveBeenCalledWith(
			"callback-event",
			true,
		);
		vi.mocked(f.deps.callbacks.claimSourceTemplateCallback).mockRejectedValue(new Error("held"));
		expect(await confirmVideoProviderResult("job", f.deps)).toMatchObject({ status: "ERROR" });
		expect(f.sourceProvider.retrieve).toHaveBeenCalledOnce();
		expect(f.sourceProvider.submit).toHaveBeenCalledOnce();
		expect(f.store.failVideoExecution).not.toHaveBeenCalled();
	});
	it("fails before the send fence when SeeAPI callback configuration is missing", async () => {
		const f = fixture();
		delete f.deps.env.SEEAPI_WEBHOOK_SIGNING_KEYS;
		await expect(submitVideoAttempt("job", f.deps)).rejects.toThrow(
			"SOURCE_CALLBACK_NOT_CONFIGURED",
		);
		expect(f.store.claimVideoProviderSubmission).not.toHaveBeenCalled();
		expect(f.sourceProvider.submit).not.toHaveBeenCalled();
	});
	it.each(["original-rap", "source-hotel-lobby"] as const)(
		"signs private %s portraits in source order and submits once without a Kie callback requirement",
		async (key) => {
			const f = fixture(key);
			expect(await submitVideoAttempt("job", f.deps)).toMatchObject({
				status: "ACCEPTED",
				providerTaskId: "source-task",
			});
			expect(f.sourceProvider.submit).toHaveBeenCalledTimes(1);
			expect(f.sourceProvider.submit.mock.calls[0]?.[0]).toMatchObject({
				provider: "seeapi",
				endpoint: key === "source-hotel-lobby" ? "hotel-lobby-ai" : "reference-to-video",
				body: {
					input: {
						reference_images: [
							"https://private.example/private/portrait-1.png",
							"https://private.example/private/portrait-2.png",
						],
					},
				},
			});
			expect(f.legacy.submit).not.toHaveBeenCalled();
			if (key === "source-hotel-lobby") {
				const sent = f.sourceProvider.submit.mock.calls[0]![0];
				expect(f.job.inputSnapshot.prompt).toBeNull();
				expect(f.job.inputSnapshot.duration).toBeNull();
				expect(sent.body).not.toHaveProperty("model");
				expect(sent.body.input).not.toHaveProperty("prompt");
				expect(sent.body.input).not.toHaveProperty("duration_seconds");
			}
			expect(await submitVideoAttempt("job", f.deps)).toMatchObject({ status: "ACCEPTED" });
			expect(f.sourceProvider.submit).toHaveBeenCalledTimes(1);
		},
	);
	it.each(["original-rap", "source-hotel-lobby"] as const)(
		"unknown %s POST keeps the same attempt and cannot resend on refresh",
		async (key) => {
			const f = fixture(key);
			f.sourceProvider.submit.mockRejectedValueOnce(new Error("response lost"));
			expect(await submitVideoAttempt("job", f.deps)).toMatchObject({
				status: "UNCERTAIN",
				attemptId: "attempt",
			});
			expect(await submitVideoAttempt("job", f.deps)).toMatchObject({
				status: "UNCERTAIN",
				attemptId: "attempt",
			});
			expect(f.sourceProvider.submit).toHaveBeenCalledTimes(1);
			expect(f.store.failVideoExecution).not.toHaveBeenCalled();
		},
	);
	it("retrieves only the exact source provider/model and rejects attempt drift", async () => {
		const f = fixture();
		await submitVideoAttempt("job", f.deps);
		expect(await confirmVideoProviderResult("job", f.deps)).toMatchObject({ status: "PENDING" });
		expect(f.sourceProvider.retrieve).toHaveBeenCalledTimes(1);
		expect(f.legacy.retrieve).not.toHaveBeenCalled();
		f.attempts[0]!.providerModelId = "different-provider-model";
		await expect(confirmVideoProviderResult("job", f.deps)).rejects.toThrow(
			"VIDEO_PROVIDER_MODEL_IDENTITY_MISMATCH",
		);
	});
	it("rejects a reordered immutable identity array before signing or submission", async () => {
		const f = fixture();
		f.job.inputSnapshot.roleInputIdentities.reverse();
		await expect(
			prepareFrozenSourceTemplateRequest(f.job.inputSnapshot, f.signRead),
		).rejects.toThrow("VIDEO_INPUT_IDENTITY_CHANGED");
		expect(f.signRead).not.toHaveBeenCalled();
	});
});
