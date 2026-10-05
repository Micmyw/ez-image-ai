import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { parseEnv } from "node:util";

import { readVideoModelAccess } from "../../packages/config/video-model-access";
import {
	expandVideoRuntimeEnvironment,
	packVideoRuntimeEnvironment,
} from "../../packages/config/video-runtime-environment";
import {
	DEFAULT_HOTEL_LOBBY_OUTPUT,
	prepareHotelLobbyConfig,
	prepareHotelLobbyBuildOverlay,
	prepareHotelLobbyEnvironment,
	serializePrivateEnvironment,
} from "./prepare-hotel-lobby-config";

const existingGroup = {
	productKey: "video-seedance-1-5-pro",
	modes: ["text-to-video"],
	durations: [10],
	resolutions: ["480p"],
	sounds: [true],
};
function fixture(): Record<string, string> {
	return {
		VIDEO_MODEL_ALLOWED_OPTIONS: JSON.stringify([existingGroup]),
		VIDEO_MODEL_CONTRACT_VERSION: "video-models-2026-10-04.2",
		VIDEO_PRICE_ACCEPTED_VERSION: "kie-public-2026-10-04.3",
		VIDEO_PRICE_BASIS: "Existing isolated fixture, not production approval",
		VIDEO_PRICE_VALID_UNTIL: "2026-10-20T00:00:00Z",
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
		VIDEO_PRICE_MARKUP_BPS: "11000",
		VIDEO_INTERNAL_FUNDING: "existing funding retained verbatim",
		HOTEL_LOBBY_DUO_INTERNAL_FUNDING: "existing template funding retained verbatim",
		VIDEO_V1_ENABLED: "true",
		VIDEO_V1_BUILD_ENABLED: "true",
		MEDIA_GENERATION_ENABLED: "false",
		MEDIA_ENABLED_PROVIDERS: "fal,replicate",
		MEDIA_NANO_BANANA_ENABLED: "false",
		KIE_API_KEY: "fixture-secret-must-not-appear-in-summary",
		DATABASE_URL: "postgresql://fixture:private@localhost/fixture",
		UNRELATED: "keep $dollar #hash \\n literally",
	};
}

beforeEach(() => {
	mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-05T00:00:00Z") });
});
afterEach(() => mock.timers.reset());

void test("preserves packed policies, secrets, funding and ordinary prices; computes 69 closed credits", () => {
	const input = packVideoRuntimeEnvironment(fixture());
	const snapshot = { ...input };
	const result = prepareHotelLobbyEnvironment(input);
	const previous = expandVideoRuntimeEnvironment(input);
	const next = expandVideoRuntimeEnvironment(result.environment);
	assert.deepEqual(input, snapshot);
	assert.equal(result.summary.credits, "69");
	assert.ok(result.summary.packedBytes <= 5000);
	assert.ok(BigInt(result.summary.profitToCostBps) >= 20000n);
	assert.equal(next.HOTEL_LOBBY_DUO_ENABLED, "false");
	assert.equal(next.HOTEL_LOBBY_DUO_BUILD_ENABLED, "false");
	assert.equal(next.HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION, undefined);
	assert.equal(result.summary.validUntil, "2026-10-12T00:00:00.000Z");
	const changed = new Set(result.summary.changedKeys);
	for (const [key, value] of Object.entries(previous)) {
		if (key === "VIDEO_RUNTIME_CONFIG" || changed.has(key)) continue;
		assert.equal(next[key], value, `${key} must be preserved`);
	}
	for (const key of changed) {
		assert.ok(
			(key.startsWith("HOTEL_LOBBY_DUO_") &&
				!key.includes("FUNDING") &&
				!key.includes("ACCEPTED")) ||
				[
					"VIDEO_MODEL_ALLOWED_OPTIONS",
					"MEDIA_NANO_BANANA_2_LITE_ENABLED",
					"MEDIA_ENABLED_PROVIDERS",
				].includes(key),
			`unexpected change to ${key}`,
		);
	}
	assert.equal(next.MEDIA_GENERATION_ENABLED, "false");
	assert.equal(next.MEDIA_ENABLED_PROVIDERS, "fal,replicate,kie");
	assert.equal(next.VIDEO_INTERNAL_FUNDING, previous.VIDEO_INTERNAL_FUNDING);
	assert.equal(next.HOTEL_LOBBY_DUO_INTERNAL_FUNDING, previous.HOTEL_LOBBY_DUO_INTERNAL_FUNDING);
	assert.ok(!JSON.stringify(result.summary).includes(input.KIE_API_KEY));
	assert.ok(!JSON.stringify(result.summary).includes(input.DATABASE_URL));
	assert.deepEqual(parseEnv(serializePrivateEnvironment(result.environment)), result.environment);
});

void test("adds exactly one selection without Cartesian expansion; repeated preparation adds no duplicate", () => {
	const first = prepareHotelLobbyEnvironment(fixture());
	const next = expandVideoRuntimeEnvironment(first.environment);
	assert.deepEqual(JSON.parse(next.VIDEO_MODEL_ALLOWED_OPTIONS!)[0], existingGroup);
	const oldAccess = readVideoModelAccess(fixture());
	const newAccess = readVideoModelAccess(next);
	assert.equal(newAccess.allowed.size, oldAccess.allowed.size + 1);
	for (const option of oldAccess.allowed) assert.ok(newAccess.allowed.has(option));
	assert.ok(
		newAccess.allowed.has(
			JSON.stringify(["video-seedance-1-5-pro", "image-to-video", 5, "720p", false]),
		),
	);
	const second = prepareHotelLobbyEnvironment(first.environment);
	assert.deepEqual(second.environment, first.environment);
});

void test("prepares an authenticated build patch without copying secrets, base policy, funding or enablement", () => {
	const input = fixture();
	const result = prepareHotelLobbyBuildOverlay(input, "authenticated");
	assert.equal(result.summary.credits, "69");
	assert.equal(result.summary.includesBaseSnapshot, false);
	assert.deepEqual(Object.keys(result.environment).sort(), [
		"HOTEL_LOBBY_DUO_BUILD_ENABLED",
		"HOTEL_LOBBY_DUO_RUNTIME_CONFIG",
	]);
	assert.equal(result.environment.HOTEL_LOBBY_DUO_BUILD_ENABLED, "false");
	const patch = JSON.parse(result.environment.HOTEL_LOBBY_DUO_RUNTIME_CONFIG);
	assert.equal(patch.HOTEL_LOBBY_DUO_ACCESS, "authenticated");
	assert.equal(patch.HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION, undefined);
	assert.equal(patch.HOTEL_LOBBY_DUO_INTERNAL_FUNDING, undefined);
	for (const key of Object.keys(patch)) assert.ok(key.startsWith("HOTEL_LOBBY_DUO_"));
	const serialized = serializePrivateEnvironment(result.environment);
	for (const value of [
		input.KIE_API_KEY,
		input.DATABASE_URL,
		input.VIDEO_INTERNAL_FUNDING,
		input.HOTEL_LOBBY_DUO_INTERNAL_FUNDING,
	])
		assert.ok(!serialized.includes(value));
	assert.equal(
		JSON.parse(prepareHotelLobbyBuildOverlay(input).environment.HOTEL_LOBBY_DUO_RUNTIME_CONFIG)
			.HOTEL_LOBBY_DUO_ACCESS,
		"internal",
	);
});

void test("retains broader existing valid selection without duplicating or reducing it", () => {
	const input = fixture();
	input.VIDEO_MODEL_ALLOWED_OPTIONS = JSON.stringify([
		{
			productKey: "video-seedance-1-5-pro",
			modes: ["image-to-video"],
			durations: [5, 10],
			resolutions: ["720p"],
			sounds: [false],
		},
	]);
	const result = expandVideoRuntimeEnvironment(prepareHotelLobbyEnvironment(input).environment);
	assert.equal(result.VIDEO_MODEL_ALLOWED_OPTIONS, input.VIDEO_MODEL_ALLOWED_OPTIONS);
});

void test("keeps earlier expiries and prior acceptance; never creates funding or enables template", () => {
	const input = fixture();
	delete input.VIDEO_INTERNAL_FUNDING;
	delete input.HOTEL_LOBBY_DUO_INTERNAL_FUNDING;
	input.HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION = "existing-version-left-intact";
	input.HOTEL_LOBBY_DUO_ENABLED = "true";
	input.HOTEL_LOBBY_DUO_BUILD_ENABLED = "true";
	input.HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL = "2026-10-08T00:00:00Z";
	input.VIDEO_PRICE_VALID_UNTIL = "2026-10-07T00:00:00Z";
	const result = prepareHotelLobbyEnvironment(input);
	const output = expandVideoRuntimeEnvironment(result.environment);
	assert.equal(result.summary.validUntil, "2026-10-07T00:00:00.000Z");
	assert.equal(
		output.HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION,
		input.HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION,
	);
	assert.equal(output.HOTEL_LOBBY_DUO_ENABLED, "false");
	assert.equal(output.HOTEL_LOBBY_DUO_BUILD_ENABLED, "false");
	assert.equal(output.VIDEO_INTERNAL_FUNDING, undefined);
	assert.equal(output.HOTEL_LOBBY_DUO_INTERNAL_FUNDING, undefined);
});

void test("accepts empty template expiry placeholders but rejects invalid or expired existing approval", () => {
	const input = fixture();
	const result = prepareHotelLobbyEnvironment({
		...input,
		HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: "  ",
	});
	assert.equal(result.summary.validUntil, "2026-10-12T00:00:00.000Z");
	assert.throws(
		() => prepareHotelLobbyEnvironment({ ...input, HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: "invalid" }),
		/EXPIRY_INVALID/,
	);
	assert.throws(
		() =>
			prepareHotelLobbyEnvironment({
				...input,
				HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: "2026-10-01T00:00:00Z",
			}),
		/EXPIRED/,
	);
});

void test("updates packed image flags without altering other flags or duplicating Kie", () => {
	const input = fixture();
	input.MEDIA_IMAGE_MODEL_FLAGS = JSON.stringify({
		MEDIA_NANO_BANANA_ENABLED: "false",
		MEDIA_NANO_BANANA_2_LITE_ENABLED: "false",
	});
	input.MEDIA_NANO_BANANA_2_LITE_ENABLED = "false";
	input.MEDIA_ENABLED_PROVIDERS = "fal, kie";
	const output = prepareHotelLobbyEnvironment(input).environment;
	assert.deepEqual(JSON.parse(output.MEDIA_IMAGE_MODEL_FLAGS), {
		MEDIA_NANO_BANANA_ENABLED: "false",
		MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
	});
	assert.equal(output.MEDIA_NANO_BANANA_2_LITE_ENABLED, "true");
	assert.equal(output.MEDIA_ENABLED_PROVIDERS, input.MEDIA_ENABLED_PROVIDERS);
});

void test("rejects conflicting, oversized, invalid and expired policy instead of silently rewriting it", () => {
	const input = fixture();
	assert.throws(
		() =>
			prepareHotelLobbyEnvironment({
				...input,
				VIDEO_RUNTIME_CONFIG: JSON.stringify({ VIDEO_PRICE_BASIS: "conflict" }),
			}),
		/VIDEO_RUNTIME_CONFIG_CONFLICT/,
	);
	assert.throws(
		() => prepareHotelLobbyEnvironment({ ...input, VIDEO_PRICE_BASIS: "x".repeat(5000) }),
		/VIDEO_RUNTIME_CONFIG_INVALID/,
	);
	assert.throws(
		() =>
			prepareHotelLobbyEnvironment({
				...input,
				VIDEO_MODEL_ALLOWED_OPTIONS: "private-invalid-value",
			}),
		/ALLOWLIST_INVALID/,
	);
	assert.throws(
		() =>
			prepareHotelLobbyEnvironment({ ...input, VIDEO_PRICE_VALID_UNTIL: "2026-10-01T00:00:00Z" }),
		/EXPIRED/,
	);
	assert.throws(
		() => prepareHotelLobbyEnvironment({ ...input, VIDEO_PRICE_VALID_UNTIL: "invalid" }),
		/EXPIRY_INVALID/,
	);
});

void test("private file preparation refuses input overwrite, existing files and public outputs", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "hotel-lobby-config-test-"));
	try {
		assert.equal(spawnSync("git", ["init", "--quiet", root]).status, 0);
		await writeFile(path.join(root, ".gitignore"), ".env.local\n.wrangler/\n");
		const inputPath = path.join(root, ".env.local");
		const source = serializePrivateEnvironment(fixture());
		await writeFile(inputPath, source);
		await assert.rejects(
			prepareHotelLobbyConfig({ inputPath, repositoryRoot: root, outputPath: inputPath }),
			/OVERWRITE_REFUSED/,
		);
		await assert.rejects(
			prepareHotelLobbyConfig({ inputPath, repositoryRoot: root, outputPath: "public.env" }),
			/OUTPUT_MUST_BE_PRIVATE/,
		);
		const summary = await prepareHotelLobbyConfig({ inputPath, repositoryRoot: root });
		assert.equal(summary.credits, "69");
		assert.equal(summary.outputPath, path.join(root, DEFAULT_HOTEL_LOBBY_OUTPUT));
		assert.equal(await readFile(inputPath, "utf8"), source);
		const output = parseEnv(await readFile(summary.outputPath, "utf8"));
		assert.equal(output.HOTEL_LOBBY_DUO_ENABLED, "false");
		assert.equal(
			expandVideoRuntimeEnvironment(output).HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION,
			undefined,
		);
		await assert.rejects(
			prepareHotelLobbyConfig({ inputPath, repositoryRoot: root }),
			/OVERWRITE_REFUSED/,
		);
	} finally {
		assert.equal(path.dirname(root), os.tmpdir());
		assert.ok(path.basename(root).startsWith("hotel-lobby-config-test-"));
		await rm(root, { recursive: true, force: true });
	}
});
