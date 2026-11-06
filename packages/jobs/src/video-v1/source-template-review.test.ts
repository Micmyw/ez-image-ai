import type { ModerationDecision } from "@repo/ai/media/moderation/types";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { VIDEO_V1_RULE_VERSION } from "@repo/config/video-v1";
import * as database from "@repo/database/video-source-template-review";
import { describe, expect, it, vi } from "vitest";

import { sourceHotelTemplateFixture } from "../../../config/test-support/source-hotel-template";
import {
	reviewSourceTemplateInputs,
	type SourceTemplateReviewDependencies,
} from "./source-template-review";

vi.mock("@repo/database/client", () => ({ getDatabaseClient: vi.fn(), db: {} }));
vi.mock("@repo/database", () => ({ getActiveRuntimeConfigOverrides: vi.fn(async () => []) }));
vi.mock("@repo/storage", () => ({ createSignedReadUrl: vi.fn() }));

function fixture(count = 3) {
	let now = new Date("2026-11-06T00:00:00.000Z");
	const profile = createVideoTextSafetyProfile();
	const identities = Array.from({ length: count }, (_, index) => ({
		role: `performer-${index + 1}`,
		assetId: `input-${index + 1}`,
		checksum: String(index + 1).repeat(64),
		objectKey: `user/input-${index + 1}.png`,
		storageEtag: `etag-${index + 1}`,
		storageVersionId: null,
		verificationGeneration: 1,
	}));
	const sourceTemplate = {
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
			modelId: "source-model",
			endpoint: "source-endpoint",
			body: {},
			revision: "source-revision",
			prompt: "the exact source prompt",
			requiredAssetUrls: [],
			output: { durationSeconds: 10, resolution: "720p", aspectRatio: "9:16", sound: true },
		},
		references: [],
	};
	const job = {
		id: "job",
		ownerId: "user",
		ownerType: "USER",
		failureCode: null,
		attempts: [],
		inputSnapshot: {
			requestKind: "source-template-video",
			sourceTemplate,
			productKey: "source-template:original-rap",
			mode: count ? "image-to-video" : "text-to-video",
			prompt: sourceTemplate.transport.prompt,
			...(count ? { inputAssetId: identities[0]!.assetId } : {}),
			duration: 10,
			resolution: "720p",
			aspectRatio: "9:16",
			sound: true,
			roleInputIdentities: identities,
			inputIdentity: identities[0]
				? Object.fromEntries(Object.entries(identities[0]).filter(([key]) => key !== "role"))
				: null,
			requestFingerprint: "fingerprint",
			textSafetyProfile: profile,
		},
		videoExecution: {
			stage: "QUEUED",
			inputReviewStartedAt: null,
			stageData: {} as Record<string, any>,
		},
		assets: identities.map((identity) => ({
			role: "INPUT",
			assetId: identity.assetId,
			assetChecksum: identity.checksum,
			asset: {
				...identity,
				ownerType: "USER",
				ownerId: "user",
				status: "VERIFYING",
				deletedAt: null,
				finalizedAt: now,
				deleteAfter: null,
			},
		})),
	};
	const read = () => job.videoExecution.stageData.inputReview ?? {};
	const store = {
		...database,
		getSourceTemplateReviewContext: vi.fn(async () => job),
		claimSourceTemplateImageReview: vi.fn(async (_job: string, role: string) => {
			const review = read();
			const roles = review.roles ?? {};
			const saved = roles[role] ?? {};
			if (saved.taskId || saved.submissionUncertain) return false;
			review.roles = {
				...roles,
				[role]: {
					...identities.find((identity) => identity.role === role),
					ruleVersion: VIDEO_V1_RULE_VERSION,
					submissionUncertain: true,
				},
			};
			return true;
		}),
		recordSourceTemplateImageReview: vi.fn(
			async (_job: string, role: string, patch: Record<string, any>) => {
				const review = read();
				const saved = review.roles[role];
				review.roles[role] = {
					...saved,
					...patch,
					...(patch.decision?.decision === "ALLOW"
						? { validUntil: new Date(now.getTime() + 3600_000).toISOString() }
						: {}),
				};
				return true;
			},
		),
		recordSourceTemplateInputReview: vi.fn(async (_job: string, patch: Record<string, any>) => {
			const next = { ...read(), ...patch };
			if (patch.status === "ALLOW") {
				next.validUntil = new Date(
					count
						? Math.min(...identities.map(({ role }) => Date.parse(next.roles[role].validUntil)))
						: now.getTime() + 3600_000,
				).toISOString();
				database.assertSourceTemplateInputReview(job.inputSnapshot, next, now);
			}
			job.videoExecution.stageData.inputReview = next;
			return true;
		}),
	};
	const allow = (taskId: string): ModerationDecision => ({
		decision: "ALLOW",
		reasonCode: "SAFE",
		ruleVersion: VIDEO_V1_RULE_VERSION,
		evidence: {
			requestId: taskId,
			models: ["nsfw-filter-2"],
			operations: 1,
			scores: {},
			seeapi: { taskId, flagged: false, nsfw: [], specialCare: [] },
		},
	});
	const text = {
		decision: "ALLOW",
		reasonCode: "WAFFO_PROMPT_ALLOWED",
		ruleVersion: profile.ruleVersion,
		evidence: {
			requestId: "text",
			models: ["waffo-prompt-sift"],
			operations: 1,
			scores: {},
			waffo: {
				requestId: "text",
				action: "allow",
				semanticStatus: "scored",
				matchedCategories: [],
			},
		},
	};
	const safety = {
		imageInputProfile: "seeapi-nsfw-filter-2",
		moderateText: vi.fn(),
		moderateImage: vi.fn(),
		submitVideo: vi.fn(),
		retrieveVideo: vi.fn(),
		submitImage: vi.fn(async ({ idempotencyKey }: { idempotencyKey: string }) => ({
			moderationTaskId: idempotencyKey.split(":")[2]!,
			status: "QUEUED",
			ruleVersion: VIDEO_V1_RULE_VERSION,
			idempotency: { key: idempotencyKey, providerSupported: true, replayed: false },
		})),
		retrieveImage: vi.fn(async ({ moderationTaskId }: { moderationTaskId: string }) =>
			allow(moderationTaskId),
		),
	};
	const deps = {
		callbacks: {
			claimSourceTemplateCallback: vi.fn(async () => "callback-event"),
			finishSourceTemplateCallback: vi.fn(),
		},
		store,
		fail: vi.fn(async () => true),
		safety,
		moderateText: vi.fn(async () => text),
		prepareImageModeration: vi.fn(
			async ({ objectKey }: { objectKey: string }) =>
				`https://private.example/prepared/${objectKey}`,
		),
		signRead: vi.fn(async (key: string) => `https://private.example/${key}`),
		env: {
			NEXT_PUBLIC_SAAS_URL: "https://example.test",
			VIDEO_SEEAPI_CALLBACK_SECRET: "test-callback-secret-1234567890123456",
			SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
				whkey_test: "whsec_test-callback-secret-123456789",
			}),
		},
		now: () => now,
	} as unknown as SourceTemplateReviewDependencies;
	return {
		deps,
		job,
		store,
		safety,
		allow,
		read,
		identities,
		setNow: (value: Date) => {
			now = value;
		},
	};
}

describe("source template multi-role moderation", () => {
	it("waits for each input callback with no timer query, then reads only its signalled role", async () => {
		const f = fixture(2);
		vi.mocked(f.deps.callbacks.claimSourceTemplateCallback).mockResolvedValue(null);
		expect(await reviewSourceTemplateInputs("job", f.deps)).toMatchObject({
			status: "PENDING",
			waitFor: "callback",
		});
		expect(f.safety.submitImage).toHaveBeenCalledTimes(2);
		expect(f.safety.retrieveImage).not.toHaveBeenCalled();
		for (const [request] of f.safety.submitImage.mock.calls)
			expect(request).toHaveProperty(
				"callbackUrl",
				expect.stringContaining("/api/webhooks/video-source-input/job/"),
			);
		vi.mocked(f.deps.callbacks.claimSourceTemplateCallback).mockImplementation(async (scope) =>
			scope.phase === "input" && scope.role === "performer-2" ? "second-event" : null,
		);
		expect(await reviewSourceTemplateInputs("job", f.deps)).toMatchObject({
			status: "PENDING",
			waitFor: "callback",
		});
		expect(f.safety.retrieveImage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ moderationTaskId: "performer-2" }),
		);
		vi.mocked(f.deps.callbacks.claimSourceTemplateCallback).mockResolvedValue(null);
		await reviewSourceTemplateInputs("job", f.deps);
		expect(f.safety.retrieveImage).toHaveBeenCalledOnce();
		expect(f.safety.submitImage).toHaveBeenCalledTimes(2);
	});
	it("reviews both Hotel photos and binds no-user-prompt evidence without calling Waffo", async () => {
		const f = fixture(2);
		Object.assign(f.job.inputSnapshot, sourceHotelTemplateFixture());
		expect(await reviewSourceTemplateInputs("job", f.deps)).toEqual({ status: "ALLOW" });
		expect(f.deps.moderateText).not.toHaveBeenCalled();
		expect(f.safety.submitImage).toHaveBeenCalledTimes(2);
		expect(f.safety.retrieveImage).toHaveBeenCalledTimes(2);
		expect(f.read().textDecision).toBeUndefined();
		expect(f.read().textReviewNotApplicable).toMatchObject({
			kind: "provider-owned-template/no-user-prompt",
			requestFingerprint: "fingerprint",
		});
		expect(await reviewSourceTemplateInputs("job", f.deps)).toEqual({ status: "ALLOW" });
		expect(f.safety.submitImage).toHaveBeenCalledTimes(2);
	});
	it("reviews all three roles against the exact source prompt and persists one aggregate approval", async () => {
		const f = fixture();
		expect(await reviewSourceTemplateInputs("job", f.deps)).toEqual({ status: "ALLOW" });
		expect(f.deps.moderateText).toHaveBeenCalledWith({
			text: "the exact source prompt",
			ruleVersion: createVideoTextSafetyProfile().ruleVersion,
		});
		expect(f.safety.submitImage).toHaveBeenCalledTimes(3);
		expect(f.safety.retrieveImage).toHaveBeenCalledTimes(3);
		expect(Object.keys(f.read().roles)).toEqual(["performer-1", "performer-2", "performer-3"]);
		expect(await reviewSourceTemplateInputs("job", f.deps)).toEqual({ status: "ALLOW" });
		expect(f.safety.submitImage).toHaveBeenCalledTimes(3);
		expect(f.safety.submitVideo).not.toHaveBeenCalled();
	});
	it("resumes each pending task by authenticated retrieval without another submission", async () => {
		const f = fixture(2);
		f.safety.retrieveImage.mockImplementationOnce(async () => ({
			decision: "REVIEW",
			reasonCode: "IMAGE_PROCESSING",
			ruleVersion: VIDEO_V1_RULE_VERSION,
		}));
		expect(await reviewSourceTemplateInputs("job", f.deps)).toMatchObject({ status: "PENDING" });
		expect(f.safety.submitImage).toHaveBeenCalledTimes(2);
		expect(await reviewSourceTemplateInputs("job", f.deps)).toEqual({ status: "ALLOW" });
		expect(f.safety.submitImage).toHaveBeenCalledTimes(2);
		expect(f.safety.retrieveImage).toHaveBeenCalledTimes(3);
	});
	it("never retries an unknown image moderation submission", async () => {
		const f = fixture(1);
		f.safety.submitImage.mockRejectedValueOnce(new Error("lost response"));
		const uncertain = {
			status: "ERROR",
			reasonCode: "VIDEO_IMAGE_REVIEW_SUBMISSION_UNCERTAIN",
			retryable: false,
		};
		expect(await reviewSourceTemplateInputs("job", f.deps)).toEqual(uncertain);
		expect(await reviewSourceTemplateInputs("job", f.deps)).toEqual(uncertain);
		expect(f.safety.submitImage).toHaveBeenCalledOnce();
		expect(f.read().roles["performer-1"].submissionUncertain).toBe(true);
	});
	it("does not fence or send when immutable image preparation fails", async () => {
		const f = fixture(1);
		vi.mocked(f.deps.prepareImageModeration).mockRejectedValueOnce(
			new Error("invalid immutable object"),
		);
		await expect(reviewSourceTemplateInputs("job", f.deps)).rejects.toThrow(
			"invalid immutable object",
		);
		expect(f.store.claimSourceTemplateImageReview).not.toHaveBeenCalled();
		expect(f.safety.submitImage).not.toHaveBeenCalled();
	});
	it("stops on Waffo rejection before any image moderation request", async () => {
		const f = fixture();
		vi.mocked(f.deps.moderateText).mockResolvedValueOnce({
			decision: "REJECT",
			reasonCode: "BLOCKED",
			ruleVersion: createVideoTextSafetyProfile().ruleVersion,
		});
		expect(await reviewSourceTemplateInputs("job", f.deps)).toEqual({
			status: "REJECT",
			reasonCode: "BLOCKED",
		});
		expect(f.safety.submitImage).not.toHaveBeenCalled();
	});
	it("rejects a second role instead of trusting the approved first role", async () => {
		const f = fixture(2);
		f.safety.retrieveImage.mockImplementation(async ({ moderationTaskId }) =>
			moderationTaskId === "performer-2"
				? { decision: "REJECT", reasonCode: "IMAGE_BLOCKED", ruleVersion: VIDEO_V1_RULE_VERSION }
				: f.allow(moderationTaskId),
		);
		expect(await reviewSourceTemplateInputs("job", f.deps)).toEqual({
			status: "REJECT",
			reasonCode: "IMAGE_BLOCKED",
		});
		expect(f.read().status).not.toBe("ALLOW");
		expect(f.deps.fail).toHaveBeenCalledWith("job", "IMAGE_BLOCKED", true);
	});
	it("holds expired visual approval without renewing it or submitting again", async () => {
		const f = fixture(1);
		await reviewSourceTemplateInputs("job", f.deps);
		f.setNow(new Date("2026-11-06T01:00:01.000Z"));
		expect(await reviewSourceTemplateInputs("job", f.deps)).toMatchObject({
			status: "ERROR",
			reasonCode: "VIDEO_INPUT_REVIEW_REQUIRED",
		});
		expect(f.safety.submitImage).toHaveBeenCalledOnce();
	});
	it("runs only Waffo review for source text-only rap", async () => {
		const f = fixture(0);
		expect(await reviewSourceTemplateInputs("job", f.deps)).toEqual({ status: "ALLOW" });
		expect(f.deps.moderateText).toHaveBeenCalledOnce();
		expect(f.safety.submitImage).not.toHaveBeenCalled();
	});
});
