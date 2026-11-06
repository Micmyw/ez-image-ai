import { describe, expect, it } from "vitest";

import {
	DEFAULT_SEEAPI_CREDIT_USD_BASIS,
	resolveSourceTemplatePrice,
	seeapiSupplierCreditsCostMicros,
	type SourceTemplatePriceRequest,
} from "./source-template-pricing.server";
import { calculateVideoRetailPrice } from "./video-pricing.server";
import { packVideoRuntimeEnvironment } from "./video-runtime-environment";
import {
	sourceTemplateDefaults,
	sourceTemplateRoles,
	type SourceTemplateChoices,
	type SourceTemplateKey,
} from "./video-template-library";

/** Deliberately local mathematical fixtures, never production cost evidence. */
function environment(): Record<string, string> {
	return {
		VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
		VIDEO_COST_VISUAL_POLICY_VERSION: "seeapi-video-policy-2026-10-04.1",
		VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
		VIDEO_COST_TEXT_RULE_VERSION: "waffo-prompt-safety-2026-10-04.1",
		HOTEL_LOBBY_DUO_TEXT_COST_RULE_VERSION: "waffo-prompt-safety-2026-10-04.1",
		HOTEL_LOBBY_DUO_TEXT_COST_BASIS: "local fixture budget only",
		HOTEL_LOBBY_DUO_TEXT_REVIEW_COST_MICROS: "100",
		VIDEO_COST_RUNTIME_MICROS: "100000",
		VIDEO_COST_STORAGE_MICROS: "10000",
		VIDEO_COST_PAYMENT_FIXED_MICROS: "0",
		VIDEO_COST_PAYMENT_FEE_BPS: "750",
		VIDEO_COST_NONBILLABLE_FAILURE_BPS: "500",
	};
}
const models = {
	standard: "seedance-2-mini",
	fast: "seedance-2-fast",
	pro: "seedance-2",
	ultra: "seedance-2-5",
} as const;
const urls = (count: number) =>
	Array.from({ length: count }, (_, i) => `https://private.example/image-${i}`);
function seeapiRequest(
	templateKey: SourceTemplateKey = "original-rap",
	overrides: SourceTemplateChoices = {},
): SourceTemplatePriceRequest {
	const options = { ...sourceTemplateDefaults(templateKey), ...overrides };
	const images =
		sourceTemplateRoles(templateKey, options).length +
		(templateKey === "bulin-47" ? 2 : templateKey === "spin-me-round" ? 1 : 0);
	const endpoint = images ? "reference-to-video" : "text-to-video";
	const modelId = models[options.tier ?? "standard"];
	const output = {
		durationSeconds: options.durationSeconds!,
		resolution: options.resolution ?? "720p",
		aspectRatio: options.aspectRatio!,
		sound: true,
	};
	return {
		templateKey,
		options,
		transport: {
			provider: "seeapi",
			modelId,
			endpoint,
			output,
			body: {
				model: modelId,
				endpoint,
				provider: "seeapi",
				input: {
					prompt: "source prompt",
					duration_seconds: output.durationSeconds,
					resolution: output.resolution,
					aspect_ratio: output.aspectRatio,
					generate_audio: true,
					nsfw_checker: true,
					...(images ? { reference_images: urls(images) } : {}),
					...(templateKey === "bulin-47"
						? { reference_audio: ["https://private.example/audio"] }
						: {}),
				},
			},
		},
	};
}
function kieRequest(
	templateKey: SourceTemplateKey,
	resolution: "768P" | "2K" = "768P",
	preset?: SourceTemplateChoices["preset"],
): SourceTemplatePriceRequest {
	const options = {
		...sourceTemplateDefaults(templateKey),
		resolution,
		...(preset ? { preset } : {}),
	};
	const fixedCount =
		templateKey === "58th-floor" || templateKey === "green-booth-freestyle"
			? 3
			: templateKey.startsWith("flying-car-")
				? templateKey.includes("curved-ramp")
					? 6
					: 5
				: 2;
	const modelId = "minimax-h3/reference-to-video";
	return {
		templateKey,
		options,
		transport: {
			provider: "kie",
			modelId,
			endpoint: "reference-to-video",
			body: {
				model: modelId,
				input: {
					prompt: "source prompt",
					duration: options.durationSeconds,
					resolution,
					aspect_ratio: options.aspectRatio,
					reference_image_urls: urls(fixedCount + sourceTemplateRoles(templateKey, options).length),
					reference_audio_urls: ["https://private.example/audio"],
				},
			},
			output: {
				durationSeconds: options.durationSeconds!,
				resolution,
				aspectRatio: options.aspectRatio!,
				sound: true,
			},
		},
	};
}
function hotelRequest(resolution: "768P" | "2K" = "768P"): SourceTemplatePriceRequest {
	return {
		templateKey: "source-hotel-lobby",
		options: { preset: "duo", resolution, aspectRatio: "9:16" },
		transport: {
			executionContract: "provider-owned-template",
			provider: "seeapi",
			modelId: "hotel-lobby-ai",
			endpoint: "hotel-lobby-ai",
			body: {
				provider: "seeapi",
				input: { reference_images: urls(2), resolution, aspect_ratio: "9:16" },
			},
			output: { durationSeconds: null, resolution, aspectRatio: "9:16", sound: true },
		},
	};
}
function input(request: SourceTemplatePriceRequest) {
	return (request.transport.body as { input: Record<string, unknown> }).input;
}

describe("source-template supplier costs and existing shared-credit retail arithmetic", () => {
	it("defaults to the highest actual public Pay Once tariff, using rational USD conversion", () => {
		expect(DEFAULT_SEEAPI_CREDIT_USD_BASIS).toBe("creator-pay-once-299-30000");
		expect(seeapiSupplierCreditsCostMicros(1n)).toBe(9967n);
		expect(seeapiSupplierCreditsCostMicros(1n, 100n)).toBe(100n);
		expect(seeapiSupplierCreditsCostMicros(300n)).toBe(2_990_000n);
		expect(
			seeapiSupplierCreditsCostMicros(300n, 1n, {
				SEEAPI_CREDIT_USD_BASIS: "studio-annual-1199-320000",
			}),
		).toBe(1_124_063n);
		expect(() => seeapiSupplierCreditsCostMicros(1n, 0n)).toThrow("SOURCE_TEMPLATE_PRICE_INVALID");
	});

	const matrix = (
		[
			["standard", "480p", 10],
			["standard", "720p", 20],
			["fast", "480p", 16],
			["fast", "720p", 34],
			["pro", "480p", 26],
			["pro", "720p", 55],
			["pro", "1080p", 137],
			["ultra", "480p", 38],
			["ultra", "720p", 85],
			["ultra", "1080p", 211],
		] as const
	).flatMap(([tier, resolution, rate]) =>
		([5, 8, 10, 12, 15] as const).map((duration) => ({ tier, resolution, rate, duration })),
	);
	it.each(matrix)(
		"prices source $tier $resolution $duration seconds",
		({ tier, resolution, rate, duration }) => {
			const request = seeapiRequest("original-rap", {
				tier,
				resolution,
				durationSeconds: duration,
				preset: "text",
			});
			const price = resolveSourceTemplatePrice(request, environment());
			expect(BigInt(price.providerCostMicros)).toBe(
				(BigInt(rate * duration) * 299_000_000n + 29_999n) / 30_000n,
			);
			expect(BigInt(price.credits)).toBeGreaterThan(0n);
			expect(JSON.parse(price.pricingBasis)).toMatchObject({
				funding: "shared-media-credits-v1",
				paidRevenueQualified: false,
			});
		},
	);
	it("prices native audio references on the no-video rate without inventing mixing or scene costs", () => {
		const price = resolveSourceTemplatePrice(seeapiRequest("bulin-47"), environment());
		expect(price.providerCostMicros).toBe("2990000");
		expect(JSON.parse(price.pricingBasis).moderation).toMatchObject({
			userImages: 1,
			frames: 17,
			audioReview: "not_requested",
		});
	});
	it.each(["solo", "duo", "trio"] as const)(
		"adds each new Spin %s identity review only once",
		(preset) => {
			const result = resolveSourceTemplatePrice(
				seeapiRequest("spin-me-round", { preset }),
				environment(),
			);
			expect(JSON.parse(result.pricingBasis).moderation.userImages).toBe(
				{ solo: 1, duo: 2, trio: 3 }[preset],
			);
		},
	);
	it.each([
		["58th-floor", "768P", 600000],
		["58th-floor", "2K", 975000],
		["green-booth-freestyle", "768P", 400000],
		["kung-fu-cat", "768P", 360000],
		["paws-at-you", "768P", 240000],
		["flying-car-curved-ramp-showcase", "768P", 640000],
		["flying-car-curved-ramp-showcase", "2K", 1015000],
		["flying-car-curved-ramp", "768P", 640000],
		["flying-car-curved-ramp", "2K", 1015000],
		["flying-car-fleet-side", "768P", 300000],
		["flying-car-fleet-side", "2K", 475000],
		["flying-car-fleet-front", "768P", 300000],
		["flying-car-fleet-front", "2K", 475000],
	] as const)(
		"prices Kie %s %s including all additional input images",
		(key, resolution, micros) => {
			expect(
				resolveSourceTemplatePrice(kieRequest(key, resolution), environment()).providerCostMicros,
			).toBe(String(micros));
		},
	);
	it.each(["solo", "duo", "person-pet"] as const)(
		"keeps the first five 58th Floor %s images free",
		(preset) => {
			expect(
				resolveSourceTemplatePrice(kieRequest("58th-floor", "768P", preset), environment())
					.providerCostMicros,
			).toBe("600000");
		},
	);
	it.each([
		["768P", 285n],
		["2K", 395n],
	] as const)(
		"prices Hotel %s per generation and budgets 32 frames without a generation duration",
		(resolution, supplierCredits) => {
			const request = hotelRequest(resolution);
			const result = resolveSourceTemplatePrice(request, {
				...environment(),
				HOTEL_LOBBY_DUO_TEXT_REVIEW_COST_MICROS: undefined,
			});
			expect(BigInt(result.providerCostMicros)).toBe(
				seeapiSupplierCreditsCostMicros(supplierCredits),
			);
			expect(result.options).not.toHaveProperty("durationSeconds");
			expect(input(request)).not.toHaveProperty("duration_seconds");
			expect(JSON.parse(result.pricingBasis).moderation).toMatchObject({
				frames: 32,
				textMicros: "0",
				outputMicros: "9768",
				inputMicros: "200",
			});
		},
	);
	it("reuses the existing complete-cost arithmetic and historical conversion without claiming revenue", () => {
		const request = kieRequest("flying-car-fleet-side");
		const price = resolveSourceTemplatePrice(request, environment());
		const basis = JSON.parse(price.pricingBasis);
		const expected = calculateVideoRetailPrice({
			providerCostMicros: 300000n,
			duration: 7,
			sound: true,
			policy: {
				moderationBaseMicros: BigInt(price.moderationCostMicros),
				moderationPerSecondMicros: 0n,
				audioModerationPerSecondMicros: 0n,
				runtimeMicros: 100000n,
				storageMicros: 10000n,
				paymentFixedAllocationMicros: 0n,
				paymentFeeBps: 750n,
				nonBillableFailureBps: 500n,
				markupBps: 15500n,
			},
			creditFloorMicros: 21944n,
		});
		expect(price.credits).toBe(expected.credits.toString());
		expect(basis.retailReference.usdMicrosPerCredit).toBe("21944");
		expect(basis).not.toHaveProperty("profitMicros");
		expect(price).not.toHaveProperty("paidFundingPolicy");
	});
	it("reads actual packed cost policy and keeps only cost-bearing public option identities", () => {
		const request = seeapiRequest("original-rap", {
			direction: "custom",
			locale: "zh",
			stageId: "street-cypher",
		});
		const original = structuredClone(request);
		const plain = resolveSourceTemplatePrice(request, environment());
		const packed = resolveSourceTemplatePrice(request, packVideoRuntimeEnvironment(environment()));
		expect(packed).toEqual(plain);
		expect(Object.keys(plain.options).sort()).toEqual([
			"aspectRatio",
			"durationSeconds",
			"preset",
			"resolution",
			"tier",
		]);
		expect(request).toEqual(original);
	});
	it("requires complete explicit cost settings instead of synthesizing a free text-review price", () => {
		const request = seeapiRequest();
		for (const key of [
			"VIDEO_COST_RUNTIME_MICROS",
			"VIDEO_COST_STORAGE_MICROS",
			"VIDEO_COST_PAYMENT_FIXED_MICROS",
			"VIDEO_COST_PAYMENT_FEE_BPS",
			"VIDEO_COST_NONBILLABLE_FAILURE_BPS",
			"HOTEL_LOBBY_DUO_TEXT_REVIEW_COST_MICROS",
		]) {
			expect(() =>
				resolveSourceTemplatePrice(request, { ...environment(), [key]: undefined }),
			).toThrow(`SOURCE_TEMPLATE_PRICE_CONFIG_REQUIRED:${key}`);
		}
		expect(() =>
			resolveSourceTemplatePrice(request, {
				...environment(),
				HOTEL_LOBBY_DUO_TEXT_COST_BASIS: "",
			}),
		).toThrow("SOURCE_TEMPLATE_PRICE_CONFIG_REQUIRED:SOURCE_TEMPLATE_TEXT_REVIEW_COST_MICROS");
	});
	it("accepts an explicit evidenced zero text tariff and exact custom supplier ratio", () => {
		const env = {
			...environment(),
			SOURCE_TEMPLATE_TEXT_REVIEW_COST_MICROS: "0",
			SOURCE_TEMPLATE_TEXT_COST_BASIS: "explicit local zero fixture",
			SEEAPI_CREDIT_USD_BASIS: "custom",
			SEEAPI_CREDIT_USD_BASIS_EVIDENCE: "local ratio fixture",
			SEEAPI_CREDIT_USD_AMOUNT_MICROS: "1000000",
			SEEAPI_CREDIT_USD_AMOUNT_CREDITS: "3",
		};
		expect(seeapiSupplierCreditsCostMicros(1n, 1n, env)).toBe(333334n);
		expect(
			JSON.parse(resolveSourceTemplatePrice(seeapiRequest(), env).pricingBasis).moderation
				.textMicros,
		).toBe("0");
		expect(() =>
			seeapiSupplierCreditsCostMicros(1n, 1n, { ...env, SEEAPI_CREDIT_USD_BASIS_EVIDENCE: "" }),
		).toThrow("SOURCE_TEMPLATE_PRICE_CONFIG_REQUIRED:SEEAPI_CREDIT_USD_BASIS_EVIDENCE");
	});
	it("fails closed for unmeasured reference video even when reference audio is supported", () => {
		for (const field of [
			"reference_video",
			"reference_videos",
			"reference_video_duration",
			"reference_video_urls",
		]) {
			const request = seeapiRequest();
			input(request)[field] = [];
			expect(() => resolveSourceTemplatePrice(request, environment())).toThrow(
				"SOURCE_TEMPLATE_PRICE_REFERENCE_VIDEO_UNSUPPORTED",
			);
		}
	});
	it("rejects model/provider/output/image mismatches and unsupported source tiers", () => {
		const provider = seeapiRequest();
		provider.transport.provider = "kie";
		expect(() => resolveSourceTemplatePrice(provider, environment())).toThrow(
			"SOURCE_TEMPLATE_PRICE_KIE_CONTRACT_INVALID",
		);
		const model = seeapiRequest();
		model.transport.modelId = "seedance-2";
		expect(() => resolveSourceTemplatePrice(model, environment())).toThrow(
			"SOURCE_TEMPLATE_PRICE_SEEAPI_CONTRACT_INVALID",
		);
		const output = seeapiRequest();
		output.transport.output.durationSeconds = 15;
		expect(() => resolveSourceTemplatePrice(output, environment())).toThrow(
			"SOURCE_TEMPLATE_PRICE_OUTPUT_MISMATCH",
		);
		const images = kieRequest("flying-car-fleet-side");
		input(images).reference_image_urls = urls(5);
		expect(() => resolveSourceTemplatePrice(images, environment())).toThrow(
			"SOURCE_TEMPLATE_PRICE_IMAGES_INVALID",
		);
		expect(() =>
			resolveSourceTemplatePrice(
				seeapiRequest("original-rap", { tier: "standard", resolution: "1080p" }),
				environment(),
			),
		).toThrow("SOURCE_TEMPLATE_PRICE_SEEAPI_CONTRACT_INVALID");
		const hotel = hotelRequest();
		input(hotel).duration_seconds = 15;
		expect(() => resolveSourceTemplatePrice(hotel, environment())).toThrow(
			"SOURCE_TEMPLATE_PRICE_HOTEL_CONTRACT_INVALID",
		);
	});
});
