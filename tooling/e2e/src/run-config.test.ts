import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { configuredSharedKieCapacity } from "../../../packages/database/prisma/queries/media/shared-provider-capacity";

void test("local mock jobs have explicit shared-provider dispatch capacity", () => {
	const runner = readFileSync(new URL("./run.ts", import.meta.url), "utf8");
	const capacity = /VIDEO_V1_PROVIDER_CONCURRENCY:\s*"(\d+)"/.exec(runner)?.[1];
	assert.equal(
		configuredSharedKieCapacity({ VIDEO_V1_PROVIDER_CONCURRENCY: capacity }),
		8,
		"the loopback mock runner must configure its slots rather than bypass the provider gate",
	);
});

void test("pins new local image jobs to the configured Kie SKU catalog", () => {
	const runner = readFileSync(new URL("./run.ts", import.meta.url), "utf8");
	const seed = readFileSync(new URL("./seed.ts", import.meta.url), "utf8");

	for (const setting of [
		'MEDIA_NANO_BANANA_2_LITE_ENABLED: "true"',
		'MEDIA_NANO_BANANA_ENABLED: "true"',
		'MEDIA_NANO_BANANA_2_ENABLED: "true"',
		'MEDIA_NANO_BANANA_PRO_ENABLED: "true"',
		'MEDIA_GPT_IMAGE_1_5_ENABLED: "true"',
		'MEDIA_GPT_IMAGE_2_ENABLED: "true"',
		'MEDIA_SEEDREAM_4_5_ENABLED: "true"',
		'MEDIA_SEEDREAM_5_LITE_ENABLED: "true"',
		'MEDIA_SEEDREAM_5_PRO_ENABLED: "true"',
		'MEDIA_ENABLED_PROVIDERS: "kie"',
	]) {
		assert.ok(runner.includes(setting), `runner must contain ${setting}`);
	}
	assert.doesNotMatch(runner, /MEDIA_(?:STANDARD|QUALITY)_EDIT_ENABLED:\s*"true"/);
	assert.doesNotMatch(runner, /MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS/);
	assert.match(runner, /MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED:\s*undefined/);
	assert.match(runner, /OPENROUTER_API_KEY:\s*undefined/);

	assert.match(seed, /EZPIC_PRODUCT_KEYS\.map/);
	assert.match(seed, /media\.model\.\$\{productKey\}\.enabled/);
	assert.match(seed, /Historical cleanup only/);
});
