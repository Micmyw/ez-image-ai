import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ getActiveRuntimeConfigOverrides: vi.fn(async () => []) }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database/video-v1-fulfillment", () => ({ authorizeVideoPlayback: vi.fn() }));
vi.mock("@repo/database/video-template", () => ({
	createVideoTemplateQuoteRecord: vi.fn(),
	createVideoTemplateJobRecord: vi.fn(),
	findExistingVideoTemplateAdmission: vi.fn(),
	getVideoTemplateJobRecord: vi.fn(),
	listVideoTemplateJobRecords: vi.fn(),
}));
vi.mock("./admission", () => ({
	ensureVideoWorkflowStarted: vi.fn(),
	requireVideoModelReadiness: vi.fn(() => ({
		config: {
			maxInputBytes: 10_000_000,
			ownerConcurrency: 1,
			globalConcurrency: 5,
			providerConcurrency: 5,
		},
		visualSafetyProfile: {},
		textSafetyProfile: {},
		audioSafetyPolicy: {},
	})),
}));
vi.mock("./workflow-binding", () => ({ getVideoWorkflowBinding: () => undefined }));
vi.mock("@repo/config/video-effects.server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/config/video-effects.server")>();
	return {
		...actual,
		resolveVideoEffectTemplate: vi.fn(actual.createVideoEffectTemplateSnapshot),
		resolveVideoEffectPrice: vi.fn(() => ({
			credits: 12n,
			pricingVersion: "fixture",
			pricingBasis: "HYPOTHETICAL",
			providerCostMicros: 1000n,
			moderationCostMicros: 100n,
			paidFundingPolicy: { minimumUsdMicrosPerCredit: 10n },
		})),
	};
});

import {
	createVideoEffectTemplateSnapshot,
	resolveVideoEffectTemplate,
} from "@repo/config/video-effects.server";
import { getActiveRuntimeConfigOverrides } from "@repo/database";
import {
	createVideoTemplateJobRecord,
	findExistingVideoTemplateAdmission,
	getVideoTemplateJobRecord,
} from "@repo/database/video-template";
import { authorizeVideoPlayback } from "@repo/database/video-v1-fulfillment";

import { ensureVideoWorkflowStarted } from "./admission";
import {
	createVideoTemplateJob,
	getVideoTemplatePublicState,
	requireVideoTemplateAdmission,
	videoTemplatePublicStage,
} from "./template-admission";
import {
	requireVideoTemplateRuntimeEnabled,
	requireVideoTemplateSceneEnvironment,
} from "./template-runtime-gates";

const request = {
	effectId: "hotel-lobby-duo" as const,
	presetKey: "standard" as const,
	inputs: { leftAssetId: "left", rightAssetId: "right" },
};
const bindings = { workflow: true, r2: true, hyperdrive: true, uploadCors: true };
const environment = {
	VIDEO_V1_ENABLED: "true",
	VIDEO_V1_ALLOWED_USER_IDS: "owner",
	HOTEL_LOBBY_DUO_ENABLED: "true",
	MEDIA_GENERATION_ENABLED: "true",
	MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
	MEDIA_ENABLED_PROVIDERS: "kie",
	VIDEO_V1_ACCESS: "internal",
};
const template = createVideoEffectTemplateSnapshot(request);
const job = {
	id: "job",
	status: "RESERVED",
	videoExecution: { stage: "INPUT_REVIEW" },
	reservation: { status: "ACTIVE" },
	creditsReserved: 12n,
	updatedAt: new Date(0),
	videoTemplateExecution: {
		templateSnapshot: template,
		sceneState: "PENDING",
		sceneSubmissionUncertain: false,
		updatedAt: new Date(0),
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getVideoTemplateJobRecord).mockResolvedValue(job as never);
	vi.mocked(findExistingVideoTemplateAdmission).mockResolvedValue(null);
	vi.mocked(createVideoTemplateJobRecord).mockResolvedValue({ jobId: "job", replayed: false });
});

describe("template admission and public recovery state", () => {
	it("replays the original accepted confirmation before mutable availability and pricing", async () => {
		vi.mocked(findExistingVideoTemplateAdmission).mockResolvedValue({ id: "job" } as never);
		const result = await createVideoTemplateJob(
			{ userId: "owner" },
			{ quoteId: "expired", idempotencyKey: "same-confirmation", request },
			{
				bindings,
				limits: { maximumStorageBytes: 1000000000n, maximumInputBytes: 10_000_000 },
				environment: {},
			},
		);
		expect(result.jobId).toBe("job");
		expect(ensureVideoWorkflowStarted).toHaveBeenCalledWith("job", undefined);
		expect(resolveVideoEffectTemplate).not.toHaveBeenCalled();
		expect(createVideoTemplateJobRecord).not.toHaveBeenCalled();
	});
	it("passes the complete total price and both ordered roles to one transactional order", async () => {
		await createVideoTemplateJob(
			{ userId: "owner" },
			{ quoteId: "quote", idempotencyKey: "confirmation", request },
			{
				bindings,
				limits: { maximumStorageBytes: 1000000000n, maximumInputBytes: 7_000_000 },
				environment,
			},
		);
		expect(createVideoTemplateJobRecord).toHaveBeenCalledTimes(1);
		expect(createVideoTemplateJobRecord).toHaveBeenCalledWith(
			expect.objectContaining({
				request,
				template,
				price: expect.objectContaining({ credits: 12n }),
				limits: expect.objectContaining({ maximumInputBytes: 7_000_000 }),
			}),
			expect.anything(),
		);
	});
	it("never inherits ordinary video internal funding without separate template authorization", () => {
		const funding = JSON.stringify({
			userIds: ["owner"],
			validUntil: "2100-01-01T00:00:00Z",
			reason: "ordinary video only",
		});
		const ordinary = requireVideoTemplateAdmission(
			{ userId: "owner", role: "admin" },
			{ ...environment, VIDEO_INTERNAL_FUNDING: funding },
			bindings,
			request,
		);
		expect(ordinary.price.paidFundingPolicy).toEqual({ minimumUsdMicrosPerCredit: 10n });
		const explicit = requireVideoTemplateAdmission(
			{ userId: "owner", role: "admin" },
			{ ...environment, HOTEL_LOBBY_DUO_INTERNAL_FUNDING: funding },
			bindings,
			request,
		);
		expect(explicit.price.paidFundingPolicy).toBeUndefined();
	});
	it.each([
		{ MEDIA_GENERATION_ENABLED: "false" },
		{ MEDIA_NANO_BANANA_2_LITE_ENABLED: "false" },
		{ MEDIA_ENABLED_PROVIDERS: "fal" },
	])("honors the existing image environment gate %j", (override) => {
		expect(() =>
			requireVideoTemplateSceneEnvironment(template, { ...environment, ...override }),
		).toThrow("VIDEO_EFFECT_DISABLED");
	});
	it("checks the real scene product runtime key, not only its SKU", async () => {
		vi.mocked(getActiveRuntimeConfigOverrides).mockResolvedValueOnce([
			{ configKey: "media.model.image-nano-banana-2-lite.enabled", value: false },
		] as never);
		await expect(requireVideoTemplateRuntimeEnabled(template, environment)).rejects.toThrow(
			"VIDEO_EFFECT_DISABLED",
		);
	});
	it("keeps scene uncertainty held and private while exposing no provider/model details", async () => {
		vi.mocked(getVideoTemplateJobRecord).mockResolvedValue({
			...job,
			failureCode: "KIE_SECRET_TOKEN",
			videoTemplateExecution: { ...job.videoTemplateExecution, sceneSubmissionUncertain: true },
		} as never);
		const result = await getVideoTemplatePublicState({ userId: "owner" }, "job");
		expect(result.stage).toBe("NEEDS_REVIEW");
		expect(result.failureCode).toBe("REVIEW_REQUIRED");
		expect(JSON.stringify(result)).not.toMatch(/kie|seedance|nano-banana|prompt|secret/i);
		expect(authorizeVideoPlayback).not.toHaveBeenCalled();
	});
	it("maps measured execution phases without fabricated percentages", () => {
		expect(videoTemplatePublicStage("INPUT_REVIEW", "PENDING", false)).toBe("PREPARING_PHOTOS");
		expect(videoTemplatePublicStage("INPUT_REVIEW", "GENERATING", false)).toBe("CREATING_SCENE");
		expect(videoTemplatePublicStage("GENERATING", "READY", false)).toBe("GENERATING_VIDEO");
		expect(videoTemplatePublicStage("OUTPUT_REVIEW", "READY", false)).toBe("CHECKING_VIDEO");
		expect(videoTemplatePublicStage("FAILED", "READY", false)).toBe("FAILED");
	});
	it("rechecks delivery authorization before declaring the settled result playable", async () => {
		vi.mocked(getVideoTemplateJobRecord).mockResolvedValue({
			...job,
			status: "SUCCEEDED",
			videoExecution: { stage: "READY" },
			reservation: { status: "SETTLED" },
		} as never);
		vi.mocked(authorizeVideoPlayback).mockResolvedValue(null);
		expect((await getVideoTemplatePublicState({ userId: "owner" }, "job")).canPlay).toBe(false);
		expect(authorizeVideoPlayback).toHaveBeenCalledWith("owner", "job");
	});
});
