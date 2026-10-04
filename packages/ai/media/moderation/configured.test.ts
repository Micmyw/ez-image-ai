import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfiguredImageSafetyAdapter } from "./configured";

const environment = {
	NODE_ENV: "production",
	MEDIA_SAFETY_ADAPTER: "configured",
	MODERATION_IMAGE_SEEAPI_ENABLED: "true",
	SEEAPI_API_KEY: "fixture",
};
const legacySettings = {
	MODERATION_IMAGE_SIGHTENGINE_ENABLED: "true",
	SIGHTENGINE_API_USER: "legacy-fixture",
	SIGHTENGINE_API_SECRET: "legacy-fixture",
};
const localProductionE2EEnvironment = {
	NODE_ENV: "production",
	E2E_USE_PRODUCTION_BUILD: "true",
	E2E_TEST_MEDIA_ADAPTERS: "true",
	E2E_RUN_ID: "media-e2e-123",
	DATABASE_URL: "postgresql://media:media@127.0.0.1:55432/media_e2e_test",
	TEST_DATABASE_URL: "postgresql://media:media@127.0.0.1:55432/media_e2e_test",
	NEXT_PUBLIC_SAAS_URL: "http://localhost:3000",
	MEDIA_PROVIDER_ADAPTER: "mock",
	MEDIA_SAFETY_ADAPTER: "test",
	MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
};
const input = {
	assetUrl: "https://private.example/image.png",
	ruleVersion: "rule",
	moderationTaskId: "task_fixture",
};
afterEach(() => vi.unstubAllGlobals());

function responses(
	options: { flagged?: boolean; categories?: readonly string[]; httpError?: boolean } = {},
) {
	const fetcher = vi.fn<typeof fetch>(async (url) => {
		if (new URL(url instanceof Request ? url.url : url).hostname !== "api.seeapi.com")
			throw new Error("Unexpected moderation provider");
		return options.httpError
			? Response.json({ error: "unavailable" }, { status: 503 })
			: Response.json({
					id: input.moderationTaskId,
					object: "inference",
					model: "nsfw-filter",
					endpoint: "image-moderation",
					provider: "seeapi",
					status: "succeeded",
					error: null,
					result: {
						type: "json",
						data: {
							flagged: options.flagged ?? false,
							categories: { nsfw: options.categories ?? [], special_care: [] },
						},
					},
				});
	});
	vi.stubGlobal("fetch", fetcher);
	return fetcher;
}

describe("configured image moderation", () => {
	it("permits the complete local production-build E2E identity without external calls", async () => {
		const fetcher = responses();
		const adapter = createConfiguredImageSafetyAdapter(localProductionE2EEnvironment);
		expect(await adapter.moderateImage(input)).toMatchObject({
			decision: "ALLOW",
			reasonCode: "TEST_DECISION",
		});
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each(Object.keys(localProductionE2EEnvironment))(
		"fails closed for production-build E2E without %s",
		async (key) => {
			const fetcher = responses();
			const adapter = createConfiguredImageSafetyAdapter({
				...localProductionE2EEnvironment,
				[key]: undefined,
			});
			expect(await adapter.moderateImage(input)).toMatchObject({ decision: "ERROR" });
			expect(fetcher).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ NEXT_PUBLIC_SAAS_URL: "https://ezpic.ai" },
		{ TEST_DATABASE_URL: "postgresql://media:media@127.0.0.1:55432/other_test" },
		{
			DATABASE_URL: "postgresql://media:media@remote.example.test/media_e2e_test",
			TEST_DATABASE_URL: "postgresql://media:media@remote.example.test/media_e2e_test",
		},
		{
			DATABASE_URL:
				"postgresql://media:media@127.0.0.1:55432/media_e2e_test?host=remote.example.test",
			TEST_DATABASE_URL:
				"postgresql://media:media@127.0.0.1:55432/media_e2e_test?host=remote.example.test",
		},
	])("fails closed for non-isolated production-build E2E: %j", async (overrides) => {
		const fetcher = responses();
		const adapter = createConfiguredImageSafetyAdapter({
			...localProductionE2EEnvironment,
			...overrides,
		});
		expect(await adapter.moderateImage(input)).toMatchObject({ decision: "ERROR" });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("uses only SeeAPI and preserves its authoritative evidence despite obsolete provider switches", async () => {
		const fetcher = responses();
		const adapter = createConfiguredImageSafetyAdapter({ ...environment, ...legacySettings });

		expect(await adapter.retrieveImage!(input)).toMatchObject({
			decision: "ALLOW",
			evidence: { seeapi: { flagged: false }, models: ["nsfw-filter"], operations: 1 },
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0]![0]).toEqual(expect.stringContaining("api.seeapi.com"));
	});

	it("submits only a SeeAPI image request with strict image policy", async () => {
		const fetcher = responses();
		const adapter = createConfiguredImageSafetyAdapter({ ...environment, ...legacySettings });
		await adapter.submitImage!({ ...input, idempotencyKey: "image-review-1" });

		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0]![0]).toBe("https://api.seeapi.com/v1/inferences");
		expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({
			model: "nsfw-filter",
			endpoint: "image-moderation",
			provider: "seeapi",
			input: { image_url: input.assetUrl, threshold_offset: 0, strict_special_care: true },
		});
	});

	it.each([
		["REJECT", { flagged: true }],
		["REVIEW", { categories: ["uncertain"] }],
		["ERROR", { httpError: true }],
	] as const)("does not call a secondary provider after SeeAPI %s", async (decision, options) => {
		const fetcher = responses(options);
		const adapter = createConfiguredImageSafetyAdapter({ ...environment, ...legacySettings });

		expect(await adapter.retrieveImage!(input)).toMatchObject({ decision });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			"all providers off",
			{ ...environment, MODERATION_IMAGE_SEEAPI_ENABLED: "false", ...legacySettings },
		],
		["missing SeeAPI key", { ...environment, SEEAPI_API_KEY: undefined, ...legacySettings }],
		["empty SeeAPI key", { ...environment, SEEAPI_API_KEY: " " }],
		["unknown mode", { ...environment, MEDIA_SAFETY_ADAPTER: "unknown" }],
		["obsolete mode", { ...environment, MEDIA_SAFETY_ADAPTER: "sightengine", ...legacySettings }],
		[
			"missing mode in tests",
			{ ...environment, NODE_ENV: "test", MEDIA_SAFETY_ADAPTER: undefined },
		],
		["invalid SeeAPI switch", { ...environment, MODERATION_IMAGE_SEEAPI_ENABLED: "yes" }],
	] as const)("fails closed without external calls for %s", async (_name, env) => {
		const fetcher = responses();
		const adapter = createConfiguredImageSafetyAdapter(env);

		expect(await adapter.moderateImage(input)).toMatchObject({
			decision: "ERROR",
			ruleVersion: input.ruleVersion,
		});
		expect("submitImage" in adapter).toBe(false);
		expect("retrieveImage" in adapter).toBe(false);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("does not expose text or video moderation through the configured image factory", async () => {
		const fetcher = responses();
		const adapter = createConfiguredImageSafetyAdapter({ ...environment, ...legacySettings });

		expect(await adapter.moderateText({ text: "fixture", ruleVersion: "rule" })).toMatchObject({
			decision: "ERROR",
		});
		expect(await adapter.moderateImage(input)).toMatchObject({ decision: "ERROR" });
		expect(await adapter.retrieveVideo(input)).toMatchObject({ decision: "ERROR" });
		await expect(
			adapter.submitVideo({ ...input, idempotencyKey: "not-a-video-factory" }),
		).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each(["test", "development"])(
		"allows an explicitly enabled test adapter in %s",
		async (nodeEnv) => {
			const fetcher = responses();
			const adapter = createConfiguredImageSafetyAdapter({
				NODE_ENV: nodeEnv,
				MEDIA_SAFETY_ADAPTER: "test",
				MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
			});

			expect(await adapter.moderateImage(input)).toMatchObject({
				decision: "ALLOW",
				reasonCode: "TEST_DECISION",
			});
			expect(fetcher).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ NODE_ENV: "production", MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true" },
		{ NODE_ENV: "test" },
		{ NODE_ENV: "development", MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "false" },
		{ NODE_ENV: "unknown", MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true" },
		{ MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true" },
	])("fails closed for an unauthorized test adapter %#", async (env) => {
		const fetcher = responses();
		const adapter = createConfiguredImageSafetyAdapter({ ...env, MEDIA_SAFETY_ADAPTER: "test" });

		expect(await adapter.moderateImage(input)).toMatchObject({ decision: "ERROR" });
		expect(fetcher).not.toHaveBeenCalled();
	});
});
