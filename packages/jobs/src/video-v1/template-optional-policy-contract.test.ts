import { parseEnv } from "node:util";

import {
	VIDEO_EFFECT_RETAIL_PRICE_VERSION,
	HOTEL_LOBBY_LONG_TEMPLATE_VERSION,
	RAINDANCE_LONG_TEMPLATE_VERSION,
} from "@repo/config/video-effects";
import {
	HOTEL_LOBBY_TEMPLATE_VERSION,
	RAINDANCE_TEMPLATE_VERSION,
	HOTEL_LOBBY_PRICE_VERSION,
	HOTEL_LOBBY_SAFETY_POLICY_VERSION,
	parseVideoEffectTemplateSnapshot,
} from "@repo/config/video-effects.server";
import { VIDEO_MODEL_CATALOG_VERSION } from "@repo/config/video-models";
import { VIDEO_SUPPLIER_PRICE_VERSION } from "@repo/config/video-pricing.server";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

import { readCloudflareBuildEnvironment } from "../../../../apps/web-host/src/build-secrets";
import legacyHotelTemplates from "./fixtures/hotel-lobby-legacy-templates.json";
vi.mock("@repo/database", () => ({ getActiveRuntimeConfigOverrides: vi.fn(async () => []) }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database/video-retail-eligibility", () => ({
	resolveVideoRetailEligibility: vi.fn(async () => ({ audience: "standard" })),
}));
vi.mock("@repo/database/video-v1", () => ({
	createVideoJobRecord: vi.fn(),
	findExistingVideoAdmission: vi.fn(),
	getVideoJobRecord: vi.fn(),
	listVideoJobRecords: vi.fn(),
}));
vi.mock("@repo/database/video-v1-fulfillment", () => ({ authorizeVideoPlayback: vi.fn() }));
vi.mock("@repo/database/video-template", () => ({
	createVideoTemplateQuoteRecord: vi.fn(),
	createVideoTemplateJobRecord: vi.fn(),
	findExistingVideoTemplateAdmission: vi.fn(),
	getVideoTemplateJobRecord: vi.fn(),
	listVideoTemplateJobRecords: vi.fn(),
}));
vi.mock("./admission", async (original) => ({
	...(await original<typeof import("./admission")>()),
	ensureVideoWorkflowStarted: vi.fn(),
}));
vi.mock("../../../../packages/auth/index.ts", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/storage", () => ({ headObject: vi.fn(), readPrivateMediaStream: vi.fn() }));
import {
	createVideoTemplateQuoteRecord,
	createVideoTemplateJobRecord,
	findExistingVideoTemplateAdmission,
	getVideoTemplateJobRecord,
	listVideoTemplateJobRecords,
} from "@repo/database/video-template";
import { authorizeVideoPlayback } from "@repo/database/video-v1-fulfillment";

import { createVideoPlayback } from "../../../../packages/api/modules/video-v1/playback";
import { verifyPlaybackGrant } from "../../../../packages/api/modules/video-v1/playback-policy";
import { ensureVideoWorkflowStarted } from "./admission";
import {
	createVideoTemplateQuote,
	createVideoTemplateJob,
	requireVideoTemplateAdmission,
	readVideoEffectTestReadiness,
	getVideoTemplatePublicState,
	listVideoTemplatePublicStates,
} from "./template-admission";
const pricePolicy = {
	VIDEO_EFFECT_RETAIL_PRICE_ACCEPTED_VERSION: VIDEO_EFFECT_RETAIL_PRICE_VERSION,
	HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION: HOTEL_LOBBY_TEMPLATE_VERSION,
	HOTEL_LOBBY_DUO_ACCEPTED_LONG_TEMPLATE_VERSION: HOTEL_LOBBY_LONG_TEMPLATE_VERSION,
	RAINDANCE_ENABLED: "true",
	RAINDANCE_ACCESS: "authenticated",
	RAINDANCE_ACCEPTED_TEMPLATE_VERSION: RAINDANCE_TEMPLATE_VERSION,
	RAINDANCE_ACCEPTED_LONG_TEMPLATE_VERSION: RAINDANCE_LONG_TEMPLATE_VERSION,
	HOTEL_LOBBY_DUO_PRICE_VERSION: HOTEL_LOBBY_PRICE_VERSION,
	HOTEL_LOBBY_DUO_PRICE_BASIS: "SYNTHETIC_TEST_BUDGET_ONLY",
	HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: "2099-01-01T00:00:00Z",
	HOTEL_LOBBY_DUO_COST_POLICY_VERSION: HOTEL_LOBBY_SAFETY_POLICY_VERSION,
	HOTEL_LOBBY_DUO_PAYMENT_COST_BASIS: "SYNTHETIC_TEST_BUDGET_ONLY",
	HOTEL_LOBBY_DUO_TEXT_COST_RULE_VERSION: "waffo-prompt-safety-2026-10-04.1",
	HOTEL_LOBBY_DUO_TEXT_COST_BASIS: "SYNTHETIC_TEST_BUDGET_ONLY",
	HOTEL_LOBBY_DUO_TEXT_REVIEW_COST_MICROS: "0",
	HOTEL_LOBBY_DUO_SCENE_PROVIDER_COST_MICROS: "20000",
	HOTEL_LOBBY_DUO_INPUT_REVIEW_COST_MICROS: "5100",
	HOTEL_LOBBY_DUO_SCENE_REVIEW_COST_MICROS: "5100",
	HOTEL_LOBBY_DUO_ADDITIONAL_RUNTIME_COST_MICROS: "100000",
	HOTEL_LOBBY_DUO_ADDITIONAL_STORAGE_COST_MICROS: "10000",
	VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
	VIDEO_PRICE_BASIS: "SYNTHETIC_TEST_BUDGET_ONLY",
	VIDEO_PRICE_VALID_UNTIL: "none",
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
	VIDEO_COST_VISUAL_POLICY_VERSION: "seeapi-video-policy-2026-10-04.1",
	VIDEO_COST_TEXT_RULE_VERSION: "waffo-prompt-safety-2026-10-04.1",
	VIDEO_COST_MODERATION_BASE_MICROS: "5100",
	VIDEO_COST_MODERATION_PER_SECOND_MICROS: "200",
	VIDEO_COST_RUNTIME_MICROS: "100000",
	VIDEO_COST_STORAGE_MICROS: "10000",
	VIDEO_COST_PAYMENT_FIXED_MICROS: "0",
	VIDEO_COST_PAYMENT_FEE_BPS: "654",
	VIDEO_COST_NONBILLABLE_FAILURE_BPS: "1000",
};
const environment = {
	...pricePolicy,
	VIDEO_V1_ENABLED: "true",
	VIDEO_V1_ACCESS: "authenticated",
	HOTEL_LOBBY_DUO_ENABLED: "true",
	HOTEL_LOBBY_DUO_ACCESS: "authenticated",
	RUMPELSTILTSKIN_ENABLED: "false",
	MEDIA_GENERATION_ENABLED: "true",
	MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
	MEDIA_ENABLED_PROVIDERS: "kie",
	VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
	KIE_API_KEY: "local-fixture",
	KIE_WEBHOOK_SECRET: "local-fixture",
	SEEAPI_API_KEY: "local-fixture",
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
		whkey_test: "whsec_local_fixture_signing_secret_20261004",
	}),
	VIDEO_SEEAPI_CALLBACK_SECRET: "local-fixture-video-seeapi-callback-secret-20261004",
	VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
	VIDEO_V1_IMAGE_SAFETY_ADAPTER: "seeapi",
	WAFFO_MERCHANT_ID: "local-fixture",
	WAFFO_PRIVATE_KEY: "local-fixture",
	NEXT_PUBLIC_SAAS_URL: "https://video.example.test",
	VIDEO_V1_PROVIDER_CONCURRENCY: "5",
	VIDEO_V1_OUTPUT_ALLOWED_HOSTS: "cdn.example.test",
};
const request = {
	effectId: "hotel-lobby-duo" as const,
	presetKey: "standard" as const,
	inputs: { leftAssetId: "left-fixture", rightAssetId: "right-fixture" },
};
const context = { userId: "owner-fixture", role: "user" };
const bindings = { workflow: true, r2: true, hyperdrive: true, uploadCors: true };
const limits = { maximumStorageBytes: 1000000000n, maximumInputBytes: 10000000 };
const invalidCases = [
	[
		"approved price drift",
		{ HOTEL_LOBBY_DUO_SCENE_PROVIDER_COST_MICROS: "40000" },
		"VIDEO_EFFECT_APPROVED_PRICES_CHANGED",
	],
	[
		"approved markup drift",
		{ HOTEL_LOBBY_DUO_PRICE_MARKUP_BPS: "20001" },
		"VIDEO_EFFECT_APPROVED_MARKUP_CHANGED",
	],
	[
		"missing price version",
		{ HOTEL_LOBBY_DUO_PRICE_VERSION: undefined },
		"VIDEO_EFFECT_PRICE_NOT_APPROVED",
	],
	[
		"invalid price version",
		{ HOTEL_LOBBY_DUO_PRICE_VERSION: "unknown" },
		"VIDEO_EFFECT_PRICE_NOT_APPROVED",
	],
	[
		"missing price basis",
		{ HOTEL_LOBBY_DUO_PRICE_BASIS: undefined },
		"VIDEO_EFFECT_PRICE_NOT_APPROVED",
	],
	[
		"missing cost policy",
		{ HOTEL_LOBBY_DUO_COST_POLICY_VERSION: undefined },
		"VIDEO_EFFECT_COST_POLICY_NOT_CONFIRMED",
	],
	[
		"invalid cost policy",
		{ HOTEL_LOBBY_DUO_COST_POLICY_VERSION: "unknown" },
		"VIDEO_EFFECT_COST_POLICY_NOT_CONFIRMED",
	],
	[
		"missing payment basis",
		{ HOTEL_LOBBY_DUO_PAYMENT_COST_BASIS: undefined },
		"VIDEO_EFFECT_PAYMENT_COST_NOT_CONFIRMED",
	],
	[
		"invalid cost input",
		{ HOTEL_LOBBY_DUO_SCENE_PROVIDER_COST_MICROS: "invalid" },
		"VIDEO_EFFECT_COST_POLICY_NOT_CONFIGURED",
	],
	[
		"invalid markup",
		{ HOTEL_LOBBY_DUO_PRICE_MARKUP_BPS: "1" },
		"VIDEO_EFFECT_PRICING_TARGET_INVALID",
	],
] as const;
function buildTransport(patch: Record<string, string | undefined> = {}) {
	const values = { ...environment, ...patch };
	const source = Object.entries(values)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}='${value}'`)
		.join("\n");
	return parseEnv(readCloudflareBuildEnvironment({ CLOUDFLARE_PRODUCTION_ENV: source }));
}
// Freeze the complete pre-migration receipt, including the original prompt and its version.
const template = parseVideoEffectTemplateSnapshot(legacyHotelTemplates[5]);
function accepted() {
	return {
		id: "accepted-fixture",
		status: "SUCCEEDED",
		creditsReserved: 69n,
		updatedAt: new Date(0),
		reservation: { status: "SETTLED" },
		videoExecution: { stage: "READY", stageData: {} },
		videoTemplateExecution: {
			templateSnapshot: template,
			sceneState: "READY",
			sceneSubmissionUncertain: false,
			updatedAt: new Date(0),
		},
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(findExistingVideoTemplateAdmission).mockResolvedValue(null);
	vi.mocked(getVideoTemplateJobRecord).mockResolvedValue(accepted() as never);
	vi.mocked(authorizeVideoPlayback).mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());
describe("optional build transport preserves mandatory runtime gates", () => {
	it.each([undefined, "2000-01-01T00:00:00Z", "invalid-date"])(
		"does not stop valid new quotes or jobs at retired price deadline %s",
		async (deadline) => {
			const runtime = buildTransport({
				HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: deadline,
				VIDEO_PRICE_VALID_UNTIL: deadline,
			});
			expect(
				requireVideoTemplateAdmission(context, runtime, bindings, request).price,
			).toMatchObject({
				credits: 92n,
				pricingDetails: { priceApprovalExpiryMode: "none", validUntil: null },
			});
			const expiresAt = new Date(Date.now() + 600_000);
			vi.mocked(createVideoTemplateQuoteRecord).mockResolvedValue({
				quoteId: "new-quote",
				credits: "69",
				expiresAt: expiresAt.toISOString(),
			} as never);
			await expect(
				createVideoTemplateQuote(context, request, {
					bindings,
					maximumInputBytes: 10_000_000,
					environment: runtime,
				}),
			).resolves.toMatchObject({ quoteId: "new-quote", expiresAt: expiresAt.toISOString() });
			vi.mocked(createVideoTemplateJobRecord).mockResolvedValue({
				jobId: "accepted-fixture",
			} as never);
			await expect(
				createVideoTemplateJob(
					context,
					{ quoteId: "new-quote", idempotencyKey: "new-confirmation", request },
					{ bindings, limits, environment: runtime },
				),
			).resolves.toMatchObject({ credits: "69" });
			expect(createVideoTemplateJobRecord).toHaveBeenCalledOnce();
			expect(ensureVideoWorkflowStarted).toHaveBeenCalledOnce();
		},
	);

	it.each(invalidCases.slice(0, 2))(
		"refuses ten-second annual %s using the same actual eligibility audience",
		(_label, patch, reason) => {
			expect(() =>
				requireVideoTemplateAdmission(
					context,
					buildTransport(patch),
					bindings,
					{ ...request, duration: 10 },
					{ audience: "annual" },
				),
			).toThrow(reason);
			expect(createVideoTemplateQuoteRecord).not.toHaveBeenCalled();
			expect(createVideoTemplateJobRecord).not.toHaveBeenCalled();
			expect(ensureVideoWorkflowStarted).not.toHaveBeenCalled();
		},
	);
	it.each(["hotel-lobby-duo", "raindance-solo", "raindance-duo"] as const)(
		"retains approved %s prices for each duration and real audience context",
		(effectId) => {
			for (const duration of [5, 10] as const)
				for (const audience of ["standard", "annual"] as const) {
					const input = {
						...request,
						effectId,
						...(duration === 10 ? { duration: 10 as const } : {}),
						inputs: { leftAssetId: "same", rightAssetId: "same" },
					};
					const price = requireVideoTemplateAdmission(context, buildTransport(), bindings, input, {
						audience,
					}).price;
					expect(price.credits).toBe(duration === 5 ? 92n : audience === "annual" ? 154n : 178n);
					expect(price.paidFundingPolicy).toBeUndefined();
					expect(price.pricingDetails).toMatchObject({
						funding: { mode: "shared-media-credits-v1" },
						paidRevenueQualified: false,
						retailReference: { creditFloorMicros: "21944" },
					});
					expect(price.pricingDetails).not.toHaveProperty("minimumGrossRevenueMicros");
				}
		},
	);
	it("admits the complete synthetic approved policy through real pricing and readiness", () => {
		expect(
			requireVideoTemplateAdmission(context, buildTransport(), bindings, request).price.credits,
		).toBe(92n);
	});
	it.each(invalidCases)(
		"keeps %s unavailable for new quote and create despite build transport",
		async (_label, patch, error) => {
			const runtime = buildTransport(patch);
			for (const [key, value] of Object.entries(patch)) expect(runtime[key]).toBe(value);
			// The legacy readiness array describes Rumpel material only. Hotel's empty
			// array cannot replace the actual admission/price check.
			expect(readVideoEffectTestReadiness(request.effectId, runtime)).toEqual([]);
			expect(() => requireVideoTemplateAdmission(context, runtime, bindings, request)).toThrow(
				error,
			);
			await expect(
				createVideoTemplateQuote(context, request, {
					bindings,
					maximumInputBytes: 10000000,
					environment: runtime,
				}),
			).rejects.toThrow(error);
			await expect(
				createVideoTemplateJob(
					context,
					{ quoteId: "quote-fixture", idempotencyKey: "confirmation-fixture", request },
					{ bindings, limits, environment: runtime },
				),
			).rejects.toThrow(error);
			expect(createVideoTemplateQuoteRecord).not.toHaveBeenCalled();
			expect(createVideoTemplateJobRecord).not.toHaveBeenCalled();
			expect(ensureVideoWorkflowStarted).not.toHaveBeenCalled();
		},
	);
	it.each([
		["VIDEO_V1_ENABLED", "false"],
		["HOTEL_LOBBY_DUO_ACCESS", "internal"],
		["HOTEL_LOBBY_DUO_ENABLED", "false"],
	])("retains the %s audience gate", (key, value) => {
		expect(() =>
			requireVideoTemplateAdmission(context, { ...environment, [key]: value }, bindings, request),
		).toThrow("VIDEO_ACCESS_DENIED");
	});
	it("retains ordinary model, safety and real binding requirements", () => {
		expect(() =>
			requireVideoTemplateAdmission(
				context,
				{ ...environment, SEEAPI_API_KEY: "" },
				bindings,
				request,
			),
		).toThrow("VIDEO_VISUAL_MODERATION_NOT_CONFIGURED");
		expect(() =>
			requireVideoTemplateAdmission(
				context,
				{ ...environment, VIDEO_MODEL_CONTRACT_VERSION: "invalid" },
				bindings,
				request,
			),
		).toThrow("VIDEO_MODEL_CONTRACT_NOT_CONFIRMED");
		expect(() =>
			requireVideoTemplateAdmission(
				context,
				environment,
				{ ...bindings, workflow: false },
				request,
			),
		).toThrow("VIDEO_BINDING_WORKFLOW_NOT_READY");
	});
});
describe("accepted contracts ignore current optional price policy", () => {
	it.each(invalidCases)("recovers an accepted confirmation despite %s", async (_label, patch) => {
		vi.mocked(findExistingVideoTemplateAdmission).mockResolvedValue({
			id: "accepted-fixture",
		} as never);
		const result = await createVideoTemplateJob(
			context,
			{ quoteId: "expired-original-quote", idempotencyKey: "same-confirmation", request },
			{
				bindings: {},
				limits,
				environment: { ...environment, ...patch, HOTEL_LOBBY_DUO_ENABLED: "false" },
			},
		);
		expect(result).toMatchObject({
			jobId: "accepted-fixture",
			credits: "69",
			templateVersion: template.templateVersion,
		});
		expect(findExistingVideoTemplateAdmission).toHaveBeenCalledWith(
			expect.objectContaining({
				ownerId: context.userId,
				idempotencyKey: "same-confirmation",
				request,
			}),
			expect.anything(),
		);
		expect(ensureVideoWorkflowStarted).toHaveBeenCalledWith("accepted-fixture", undefined);
		expect(createVideoTemplateJobRecord).not.toHaveBeenCalled();
	});
	it("retains owner-scoped frozen reads and does not treat any current expiry as a new contract", async () => {
		vi.stubEnv("HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL", "invalid");
		vi.stubEnv("HOTEL_LOBBY_DUO_COST_POLICY_VERSION", "invalid");
		expect(await getVideoTemplatePublicState(context, "accepted-fixture")).toMatchObject({
			stage: "READY",
			credits: "69",
			canPlay: false,
		});
		expect(getVideoTemplateJobRecord).toHaveBeenCalledWith(
			context.userId,
			"accepted-fixture",
			expect.anything(),
		);
		vi.mocked(listVideoTemplateJobRecords).mockResolvedValue({
			rows: [accepted()],
			nextCursor: null,
		} as never);
		expect((await listVideoTemplatePublicStates(context, {})).items[0]).toMatchObject({
			jobId: "accepted-fixture",
			credits: "69",
		});
		expect(listVideoTemplateJobRecords).toHaveBeenCalledWith(context.userId, {}, expect.anything());
		vi.mocked(getVideoTemplateJobRecord).mockRejectedValueOnce(new Error("NOT_FOUND"));
		await expect(
			getVideoTemplatePublicState({ userId: "other-owner" }, "accepted-fixture"),
		).rejects.toThrow("NOT_FOUND");
	});
	it("still signs an owner-authorized settled download without current effect pricing, retaining content/expiry/download binding", async () => {
		const secret = "local-only-playback-signing-fixture-at-least-32";
		vi.stubEnv("BETTER_AUTH_SECRET", secret);
		vi.stubEnv("HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL", "2000-01-01");
		vi.stubEnv("HOTEL_LOBBY_DUO_COST_POLICY_VERSION", "invalid");
		vi.mocked(authorizeVideoPlayback).mockResolvedValue({
			id: "output-fixture",
			checksum: "a".repeat(64),
			verificationValidUntil: new Date(Date.now() + 600000),
			deleteAfter: null,
		} as never);
		const link = await createVideoPlayback(context.userId, "accepted-fixture", true);
		const params = new URL(link.url, "https://local.test").searchParams;
		const identity = {
			userId: context.userId,
			jobId: "accepted-fixture",
			assetId: "output-fixture",
			checksum: "a".repeat(64),
			expires: Number(params.get("expires")),
			download: true,
		};
		expect(authorizeVideoPlayback).toHaveBeenCalledWith(context.userId, "accepted-fixture");
		expect(verifyPlaybackGrant(identity, params.get("signature")!, secret)).toBe(true);
		expect(
			verifyPlaybackGrant({ ...identity, download: false }, params.get("signature")!, secret),
		).toBe(false);
		vi.mocked(authorizeVideoPlayback).mockResolvedValue(null);
		await expect(createVideoPlayback("other-owner", "accepted-fixture", true)).rejects.toThrow(
			"NOT_FOUND",
		);
	});
});
