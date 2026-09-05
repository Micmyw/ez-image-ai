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
	PROVIDER_SMOKE_ALLOWLIST: "image-fast:openrouter,image-quality:openrouter",
	PROVIDER_SMOKE_ENABLED_TIERS: "image-fast,image-quality",
	PROVIDER_SMOKE_MAX_INVOCATIONS: "2",
	PROVIDER_SMOKE_MAX_EXPECTED_COST_MICROS: "203000",
	PROVIDER_SMOKE_PROMPT: "Make the background blue",
};

void test("configures both current OpenRouter image-edit routes and stays dry by default", () => {
	const configuration = parseProviderSmokeConfiguration(baseEnvironment);

	assert.equal(configuration.confirmLive, false);
	assert.equal(configuration.expectedCostMicros, 203_000);
	assert.deepEqual(
		configuration.routes.map(({ provider, model, tier, expectedCostMicros, inputKind }) => ({
			provider,
			model,
			tier,
			expectedCostMicros,
			inputKind,
		})),
		[
			{
				provider: "openrouter",
				model: "sourceful/riverflow-v2.5-fast",
				tier: "image-fast",
				expectedCostMicros: 23_000,
				inputKind: "image-to-image",
			},
			{
				provider: "openrouter",
				model: "sourceful/riverflow-v2.5-pro",
				tier: "image-quality",
				expectedCostMicros: 180_000,
				inputKind: "image-to-image",
			},
		],
	);
});

void test("rejects retired image smoke routes", () => {
	assert.throws(
		() =>
			parseProviderSmokeConfiguration({
				...baseEnvironment,
				PROVIDER_SMOKE_ALLOWLIST: "image-fast:replicate",
				PROVIDER_SMOKE_ENABLED_TIERS: "image-fast",
				PROVIDER_SMOKE_MAX_INVOCATIONS: "1",
			}),
		/Provider smoke route is not configured: image-fast:replicate/,
	);
});

void test("fails closed before creating an adapter for live OpenRouter image smoke", async () => {
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

void test("keeps the protected workflow OpenRouter-only and fail-closed by default", () => {
	const workflow = readFileSync(
		resolve(process.cwd(), ".github/workflows/provider-smoke.yml"),
		"utf8",
	);

	assert.match(workflow, /default: image-fast:openrouter,image-quality:openrouter/);
	assert.match(workflow, /default: image-fast,image-quality/);
	assert.match(workflow, /default: "2"/);
	assert.match(workflow, /default: "203000"/);
	assert.match(workflow, /PROVIDER_SMOKE_CONFIRM_LIVE: "false"/);
	assert.doesNotMatch(
		workflow,
		/source_image_authorized|PROVIDER_SMOKE_SOURCE_IMAGE_URL|OPENROUTER_API_KEY|REPLICATE_API_TOKEN|FAL_API_KEY|KIE_API_KEY|GEMINI_API_KEY/,
	);
});
