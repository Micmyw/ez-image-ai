import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
	createProviderSmokeInput,
	parseProviderSmokeConfiguration,
	runProviderSmoke,
} from "./provider-smoke";

const baseEnvironment = {
	PROVIDER_SMOKE_ALLOWLIST:
		"image-nano-banana-2-lite:nano-banana-2-lite-1k:kie,image-nano-banana:nano-banana-default:kie,image-nano-banana-2:nano-banana-2-1k:kie,image-nano-banana-2:nano-banana-2-2k:kie,image-nano-banana-2:nano-banana-2-4k:kie,image-nano-banana-pro:nano-banana-pro-1k:kie,image-nano-banana-pro:nano-banana-pro-2k:kie,image-nano-banana-pro:nano-banana-pro-4k:kie,image-gpt-image-1-5:gpt-image-1-5-medium:kie,image-gpt-image-1-5:gpt-image-1-5-high:kie,image-gpt-image-2:gpt-image-2-1k:kie,image-gpt-image-2:gpt-image-2-2k:kie,image-gpt-image-2:gpt-image-2-4k:kie,image-seedream-4-5:seedream-4-5-basic-2k:kie,image-seedream-4-5:seedream-4-5-high-4k:kie,image-seedream-5-lite:seedream-5-lite-basic-2k:kie,image-seedream-5-lite:seedream-5-lite-high-3k:kie,image-seedream-5-lite:seedream-5-lite-ultra-4k:kie,image-seedream-5-pro:seedream-5-pro-basic-1k:kie,image-seedream-5-pro:seedream-5-pro-high-2k:kie",
	PROVIDER_SMOKE_ENABLED_SKUS:
		"nano-banana-2-lite-1k,nano-banana-default,nano-banana-2-1k,nano-banana-2-2k,nano-banana-2-4k,nano-banana-pro-1k,nano-banana-pro-2k,nano-banana-pro-4k,gpt-image-1-5-medium,gpt-image-1-5-high,gpt-image-2-1k,gpt-image-2-2k,gpt-image-2-4k,seedream-4-5-basic-2k,seedream-4-5-high-4k,seedream-5-lite-basic-2k,seedream-5-lite-high-3k,seedream-5-lite-ultra-4k,seedream-5-pro-basic-1k,seedream-5-pro-high-2k",
	PROVIDER_SMOKE_MAX_INVOCATIONS: "20",
	PROVIDER_SMOKE_MAX_EXPECTED_COST_MICROS: "1072500",
	PROVIDER_SMOKE_PROMPT: "Make the background blue",
};

void test("configures all 20 current Kie image SKU cells and stays dry by default", () => {
	const configuration = parseProviderSmokeConfiguration(baseEnvironment);

	assert.equal(configuration.confirmLive, false);
	assert.equal(configuration.expectedCostMicros, 1_072_500);
	assert.deepEqual(
		configuration.routes.map(
			({ provider, model, productKey, skuKey, expectedCostMicros, inputKind }) => ({
				provider,
				model,
				productKey,
				skuKey,
				expectedCostMicros,
				inputKind,
			}),
		),
		[
			{
				provider: "kie",
				model: "nano-banana-2-lite",
				productKey: "image-nano-banana-2-lite",
				skuKey: "nano-banana-2-lite-1k",
				expectedCostMicros: 20_000,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "google/nano-banana-edit",
				productKey: "image-nano-banana",
				skuKey: "nano-banana-default",
				expectedCostMicros: 20_000,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "nano-banana-2",
				productKey: "image-nano-banana-2",
				skuKey: "nano-banana-2-1k",
				expectedCostMicros: 40_000,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "nano-banana-2",
				productKey: "image-nano-banana-2",
				skuKey: "nano-banana-2-2k",
				expectedCostMicros: 60_000,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "nano-banana-2",
				productKey: "image-nano-banana-2",
				skuKey: "nano-banana-2-4k",
				expectedCostMicros: 90_000,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "nano-banana-pro",
				productKey: "image-nano-banana-pro",
				skuKey: "nano-banana-pro-1k",
				expectedCostMicros: 90_000,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "nano-banana-pro",
				productKey: "image-nano-banana-pro",
				skuKey: "nano-banana-pro-2k",
				expectedCostMicros: 90_000,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "nano-banana-pro",
				productKey: "image-nano-banana-pro",
				skuKey: "nano-banana-pro-4k",
				expectedCostMicros: 120_000,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "gpt-image/1.5-image-to-image",
				productKey: "image-gpt-image-1-5",
				skuKey: "gpt-image-1-5-medium",
				expectedCostMicros: 20_000,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "gpt-image/1.5-image-to-image",
				productKey: "image-gpt-image-1-5",
				skuKey: "gpt-image-1-5-high",
				expectedCostMicros: 110_000,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "gpt-image-2-image-to-image",
				productKey: "image-gpt-image-2",
				skuKey: "gpt-image-2-1k",
				expectedCostMicros: 30_000,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "gpt-image-2-image-to-image",
				productKey: "image-gpt-image-2",
				skuKey: "gpt-image-2-2k",
				expectedCostMicros: 50_000,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "gpt-image-2-image-to-image",
				productKey: "image-gpt-image-2",
				skuKey: "gpt-image-2-4k",
				expectedCostMicros: 80_000,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "seedream/4.5-edit",
				productKey: "image-seedream-4-5",
				skuKey: "seedream-4-5-basic-2k",
				expectedCostMicros: 32_500,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "seedream/4.5-edit",
				productKey: "image-seedream-4-5",
				skuKey: "seedream-4-5-high-4k",
				expectedCostMicros: 32_500,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "seedream/5-lite-image-to-image",
				productKey: "image-seedream-5-lite",
				skuKey: "seedream-5-lite-basic-2k",
				expectedCostMicros: 27_500,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "seedream/5-lite-image-to-image",
				productKey: "image-seedream-5-lite",
				skuKey: "seedream-5-lite-high-3k",
				expectedCostMicros: 27_500,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "seedream/5-lite-image-to-image",
				productKey: "image-seedream-5-lite",
				skuKey: "seedream-5-lite-ultra-4k",
				expectedCostMicros: 27_500,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "seedream/5-pro-image-to-image",
				productKey: "image-seedream-5-pro",
				skuKey: "seedream-5-pro-basic-1k",
				expectedCostMicros: 35_000,
				inputKind: "image-to-image",
			},
			{
				provider: "kie",
				model: "seedream/5-pro-image-to-image",
				productKey: "image-seedream-5-pro",
				skuKey: "seedream-5-pro-high-2k",
				expectedCostMicros: 70_000,
				inputKind: "image-to-image",
			},
		],
	);
});

void test("rejects routes outside the current Kie image catalog", () => {
	for (const [route, skuKey] of [
		["image-fast:openrouter", "image-fast"],
		["video-fast:fal", "video-fast"],
		["video-quality:kie", "video-quality"],
	] as const) {
		assert.throws(
			() =>
				parseProviderSmokeConfiguration({
					...baseEnvironment,
					PROVIDER_SMOKE_ALLOWLIST: route,
					PROVIDER_SMOKE_ENABLED_SKUS: skuKey,
					PROVIDER_SMOKE_MAX_INVOCATIONS: "1",
				}),
			new RegExp(`Provider smoke route is not configured: ${route}`),
		);
	}
});

void test("fails closed before creating an adapter for live Kie image smoke", async () => {
	const configuration = parseProviderSmokeConfiguration({
		...baseEnvironment,
		PROVIDER_SMOKE_CONFIRM_LIVE: "true",
	});
	let adapterCreations = 0;

	await assert.rejects(
		runProviderSmoke(
			configuration,
			{},
			{
				createAdapter() {
					adapterCreations += 1;
					throw new Error("adapter must not be created");
				},
			},
		),
		/NOT_COMPLETED: live image smoke must use the private generation and finalization pipeline/,
	);
	assert.equal(adapterCreations, 0);
	assert.throws(
		() => createProviderSmokeInput(configuration.routes[0]!, configuration),
		/NOT_COMPLETED: direct image Provider input is disabled/,
	);
});

void test("keeps the protected workflow Kie-SKU-only and fail-closed by default", () => {
	const workflow = readFileSync(
		resolve(process.cwd(), ".github/workflows/provider-smoke.yml"),
		"utf8",
	);

	assert.match(workflow, /nano-banana-2-lite-1k:kie/);
	assert.match(workflow, /nano-banana-default:kie/);
	assert.match(workflow, /seedream-5-lite-ultra-4k:kie/);
	assert.match(workflow, /seedream-5-pro-high-2k:kie/);
	assert.match(workflow, /default: "20"/);
	assert.match(workflow, /default: "1072500"/);
	assert.match(workflow, /PROVIDER_SMOKE_CONFIRM_LIVE: "false"/);
	assert.doesNotMatch(
		workflow,
		/source_image_authorized|PROVIDER_SMOKE_SOURCE_IMAGE_URL|OPENROUTER_API_KEY|REPLICATE_API_TOKEN|FAL_API_KEY|KIE_API_KEY|GEMINI_API_KEY/,
	);
});
