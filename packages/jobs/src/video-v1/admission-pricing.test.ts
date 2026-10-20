import { VIDEO_MODEL_CATALOG_VERSION } from "@repo/config/video-models";
import { createVideoAudioSafetyPolicy } from "@repo/config/video-output";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
	price: {
		credits: 42n,
		pricingVersion: "mock-price",
		pricingBasis: "TEST_ONLY",
		providerCostMicros: 10n,
		moderationCostMicros: 2n,
		paidFundingPolicy: { minimumUsdMicrosPerCredit: 21_944n },
		pricingDetails: { creditFloorMicros: "21944" },
	},
	job: {
		id: "job-1",
		videoExecution: { stage: "QUEUED" },
		reservation: { status: "ACTIVE" },
		creditsReserved: 42n,
		failureCode: null,
		updatedAt: new Date(0),
	},
}));
vi.mock("@repo/config/video-pricing.server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/config/video-pricing.server")>()),
	resolveVideoModelPrice: vi.fn(() => fixtures.price),
}));
vi.mock("@repo/database/client", () => ({
	db: {
		videoExecution: {
			findUnique: vi.fn(async () => ({
				workflowInstanceId: "video-v1-job-1",
				startState: "STARTED",
				job: { executionEngine: "video-workflow-v1" },
			})),
		},
	},
}));
vi.mock("@repo/database/video-v1", () => ({
	createVideoJobRecord: vi.fn(async () => ({ jobId: "job-1", replayed: false })),
	findExistingVideoAdmission: vi.fn(async () => null),
	getVideoJobRecord: vi.fn(async () => fixtures.job),
	listVideoJobRecords: vi.fn(),
}));
vi.mock("@repo/database/video-v1-fulfillment", () => ({ authorizeVideoPlayback: vi.fn() }));
vi.mock("./workflow-binding", () => ({ getVideoWorkflowBinding: () => undefined }));

import { resolveVideoModelPrice } from "@repo/config/video-pricing.server";
import { createVideoJobRecord, findExistingVideoAdmission } from "@repo/database/video-v1";

import { createVideoJob, requireVideoAdmission, requireVideoModelReadiness } from "./admission";

const environment = {
	VIDEO_V1_ENABLED: "true",
	MEDIA_GENERATION_ENABLED: "true",
	VIDEO_V1_ACCESS: "authenticated",
	KIE_API_KEY: "fixture",
	KIE_WEBHOOK_SECRET: "fixture",
	NEXT_PUBLIC_SAAS_URL: "https://video.example.test",
	VIDEO_V1_MODERATION_CALLBACK_CONFIGURED: "true",
	VIDEO_V1_MODERATION_WEBHOOK_SECRET: "casec_fixture",
	VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
	VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
	VIDEO_COST_VISUAL_POLICY_VERSION: createVideoVisualSafetyProfile("seeapi", 5).policyVersion,
	VIDEO_COST_TEXT_RULE_VERSION: createVideoTextSafetyProfile().ruleVersion,
	VIDEO_V1_IMAGE_SAFETY_ADAPTER: "seeapi",
	SEEAPI_API_KEY: "fixture",
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
		whkey_test: "whsec_local_test_signing_secret_20261004",
	}),
	VIDEO_SEEAPI_CALLBACK_SECRET: "local-video-seeapi-callback-secret-20261004",
	WAFFO_MERCHANT_ID: "fixture",
	WAFFO_PRIVATE_KEY: "fixture",
	VIDEO_V1_PROVIDER_CONCURRENCY: "5",
	VIDEO_V1_OUTPUT_ALLOWED_HOSTS: "cdn.example.test",
};
const bindings = { workflow: true, r2: true, hyperdrive: true, uploadCors: true };
const options = {
	environment,
	bindings,
	limits: { maximumStorageBytes: 1_000_000n, maximumInputBytes: 1_000_000 },
};
const legacyRequest = {
	mode: "text-to-video" as const,
	prompt: "A boat on a lake",
	duration: 5 as const,
	sound: false as const,
	aspectRatio: "16:9" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	fixtures.job.videoExecution.stage = "QUEUED";
	vi.mocked(findExistingVideoAdmission).mockResolvedValue(null);
});
describe("video admission pricing and shared credit funding binding", () => {
	it("keeps frozen Seedance 1.5 Pro runtime readiness independent of new admission retirement", () => {
		const request = { ...legacyRequest, productKey: "video-seedance-1-5-pro", resolution: "1080p" };
		expect(requireVideoModelReadiness(environment, bindings, request).price).toEqual(
			fixtures.price,
		);
		expect(resolveVideoModelPrice).toHaveBeenCalledWith(request, environment, undefined);
	});
	it.each(["QUEUED", "SUBMISSION_UNCERTAIN"])(
		"closes new Seedance 1.5 Pro admission while replaying its frozen 1080p %s order",
		async (stage) => {
			const request = {
				...legacyRequest,
				productKey: "video-seedance-1-5-pro",
				resolution: "1080p",
			};
			const owner = { userId: "registered-user", role: "user" };
			expect(() => requireVideoAdmission(owner, environment, bindings, request)).toThrow(
				"VIDEO_MODEL_RETIRED",
			);
			expect(resolveVideoModelPrice).not.toHaveBeenCalled();
			vi.mocked(findExistingVideoAdmission).mockResolvedValue({ id: "job-1" } as never);
			fixtures.job.videoExecution.stage = stage;
			const replay = await createVideoJob(
				owner,
				{ quoteId: "old-quote", idempotencyKey: "old-model-key", request },
				options,
			);
			expect(replay).toMatchObject({
				jobId: "job-1",
				stage,
				creditState: "RESERVED",
				credits: "42",
			});
			expect(findExistingVideoAdmission).toHaveBeenCalledWith(
				expect.objectContaining({
					ownerId: owner.userId,
					quoteId: "old-quote",
					idempotencyKey: "old-model-key",
					request,
				}),
				expect.anything(),
			);
			expect(createVideoJobRecord).not.toHaveBeenCalled();
			expect(resolveVideoModelPrice).not.toHaveBeenCalled();
		},
	);
	it("rejects a new historical Kling image ratio but replays its accepted receipt before current admission", async () => {
		const request = {
			...legacyRequest,
			productKey: "video-kling-3",
			mode: "image-to-video" as const,
			resolution: "720p",
			aspectRatio: "9:16",
			inputAssetId: "old-sealed-image",
		};
		const owner = { userId: "registered-user", role: "user" };
		expect(() => requireVideoAdmission(owner, environment, bindings, request)).toThrow(
			"VIDEO_MODEL_OPTION_UNAVAILABLE",
		);
		vi.mocked(findExistingVideoAdmission).mockResolvedValue({ id: "job-1" } as never);
		const result = await createVideoJob(
			owner,
			{ quoteId: "old-quote", idempotencyKey: "old-key", request },
			options,
		);
		expect(result.jobId).toBe("job-1");
		expect(createVideoJobRecord).not.toHaveBeenCalled();
		expect(resolveVideoModelPrice).not.toHaveBeenCalled();
	});
	it.each([
		{ userId: "registered-user", role: "user" },
		{ userId: "funding-test-operator", role: "admin" },
	])("freezes shared media credit funding for $role in authenticated mode", async (owner) => {
		const authenticatedEnvironment = {
			...environment,
			VIDEO_V1_ACCESS: "authenticated",
			VIDEO_INTERNAL_FUNDING: JSON.stringify({
				userIds: ["funding-test-operator"],
				validUntil: new Date(Date.now() + 60_000).toISOString(),
				reason: "Internal grant must not apply to the public audience",
			}),
		};
		const quote = requireVideoAdmission(owner, authenticatedEnvironment, bindings, legacyRequest);
		expect(quote.price.paidFundingPolicy).toBeUndefined();
		expect(quote.price.pricingDetails).toMatchObject({
			funding: { mode: "shared-media-credits-v1" },
			paidRevenueQualified: false,
			retailReference: { creditFloorMicros: "21944" },
		});
		expect(quote.price.credits).toBe(fixtures.price.credits);
		expect(fixtures.price.paidFundingPolicy).toEqual({ minimumUsdMicrosPerCredit: 21_944n });
		await createVideoJob(
			owner,
			{ quoteId: "quote", idempotencyKey: "authenticated-request", request: legacyRequest },
			{ ...options, environment: authenticatedEnvironment },
		);
		expect(createVideoJobRecord).toHaveBeenCalledWith(
			expect.objectContaining({
				ownerId: owner.userId,
				price: quote.price,
				paidFundingPolicy: undefined,
			}),
			expect.anything(),
		);
	});
	it("uses the same shared funding decision for new ordinary internal quotations and jobs", async () => {
		const operator = { userId: "funding-test-operator", role: "admin" };
		const internalEnvironment = {
			...environment,
			VIDEO_V1_ACCESS: "internal",
			VIDEO_INTERNAL_FUNDING: JSON.stringify({
				userIds: [operator.userId],
				validUntil: new Date(Date.now() + 60_000).toISOString(),
				reason: "Explicit local acceptance fixture",
			}),
		};
		const quoted = requireVideoAdmission(operator, internalEnvironment, bindings, legacyRequest);
		expect(quoted.price.paidFundingPolicy).toBeUndefined();
		expect(quoted.price.credits).toBe(fixtures.price.credits);
		expect(quoted.price.pricingDetails).toMatchObject({
			paidRevenueQualified: false,
			funding: { mode: "shared-media-credits-v1" },
		});
		await createVideoJob(
			operator,
			{ quoteId: "quote", idempotencyKey: "operator-request", request: legacyRequest },
			{ ...options, environment: internalEnvironment },
		);
		expect(createVideoJobRecord).toHaveBeenCalledWith(
			expect.objectContaining({ price: quoted.price, paidFundingPolicy: undefined }),
			expect.anything(),
		);
	});
	it("does not turn a new ordinary administrator quote into an internal funding authorization", () => {
		const quoted = requireVideoAdmission(
			{ userId: "another-admin", role: "admin" },
			{
				...environment,
				VIDEO_V1_ACCESS: "internal",
				VIDEO_INTERNAL_FUNDING: JSON.stringify({
					userIds: ["funding-test-operator"],
					validUntil: new Date(Date.now() + 60_000).toISOString(),
					reason: "Explicit local acceptance fixture",
				}),
			},
			bindings,
			legacyRequest,
		);
		expect(quoted.price.paidFundingPolicy).toBeUndefined();
		expect(quoted.price.pricingDetails?.funding).toEqual({ mode: "shared-media-credits-v1" });
	});
	it("replays an operator-funded accepted request after the exception has been disabled", async () => {
		vi.mocked(findExistingVideoAdmission).mockResolvedValue({ id: "job-1" } as never);
		await createVideoJob(
			{ userId: "funding-test-operator", role: "admin" },
			{ quoteId: "old-quote", idempotencyKey: "operator-request", request: legacyRequest },
			{ ...options, environment: { VIDEO_V1_ENABLED: "false" } },
		);
		expect(resolveVideoModelPrice).not.toHaveBeenCalled();
		expect(createVideoJobRecord).not.toHaveBeenCalled();
	});
	it.each([undefined, "[]", "not-json"])(
		"prices and admits official Seedance 2 Mini options regardless of stale model scope %s",
		async (scope) => {
			const request = {
				...legacyRequest,
				productKey: "video-seedance-2-mini",
				resolution: "720p",
			};
			const currentEnvironment = { ...environment, VIDEO_MODEL_ALLOWED_OPTIONS: scope };
			expect(
				requireVideoAdmission({ userId: "owner" }, currentEnvironment, bindings, request).price,
			).toMatchObject({ credits: fixtures.price.credits, paidFundingPolicy: undefined });
			await createVideoJob(
				{ userId: "owner" },
				{ quoteId: "quote", idempotencyKey: "request", request },
				{ ...options, environment: currentEnvironment },
			);
			expect(resolveVideoModelPrice).toHaveBeenCalledWith(request, currentEnvironment, undefined);
			expect(createVideoJobRecord).toHaveBeenCalledWith(
				expect.objectContaining({ request, paidFundingPolicy: undefined }),
				expect.anything(),
			);
		},
	);
	it.each([
		{ productKey: "video-seedance-2-mini", duration: 16, resolution: "720p" },
		{ productKey: "video-seedance-2-mini", duration: 5, resolution: "4k" },
		{ productKey: "video-seedance-1-pro-fast", mode: "text-to-video", resolution: "720p" },
		{ productKey: "video-unsupported", resolution: "720p" },
	] as const)(
		"rejects unsupported model parameters before pricing or reservation %j",
		async (selection) => {
			await expect(
				createVideoJob(
					{ userId: "owner" },
					{
						quoteId: "quote",
						idempotencyKey: "unsupported",
						request: { ...legacyRequest, ...selection },
					},
					options,
				),
			).rejects.toThrow("VIDEO_MODEL_OPTION_UNAVAILABLE");
			expect(resolveVideoModelPrice).not.toHaveBeenCalled();
			expect(createVideoJobRecord).not.toHaveBeenCalled();
		},
	);
	it("applies shared funding to a new request using the legacy fixed input shape", async () => {
		await createVideoJob(
			{ userId: "owner" },
			{ quoteId: "quote", idempotencyKey: "request", request: legacyRequest },
			options,
		);
		expect(resolveVideoModelPrice).toHaveBeenCalledWith(
			{
				productKey: "video-kling-2-6-v1",
				mode: "text-to-video",
				duration: 5,
				resolution: "default",
				aspectRatio: "16:9",
				sound: false,
			},
			environment,
			undefined,
		);
		expect(createVideoJobRecord).toHaveBeenCalledWith(
			expect.objectContaining({
				request: legacyRequest,
				price: expect.objectContaining({
					credits: fixtures.price.credits,
					pricingDetails: expect.objectContaining({ funding: { mode: "shared-media-credits-v1" } }),
				}),
				paidFundingPolicy: undefined,
				visualSafetyProfile: createVideoVisualSafetyProfile("seeapi", 5),
				textSafetyProfile: createVideoTextSafetyProfile(),
				audioSafetyPolicy: createVideoAudioSafetyPolicy(),
			}),
			expect.anything(),
		);
	});
	it("prices the complete selected model and options before passing immutable input to reservation", async () => {
		const request = {
			...legacyRequest,
			productKey: "video-kling-3",
			duration: 10,
			resolution: "1080p",
			sound: true,
		};
		await createVideoJob(
			{ userId: "owner" },
			{ quoteId: "quote", idempotencyKey: "request", request },
			options,
		);
		expect(resolveVideoModelPrice).toHaveBeenCalledWith(
			expect.objectContaining(request),
			environment,
			undefined,
		);
		expect(createVideoJobRecord).toHaveBeenCalledWith(
			expect.objectContaining({
				request,
				paidFundingPolicy: undefined,
				visualSafetyProfile: createVideoVisualSafetyProfile("seeapi", request.duration),
				textSafetyProfile: createVideoTextSafetyProfile(),
				audioSafetyPolicy: createVideoAudioSafetyPolicy(),
			}),
			expect.anything(),
		);
	});
	it("does not reprice or reserve an accepted replay when new admission is closed", async () => {
		vi.mocked(findExistingVideoAdmission).mockResolvedValue({ id: "job-1" } as never);
		await createVideoJob(
			{ userId: "owner" },
			{ quoteId: "old-quote", idempotencyKey: "request", request: legacyRequest },
			{ ...options, environment: {} },
		);
		expect(resolveVideoModelPrice).not.toHaveBeenCalled();
		expect(createVideoJobRecord).not.toHaveBeenCalled();
	});
	it("resolves explicit server-owned visual, Waffo prompt and not-requested audio policies", () => {
		const result = requireVideoAdmission({ userId: "owner" }, environment, bindings, legacyRequest);
		expect(result.visualSafetyProfile).toEqual(createVideoVisualSafetyProfile("seeapi", 5));
		expect(result.visualSafetyProfile).not.toHaveProperty("apiKey");
		expect(result.textSafetyProfile).toEqual(createVideoTextSafetyProfile());
		expect(result.audioSafetyPolicy).toEqual(createVideoAudioSafetyPolicy());
	});
	it.each([undefined, createVideoVisualSafetyProfile("sightengine", 5).policyVersion])(
		"rejects missing or previous-provider cost confirmation %s before pricing",
		(policyVersion) => {
			expect(() =>
				requireVideoAdmission(
					{ userId: "owner" },
					{ ...environment, VIDEO_COST_VISUAL_POLICY_VERSION: policyVersion },
					bindings,
					legacyRequest,
				),
			).toThrow("VIDEO_VISUAL_COST_POLICY_NOT_CONFIRMED");
			expect(resolveVideoModelPrice).not.toHaveBeenCalled();
		},
	);
	it("admits native sound with its explicit not-requested audio review policy and no audio key", () => {
		const result = requireVideoAdmission({ userId: "owner" }, environment, bindings, {
			...legacyRequest,
			productKey: "video-minimax-h3",
			resolution: "768p",
			sound: true,
		});
		expect(result.audioSafetyPolicy).toEqual(createVideoAudioSafetyPolicy());
		expect(resolveVideoModelPrice).toHaveBeenCalledOnce();
	});
	it.each([undefined, "retired-text-policy"])(
		"rejects unconfirmed Waffo text cost policy %s before pricing",
		(ruleVersion) => {
			expect(() =>
				requireVideoAdmission(
					{ userId: "owner" },
					{ ...environment, VIDEO_COST_TEXT_RULE_VERSION: ruleVersion },
					bindings,
					legacyRequest,
				),
			).toThrow("VIDEO_TEXT_COST_POLICY_NOT_CONFIRMED");
			expect(resolveVideoModelPrice).not.toHaveBeenCalled();
		},
	);
	it("rejects missing Waffo signing configuration before pricing or reservation", () => {
		expect(() =>
			requireVideoAdmission(
				{ userId: "owner" },
				{ ...environment, WAFFO_PRIVATE_KEY: "" },
				bindings,
				legacyRequest,
			),
		).toThrow("VIDEO_MODERATION_NOT_CONFIGURED");
		expect(resolveVideoModelPrice).not.toHaveBeenCalled();
		expect(createVideoJobRecord).not.toHaveBeenCalled();
	});
});
