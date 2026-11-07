import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { sourceTemplatePriceKey } from "@repo/config/video-template-display-pricing";
import {
	encodeSourceTemplatePrices,
	sourceTemplateProvisionSchema,
} from "@repo/config/video-template-execution.server";
import { sourceTemplateDefaults } from "@repo/config/video-template-library";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	findUnique: vi.fn(),
	configuration: vi.fn(),
	create: vi.fn(),
	replay: vi.fn(),
	references: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({
	db: {
		generationJob: { findUnique: store.findUnique },
		runtimeConfigOverride: { findFirst: store.configuration },
		$transaction: (run: (tx: unknown) => unknown) => run({}),
	},
}));
vi.mock("@repo/database/video-source-template-review", () => ({
	findApprovedSourceTemplateReferences: store.references,
}));
vi.mock("@repo/database/video-v1", () => ({
	createVideoQuoteRecord: vi.fn(),
	createVideoJobRecord: store.create,
	findExistingVideoAdmission: store.replay,
	listVideoJobRecords: vi.fn(),
}));
vi.mock("./admission", () => ({}));
import {
	normalizeSourceTemplateRequest,
	resolveSourceTemplateAdmission,
	replaceSourceTemplateUrls,
	createSourceTemplateJob,
	SourceTemplateNotAdmittedError,
	findExistingSourceTemplateAdmission,
	sourceTemplateAccess,
} from "./source-template-admission";

const environment = {
	VIDEO_V1_ENABLED: "true",
	MEDIA_GENERATION_ENABLED: "true",
	VIDEO_V1_ACCESS: "authenticated",
	NEXT_PUBLIC_SAAS_URL: "https://example.test",
	VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
	VIDEO_V1_IMAGE_SAFETY_ADAPTER: "seeapi",
	SEEAPI_API_KEY: "test-only",
	WAFFO_MERCHANT_ID: "test-only",
	WAFFO_PRIVATE_KEY: "test-only",
	VIDEO_SEEAPI_CALLBACK_SECRET: "test-only-callback-secret-1234567890",
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({ whkey_test: "whsec_test_only_secret_1234567890" }),
	VIDEO_COST_VISUAL_POLICY_VERSION: createVideoVisualSafetyProfile("seeapi", 12).policyVersion,
	VIDEO_COST_TEXT_RULE_VERSION: createVideoTextSafetyProfile().ruleVersion,
	VIDEO_V1_OUTPUT_ALLOWED_HOSTS: "example.test",
};
const bindings = { workflow: true, r2: true, hyperdrive: true, uploadCors: true };
const request = {
	templateKey: "original-rap" as const,
	options: sourceTemplateDefaults("original-rap"),
	inputs: [
		{ role: "performer-1" as const, assetId: "left" },
		{ role: "performer-2" as const, assetId: "right" },
	],
};
function configuration() {
	return {
		receipt: { id: "config", version: 1 },
		provision: {
			version: "source-original-v1",
			enabled: true,
			access: "authenticated" as const,
			sourceConfig: {},
			references: [],
			prices: [
				{
					options: request.options,
					credits: "123",
					providerCostMicros: "1000000",
					moderationCostMicros: "1000",
					pricingVersion: "target-test-only-price",
					pricingBasis: "LOCAL TEST ONLY; NO SOURCE CREDIT CONVERSION",
				},
			],
		},
	};
}
describe("source template frozen admission", () => {
	it("returns only public prices from one provision read and skips reference reads for uploads", async () => {
		vi.clearAllMocks();
		const config = configuration();
		store.configuration.mockResolvedValue({ id: "config", version: 1, value: config.provision });
		const access = await sourceTemplateAccess(
			{ userId: "owner" },
			"original-rap",
			bindings,
			environment,
		);
		expect(access.available).toBe(true);
		expect(access.pricing).toEqual({
			version: 1,
			creditsByOptions: { [sourceTemplatePriceKey(request.options)]: "123" },
		});
		expect(store.configuration).toHaveBeenCalledTimes(1);
		expect(store.references).toHaveBeenCalledTimes(1);
		store.references.mockClear();
		const upload = await sourceTemplateAccess(
			{ userId: "owner" },
			"original-rap",
			bindings,
			environment,
			{ forUpload: true },
		);
		expect(upload.available).toBe(true);
		expect(upload.pricing).toBeNull();
		expect(store.references).not.toHaveBeenCalled();
		store.configuration.mockResolvedValueOnce({
			id: "config",
			version: 1,
			value: { ...config.provision, enabled: false },
		});
		expect(
			(
				await sourceTemplateAccess({ userId: "owner" }, "original-rap", bindings, environment, {
					forUpload: true,
				})
			).available,
		).toBe(false);
	});
	it("freezes the same complete quote from legacy or compact provision and expands only the chosen price", () => {
		const legacy = configuration();
		const shared = "Local immutable price evidence. ".repeat(80);
		legacy.provision.prices[0]!.pricingBasis = JSON.stringify({ shared, cost: "selected" });
		const unused = {
			...legacy.provision.prices[0]!,
			options: { ...request.options, durationSeconds: 5 as const },
			pricingBasis: JSON.stringify({ shared, cost: "unused" }),
		};
		const pricing = encodeSourceTemplatePrices([unused, legacy.provision.prices[0]!]);
		const compact = {
			...legacy,
			provision: sourceTemplateProvisionSchema.parse({ ...legacy.provision, ...pricing }),
		};
		Object.defineProperty(compact.provision.pricingBasisDictionary!.overrides, 0, {
			get: () => {
				throw new Error("UNSELECTED_PRICE_EXPANDED");
			},
		});
		const oldAdmission = resolveSourceTemplateAdmission(
			{ userId: "owner" },
			request,
			environment,
			bindings,
			legacy,
		);
		const newAdmission = resolveSourceTemplateAdmission(
			{ userId: "owner" },
			request,
			environment,
			bindings,
			compact,
		);
		expect(newAdmission).toEqual(oldAdmission);
		expect(newAdmission.price).not.toHaveProperty("pricingBasisRef");
		expect(newAdmission.request.sourceTemplate).not.toHaveProperty("pricingBasisDictionary");
	});
	it("admits the exact provider-owned Hotel request without adding a prompt or duration", () => {
		const config = configuration();
		const options = sourceTemplateDefaults("source-hotel-lobby");
		config.provision.prices[0]!.options = options;
		const admitted = resolveSourceTemplateAdmission(
			{ userId: "owner" },
			{
				templateKey: "source-hotel-lobby",
				options,
				inputs: request.inputs,
			},
			environment,
			bindings,
			config,
		);
		expect(admitted.request.prompt).toBeNull();
		expect(admitted.request.duration).toBeNull();
		expect(admitted.request.sourceTemplate.transport).toMatchObject({
			executionContract: "provider-owned-template",
			endpoint: "hotel-lobby-ai",
			prompt: null,
			output: { durationSeconds: null },
		});
		expect(admitted.request.sourceTemplate.transport.body).toEqual({
			provider: "seeapi",
			input: {
				reference_images: [
					"https://ezpic-template.example/user/performer-1",
					"https://ezpic-template.example/user/performer-2",
				],
				resolution: "768P",
				aspect_ratio: "9:16",
			},
		});
		expect(admitted.visualSafetyProfile.sampling).toMatchObject({ numFrames: 32 });
		expect(() =>
			resolveSourceTemplateAdmission(
				{ userId: "owner" },
				{
					templateKey: "source-hotel-lobby",
					options,
					inputs: request.inputs,
				},
				{
					...environment,
					VIDEO_V1_TEXT_SAFETY_ADAPTER: "",
					WAFFO_MERCHANT_ID: "",
					WAFFO_PRIVATE_KEY: "",
					VIDEO_COST_TEXT_RULE_VERSION: "",
				},
				bindings,
				config,
			),
		).not.toThrow();
		expect(() =>
			resolveSourceTemplateAdmission(
				{ userId: "owner" },
				{
					templateKey: "source-hotel-lobby",
					options,
					inputs: request.inputs,
				},
				{ ...environment, VIDEO_V1_IMAGE_SAFETY_ADAPTER: "" },
				bindings,
				config,
			),
		).toThrow("VIDEO_IMAGE_MODERATION_NOT_CONFIGURED");
	});
	it("replays omitted historical options from the accepted snapshot rather than current defaults", async () => {
		const admitted = resolveSourceTemplateAdmission(
			{ userId: "owner" },
			{ ...request, options: { ...request.options, stageId: "neon-rap" } },
			environment,
			bindings,
			configuration(),
		);
		store.findUnique.mockResolvedValueOnce({ inputSnapshot: admitted.request });
		store.replay.mockResolvedValueOnce({ id: "accepted-job" });
		expect(
			await findExistingSourceTemplateAdmission("owner", "stable-key", { ...request, options: {} }),
		).toEqual({ id: "accepted-job" });
	});
	it("marks proven gate failures after replay lookup but never an unknown commit", async () => {
		store.findUnique.mockResolvedValue(null);
		const configured = configuration();
		store.configuration.mockResolvedValue({
			id: "config",
			version: 1,
			value: configured.provision,
		});
		const input = { quoteId: "quote", idempotencyKey: "stable-key", request };
		const options = {
			environment,
			bindings,
			limits: { maximumStorageBytes: 1000000000n, maximumInputBytes: 10000000 },
		};
		await expect(
			createSourceTemplateJob({ userId: "owner" }, input, {
				...options,
				environment: { ...environment, MEDIA_GENERATION_ENABLED: "false" },
			}),
		).rejects.toBeInstanceOf(SourceTemplateNotAdmittedError);
		store.create.mockRejectedValueOnce(new Error("DATABASE_COMMIT_RESPONSE_LOST"));
		try {
			await createSourceTemplateJob({ userId: "owner" }, input, options);
		} catch (error) {
			expect(error).not.toBeInstanceOf(SourceTemplateNotAdmittedError);
			expect((error as Error).message).toBe("DATABASE_COMMIT_RESPONSE_LOST");
		}
		store.create.mockRejectedValueOnce(new Error("INSUFFICIENT_CREDITS"));
		await expect(
			createSourceTemplateJob({ userId: "owner" }, input, options),
		).rejects.toBeInstanceOf(SourceTemplateNotAdmittedError);
		store.create.mockRejectedValueOnce(new Error("CREDIT_DEBT_OUTSTANDING"));
		await expect(
			createSourceTemplateJob({ userId: "owner" }, input, options),
		).rejects.toMatchObject({
			submissionDisposition: "not_admitted",
			message: "CREDIT_DEBT_OUTSTANDING",
		});
	});
	it("freezes exact source body, roles and independent target credits without a scene stage", () => {
		const admitted = resolveSourceTemplateAdmission(
			{ userId: "owner" },
			request,
			environment,
			bindings,
			configuration(),
		);
		expect(admitted.price.credits).toBe(123n);
		expect(admitted.price.pricingDetails).toEqual({
			paidRevenueQualified: false,
			funding: { mode: "shared-media-credits-v1" },
		});
		expect(admitted.request.sourceTemplate.transport).toMatchObject({
			provider: "seeapi",
			modelId: "seedance-2-mini",
			endpoint: "reference-to-video",
		});
		expect(admitted.request.sourceTemplate.request.inputs).toEqual(request.inputs);
		expect(admitted.request).not.toHaveProperty("videoEffectTemplate");
		expect(admitted.request.sourceTemplate.transport.body).toMatchObject({
			input: {
				reference_images: [
					"https://ezpic-template.example/user/performer-1",
					"https://ezpic-template.example/user/performer-2",
				],
			},
		});
	});
	it("does not substitute defaults when an original reference or target price is absent", () => {
		const config = configuration();
		config.provision.prices = [];
		expect(() =>
			resolveSourceTemplateAdmission({ userId: "owner" }, request, environment, bindings, config),
		).toThrow("VIDEO_TEMPLATE_PRICE_REQUIRED");
		expect(() =>
			resolveSourceTemplateAdmission(
				{ userId: "owner" },
				{ templateKey: "bulin-47", options: {}, inputs: [{ role: "performer-1", assetId: "one" }] },
				environment,
				bindings,
				configuration(),
			),
		).toThrow("VIDEO_TEMPLATE_REFERENCE_APPROVAL_REQUIRED");
	});
	it("rejects duplicate/swapped roles and client-only provider fields", () => {
		expect(() =>
			normalizeSourceTemplateRequest({ ...request, inputs: [...request.inputs].reverse() }),
		).toThrow("VIDEO_TEMPLATE_INPUT_ROLES_INVALID");
		expect(() =>
			normalizeSourceTemplateRequest({ ...request, options: { provider: "kie" } }),
		).toThrow("VIDEO_TEMPLATE_OPTIONS_INVALID");
		expect(() =>
			normalizeSourceTemplateRequest({
				...request,
				inputs: [
					{ role: "performer-1", assetId: "left" },
					{ role: "performer-2", assetId: "left" },
				],
			}),
		).toThrow("VIDEO_TEMPLATE_INPUT_ROLES_INVALID");
	});
	it("rejects an invented caller duration for the provider-owned Hotel endpoint", () => {
		expect(() =>
			resolveSourceTemplateAdmission(
				{ userId: "owner" },
				{ ...request, templateKey: "source-hotel-lobby", options: { durationSeconds: 15 } },
				environment,
				bindings,
				configuration(),
			),
		).toThrow("SOURCE_TEMPLATE_OPTIONS_INVALID");
	});
	it("rebinds exact URL values while preserving text and ordering", () => {
		const from = "https://ezpic-template.example/reference/0";
		expect(
			replaceSourceTemplateUrls(
				{ prompt: `Keep ${from} in this literal instruction`, images: [from, "unrelated"] },
				new Map([[from, "https://private.example/signed"]]),
			),
		).toEqual({
			prompt: `Keep ${from} in this literal instruction`,
			images: ["https://private.example/signed", "unrelated"],
		});
	});
});
