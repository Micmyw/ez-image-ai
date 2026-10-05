import { createVideoEffectTemplateSnapshot } from "@repo/config/video-effects.server";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { VIDEO_V1_RULE_VERSION } from "@repo/config/video-v1";
import { describe, expect, it, vi } from "vitest";

import {
	prepareVideoTemplate,
	type VideoTemplatePreparationDependencies,
} from "./template-preparation";

vi.mock("@repo/database/video-template-execution", () => ({}));
vi.mock("@repo/database/video-v1-execution", () => ({ recordVideoInputReview: vi.fn() }));
vi.mock("@repo/storage", () => ({
	createSignedReadUrl: vi.fn(),
	storeImmutableVideoTemplateScene: vi.fn(),
}));

function fixture() {
	const now = new Date();
	const template = createVideoEffectTemplateSnapshot({
		effectId: "hotel-lobby-duo",
		presetKey: "standard",
		inputs: { leftAssetId: "left", rightAssetId: "right" },
	});
	const textAllow = {
		decision: "ALLOW" as const,
		reasonCode: "WAFFO_PROMPT_ALLOWED",
		ruleVersion: createVideoTextSafetyProfile().ruleVersion,
		evidence: {
			requestId: "text-1",
			models: ["waffo-prompt-sift"],
			operations: 1,
			scores: {},
			waffo: {
				requestId: "text-1",
				action: "allow" as const,
				semanticStatus: "scored" as const,
				matchedCategories: [],
			},
		},
	};
	const imageAllow = {
		decision: "ALLOW" as const,
		reasonCode: "NO_POLICY_MATCH",
		ruleVersion: VIDEO_V1_RULE_VERSION,
	};
	const identity = (role: "left" | "right") => ({
		role,
		assetId: role,
		objectKey: `users/owner/${role}.png`,
		checksum: role.repeat(16),
		storageEtag: role,
		storageVersionId: null,
		verificationGeneration: 1,
	});
	const state = {
		jobId: "job",
		templateSnapshot: template,
		orderedRoleIdentities: [identity("left"), identity("right")],
		job: {
			inputSnapshot: {
				videoEffectTemplate: template,
				requestFingerprint: "parent-fingerprint",
				textSafetyProfile: createVideoTextSafetyProfile(),
			},
			videoExecution: { stage: "QUEUED" },
			failureCode: null,
		},
		inputReview: {} as Record<string, unknown>,
		sceneReview: {} as Record<string, unknown>,
		sceneSubmissionUncertain: false,
		sceneProviderTaskId: null as string | null,
		sceneProviderEvidence: null as unknown,
		sceneState: "PENDING",
		stageData: {} as Record<string, unknown>,
		submittedAt: null as Date | null,
		createdAt: now,
		updatedAt: now,
		sceneAsset: null as null | {
			id: string;
			objectKey: string;
			finalizedAt: Date | null;
			checksum: string | null;
			storageEtag: string | null;
			storageVersionId: string | null;
			verificationGeneration: number;
		},
		resolvedInputIdentity: null as unknown,
	};
	const store = {
		getVideoTemplateExecution: vi.fn(async () => state),
		recordVideoTemplateReview: vi.fn(async (_id, phase, patch) => {
			Object.assign(phase === "inputs" ? state.inputReview : state.sceneReview, patch);
		}),
		claimVideoTemplateImageReview: vi.fn(async (_id, role) => {
			const collection = role === "scene" ? state.sceneReview : state.inputReview;
			const old = (collection[role] ?? {}) as Record<string, unknown>;
			if (old.submissionUncertain || old.taskId) return false;
			collection[role] = { ...old, submissionUncertain: true };
			return true;
		}),
		recordVideoTemplateImageReview: vi.fn(async (_id, role, patch) => {
			const collection = role === "scene" ? state.sceneReview : state.inputReview;
			collection[role] = { ...((collection[role] as Record<string, unknown>) ?? {}), ...patch };
		}),
		claimVideoTemplateSceneSubmission: vi.fn(async () => {
			const claimed = !state.submittedAt;
			state.submittedAt ??= now;
			state.sceneSubmissionUncertain = claimed;
			return { execution: state, claimed };
		}),
		recordVideoTemplateSceneAccepted: vi.fn(async (_id, taskId) => {
			state.sceneProviderTaskId = taskId;
			state.sceneSubmissionUncertain = false;
		}),
		recordVideoTemplateSceneProviderResult: vi.fn(async ({ evidence }) => {
			state.sceneProviderEvidence = evidence;
		}),
		prepareVideoTemplateSceneAsset: vi.fn(
			async () =>
				(state.sceneAsset ??= {
					id: "scene-asset",
					objectKey: "users/owner/scene.png",
					finalizedAt: null,
					checksum: null,
					storageEtag: null,
					storageVersionId: null,
					verificationGeneration: 1,
				}),
		),
		recordVideoTemplateSceneAsset: vi.fn(async ({ asset }) => {
			state.sceneAsset = { ...asset, finalizedAt: now, verificationGeneration: 1 };
		}),
		sealVideoTemplateResolvedInput: vi.fn(async () => {
			const asset = state.sceneAsset!;
			state.resolvedInputIdentity = {
				assetId: asset.id,
				objectKey: asset.objectKey,
				checksum: asset.checksum,
				storageEtag: asset.storageEtag,
				storageVersionId: asset.storageVersionId,
				verificationGeneration: asset.verificationGeneration,
				parentRequestFingerprint: "parent-fingerprint",
				sceneReviewEvidence: structuredClone(state.sceneReview),
			};
		}),
		markVideoTemplateNeedsReview: vi.fn(async () => {
			state.job.videoExecution.stage = "NEEDS_REVIEW";
		}),
		markVideoTemplateSceneFailed: vi.fn(async (_id, reasonCode) => {
			state.sceneState = "FAILED";
			state.stageData.reasonCode = reasonCode;
			state.sceneSubmissionUncertain = false;
		}),
	};
	const safety = {
		moderateText: vi.fn(),
		moderateImage: vi.fn(),
		submitVideo: vi.fn(),
		retrieveVideo: vi.fn(),
		submitImage: vi.fn(async (input) => ({
			moderationTaskId: input.idempotencyKey,
			completedDecision: imageAllow,
		})),
		retrieveImage: vi.fn(async () => imageAllow),
	};
	const provider = {
		submit: vi.fn(async (_input: unknown) => ({
			status: "ACCEPTED" as const,
			providerTaskId: "scene-task",
		})),
		retrieve: vi.fn(async () => ({
			status: "SUCCEEDED" as const,
			outputUrl: "https://cdn.example/scene.png",
			providerCostMicros: null,
			providerCreditsConsumed: 4,
			providerCompletedAt: now.toISOString(),
		})),
	};
	const recordInputReview = vi.fn(async () => undefined);
	const deps = {
		store,
		safety,
		provider,
		now: () => now,
		moderateText: vi.fn(async () => textAllow),
		signRead: vi.fn(async (key: string) => `https://private.example/${key}`),
		storeScene: vi.fn(async () => ({
			bytes: 100,
			sha256: "a".repeat(64),
			etag: "scene-etag",
			versionId: null,
			width: 576,
			height: 1024,
		})),
		recordInputReview,
		requireRuntimeEnabled: vi.fn(async () => undefined),
		recordMetric: vi.fn(),
		env: {
			VIDEO_V1_CALLBACK_BASE_URL: "https://ezpic.example",
			NEXT_PUBLIC_SAAS_URL: "https://ezpic.example",
			KIE_WEBHOOK_SECRET: "fixture",
			VIDEO_V1_PROVIDER_POLL_SECONDS: "2",
			VIDEO_V1_PROVIDER_DEADLINE_SECONDS: "1800",
			VIDEO_V1_MODERATION_POLL_SECONDS: "2",
			VIDEO_V1_MODERATION_DEADLINE_SECONDS: "1800",
		},
	} as unknown as VideoTemplatePreparationDependencies;
	return {
		state,
		store,
		safety,
		provider,
		deps,
		recordInputReview,
		imageAllow,
		run: () => prepareVideoTemplate("job", deps),
	};
}

describe("template scene preparation durable boundaries (local mocks)", () => {
	it("reviews both real prompts and both ordered photos, seals private scene, then replays without any paid POST", async () => {
		const f = fixture();
		expect(await f.run()).toEqual({ status: "ALLOW" });
		expect(f.deps.moderateText).toHaveBeenCalledTimes(2);
		expect(f.safety.submitImage).toHaveBeenCalledTimes(3);
		expect(f.provider.submit.mock.calls[0]?.[0]).toMatchObject({
			referenceUrls: [
				"https://private.example/users/owner/left.png",
				"https://private.example/users/owner/right.png",
			],
		});
		expect(f.state.resolvedInputIdentity).toMatchObject({
			assetId: "scene-asset",
			checksum: "a".repeat(64),
		});
		expect(await f.run()).toEqual({ status: "ALLOW" });
		expect(f.provider.submit).toHaveBeenCalledTimes(1);
		expect(f.deps.storeScene).toHaveBeenCalledTimes(1);
		expect(f.safety.submitImage).toHaveBeenCalledTimes(3);
	});
	it("polls the same pending SeeAPI input task and never posts that role again", async () => {
		const f = fixture();
		f.safety.submitImage.mockImplementationOnce(
			async (input) =>
				({ moderationTaskId: input.idempotencyKey, completedDecision: undefined }) as never,
		);
		f.safety.retrieveImage.mockResolvedValueOnce({
			decision: "REVIEW",
			reasonCode: "IMAGE_PROCESSING",
			ruleVersion: VIDEO_V1_RULE_VERSION,
		} as never);
		expect((await f.run()).status).toBe("PENDING");
		expect(f.provider.submit).not.toHaveBeenCalled();
		expect((await f.run()).status).toBe("ALLOW");
		expect(f.safety.retrieveImage).toHaveBeenCalledTimes(2);
		expect(f.safety.submitImage).toHaveBeenCalledTimes(3);
	});
	it("holds an ambiguous scene POST without releasing or repeating the paid request", async () => {
		const f = fixture();
		f.provider.submit.mockResolvedValueOnce({
			status: "UNCERTAIN",
			reasonCode: "TEMPLATE_SCENE_SUBMISSION_UNCERTAIN",
		} as never);
		expect((await f.run()).status).toBe("ERROR");
		expect((await f.run()).status).toBe("ERROR");
		expect(f.provider.submit).toHaveBeenCalledTimes(1);
		expect(f.store.markVideoTemplateSceneFailed).not.toHaveBeenCalled();
		expect(f.deps.storeScene).not.toHaveBeenCalled();
	});
	it("does not generate again after a scene identity commit succeeds but its response is lost", async () => {
		const f = fixture();
		const commit = f.store.recordVideoTemplateSceneAsset.getMockImplementation()!;
		f.store.recordVideoTemplateSceneAsset.mockImplementationOnce(async (input) => {
			await commit(input);
			throw new Error("lost commit response");
		});
		await expect(f.run()).rejects.toThrow("lost commit response");
		expect((await f.run()).status).toBe("ALLOW");
		expect(f.provider.submit).toHaveBeenCalledTimes(1);
		expect(f.provider.retrieve).toHaveBeenCalledTimes(1);
		expect(f.deps.storeScene).toHaveBeenCalledTimes(1);
	});
	it("continues the same scene task when the acceptance commit response is lost", async () => {
		const f = fixture();
		const commit = f.store.recordVideoTemplateSceneAccepted.getMockImplementation()!;
		f.store.recordVideoTemplateSceneAccepted.mockImplementationOnce(async (id, taskId) => {
			await commit(id, taskId);
			throw new Error("lost commit response");
		});
		expect((await f.run()).status).toBe("ALLOW");
		expect(f.provider.submit).toHaveBeenCalledTimes(1);
		expect(f.provider.retrieve).toHaveBeenCalledWith("scene-task");
		expect(f.store.markVideoTemplateNeedsReview).not.toHaveBeenCalled();
	});
	it("checks the emergency runtime gate only before the first scene POST", async () => {
		const f = fixture();
		vi.mocked(f.deps.requireRuntimeEnabled).mockRejectedValueOnce(
			new Error("MEDIA_GENERATION_DISABLED"),
		);
		expect((await f.run()).status).toBe("ERROR");
		expect(f.provider.submit).not.toHaveBeenCalled();
		expect(f.store.claimVideoTemplateSceneSubmission).not.toHaveBeenCalled();
	});
	it("never renews expired scene approval on a sealed-input replay", async () => {
		const f = fixture();
		expect((await f.run()).status).toBe("ALLOW");
		const original = f.deps.now();
		f.deps.now = () => new Date(original.getTime() + 3600_001);
		expect(await f.run()).toMatchObject({
			status: "ERROR",
			reasonCode: "VIDEO_TEMPLATE_SCENE_REVIEW_EXPIRED_OR_CHANGED",
		});
		expect(f.recordInputReview).toHaveBeenCalledTimes(1);
		expect(f.provider.submit).toHaveBeenCalledTimes(1);
	});
	it("replays a committed definite scene rejection after the write response was lost", async () => {
		const f = fixture();
		f.provider.submit.mockResolvedValueOnce({
			status: "DEFINITELY_REJECTED",
			reasonCode: "SCENE_REJECTED_402",
		} as never);
		const commit = f.store.markVideoTemplateSceneFailed.getMockImplementation()!;
		f.store.markVideoTemplateSceneFailed.mockImplementationOnce(async (id, reason) => {
			await commit(id, reason);
			throw new Error("lost write response");
		});
		expect(await f.run()).toEqual({ status: "REJECT", reasonCode: "SCENE_REJECTED_402" });
		expect(await f.run()).toEqual({ status: "REJECT", reasonCode: "SCENE_REJECTED_402" });
		expect(f.provider.submit).toHaveBeenCalledTimes(1);
		expect(f.store.markVideoTemplateNeedsReview).not.toHaveBeenCalled();
	});
	it("consumes persisted provider failure without fetching changed remote state on replay", async () => {
		const f = fixture();
		f.state.sceneProviderEvidence = { status: "FAILED", reasonCode: "SCENE_GENERATION_FAILED" };
		expect(await f.run()).toEqual({ status: "REJECT", reasonCode: "SCENE_GENERATION_FAILED" });
		expect(f.provider.submit).not.toHaveBeenCalled();
		expect(f.provider.retrieve).not.toHaveBeenCalled();
	});
	it("holds an ambiguous image review rather than resubmitting on durable retry", async () => {
		const f = fixture();
		f.safety.submitImage.mockRejectedValueOnce(new Error("POST timeout"));
		expect((await f.run()).status).toBe("ERROR");
		expect((await f.run()).status).toBe("ERROR");
		expect(f.safety.submitImage).toHaveBeenCalledTimes(1);
		expect(f.provider.submit).not.toHaveBeenCalled();
	});
});
