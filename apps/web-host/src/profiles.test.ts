import { readFileSync } from "node:fs";
import path from "node:path";

import { moderationConfiguration } from "@repo/config";
import {
	EZPIC_IMAGE_PRODUCT_ENVIRONMENT_KEYS,
	parseEzPicImageModelFlags,
} from "@repo/config/server";
import { VIDEO_MODEL_CATALOG_VERSION } from "@repo/config/video-models";
import { VIDEO_SUPPLIER_PRICE_VERSION } from "@repo/config/video-pricing.server";
import {
	expandVideoRuntimeEnvironment,
	packVideoRuntimeEnvironment,
	parseVideoRuntimeConfig,
	VIDEO_RUNTIME_ENVIRONMENT_KEYS,
} from "@repo/config/video-runtime-environment";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { describe, expect, it } from "vitest";

import {
	createProfileArtifacts,
	deploymentProfile,
	profileSettings,
	workersRuntimeEnvironment,
} from "./profiles";

describe("deployment profiles", () => {
	it("defaults to Workers and rejects unknown profiles", () => {
		expect(deploymentProfile({})).toBe("workers");
		expect(deploymentProfile({ EZPIC_DEPLOYMENT_PROFILE: "hybrid" })).toBe("hybrid");
		expect(() => deploymentProfile({ EZPIC_DEPLOYMENT_PROFILE: "typo" })).toThrow(
			"INVALID_DEPLOYMENT_PROFILE",
		);
	});
	it("keeps website identity stable and job identities separate for drain/rollback", () => {
		const workers = profileSettings("workers", "production");
		const hybrid = profileSettings("hybrid", "production");
		expect(workers.websiteName).toBe(hybrid.websiteName);
		expect(workers.jobsName).not.toBe(hybrid.jobsName);
		expect(workers.jobsConfig).toBe("wrangler.workers.jsonc");
		expect(hybrid.jobsConfig).toBe("wrangler.jsonc");
	});
	it("uses Hyperdrive instead of embedding database origin credentials in Workers", () => {
		expect(
			workersRuntimeEnvironment({
				DATABASE_URL: "private-origin",
				DIRECT_URL: "private-migration",
				NODE_EXTRA_CA_CERTS: "/app/ca.crt",
				JOBS_RUNTIME_ENV: "private",
				CLOUDFLARE_API_TOKEN: "private-api-token",
				MEDIA_GENERATION_ENABLED: "false",
				KIE_API_KEY: "runtime-secret",
			}),
		).toEqual({
			NODE_ENV: "production",
			EZPIC_RUNTIME: "workers",
			EZPIC_DATABASE_BINDING: "hyperdrive",
			MEDIA_GENERATION_ENABLED: "false",
			KIE_API_KEY: "runtime-secret",
		});
	});
	it("packs image model switches without packing global, moderation, or billing controls", () => {
		const environment = workersRuntimeEnvironment({
			MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
			MEDIA_GPT_IMAGE_2_ENABLED: "false",
			MEDIA_GENERATION_ENABLED: "false",
			MEDIA_MODERATION_ENABLED: "true",
			BILLING_ENABLED: "false",
			UNCHANGED_ZERO: "0",
		});
		expect(environment).toMatchObject({
			MEDIA_IMAGE_MODEL_FLAGS: JSON.stringify({
				MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
				MEDIA_GPT_IMAGE_2_ENABLED: "false",
			}),
			MEDIA_GENERATION_ENABLED: "false",
			MEDIA_MODERATION_ENABLED: "true",
			BILLING_ENABLED: "false",
			UNCHANGED_ZERO: "0",
		});
		expect(environment).not.toHaveProperty("MEDIA_NANO_BANANA_2_LITE_ENABLED");
		expect(environment).not.toHaveProperty("MEDIA_GPT_IMAGE_2_ENABLED");
	});
	it("keeps build, offline evidence, and local test settings out of limited Worker bindings", () => {
		const environment = workersRuntimeEnvironment({
			NEXT_PUBLIC_GOOGLE_ANALYTICS_ID: "G-BUILD-ONLY",
			NEXT_PUBLIC_CLARITY_PROJECT_ID: "build-only",
			NEXT_PUBLIC_SITE_NAME: "compiled-app-name",
			NEXT_PUBLIC_SITE_DESCRIPTION: "compiled-description",
			NEXT_PUBLIC_AVATARS_BUCKET_NAME: "compiled-avatar-bucket",
			EZPIC_ENVIRONMENT_MATRIX_PATH: "offline-matrix.json",
			EZPIC_LAUNCH_EVIDENCE_PATH: "offline-evidence.json",
			MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: "obsolete-certificate",
			E2E_TEST_MEDIA_ADAPTERS: "false",
			E2E_DRAFT_HANDOFF: "false",
			LOAD_TESTING_ENABLED: "false",
			NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com",
			NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY: "public-turnstile-key",
			GUEST_TURNSTILE_SECRET_KEY: "private-turnstile-key",
			PAYPAL_ENVIRONMENT: "sandbox",
			WAFFO_ENVIRONMENT: "test",
			EZPIC_DEPLOYMENT_ENVIRONMENT: "production",
			MEDIA_SAFETY_ADAPTER: "configured",
			MODERATION_TEXT_WAFFO_ENABLED: "true",
			MODERATION_TEXT_SIGHTENGINE_ENABLED: "false",
			MODERATION_IMAGE_SEEAPI_ENABLED: "true",
			MODERATION_IMAGE_SIGHTENGINE_ENABLED: "false",
			SEEAPI_API_KEY: "x".repeat(16),
			SIGHTENGINE_API_USER: "disabled-scanner-user",
			SIGHTENGINE_API_SECRET: "disabled-scanner-secret",
		});
		expect(environment).toEqual({
			NODE_ENV: "production",
			EZPIC_RUNTIME: "workers",
			EZPIC_DATABASE_BINDING: "hyperdrive",
			NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com",
			NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY: "public-turnstile-key",
			GUEST_TURNSTILE_SECRET_KEY: "private-turnstile-key",
			PAYPAL_ENVIRONMENT: "sandbox",
			WAFFO_ENVIRONMENT: "test",
			EZPIC_DEPLOYMENT_ENVIRONMENT: "production",
			MEDIA_SAFETY_ADAPTER: "configured",
			MODERATION_TEXT_WAFFO_ENABLED: "true",
			MODERATION_IMAGE_SEEAPI_ENABLED: "true",
			SEEAPI_API_KEY: "x".repeat(16),
		});
		expect(moderationConfiguration(environment)).toEqual({
			textWaffo: true,
			imageSeeapi: true,
		});
	});
	it("replaces obsolete lifetime guest limits with daily limits in Worker bindings", () => {
		const environment = workersRuntimeEnvironment({
			GUEST_SESSION_MAX_ACCEPTED_TRIALS: "1",
			GUEST_DEVICE_MAX_ACCEPTED_PER_PROMOTION: "1",
			GUEST_SESSION_MAX_ACCEPTED_PER_DAY: "2",
			GUEST_DEVICE_MAX_ACCEPTED_PER_DAY: "2",
			GUEST_IP_MAX_PER_10_MINUTES: "2",
		});
		expect(environment).toEqual({
			NODE_ENV: "production",
			EZPIC_RUNTIME: "workers",
			EZPIC_DATABASE_BINDING: "hyperdrive",
			GUEST_SESSION_MAX_ACCEPTED_PER_DAY: "2",
			GUEST_DEVICE_MAX_ACCEPTED_PER_DAY: "2",
			GUEST_IP_MAX_PER_10_MINUTES: "2",
		});
	});
	it.each<Record<string, string>>([
		{},
		{ MEDIA_SAFETY_ADAPTER: "sightengine" },
		{ MEDIA_SAFETY_ADAPTER: "configured", MODERATION_TEXT_SIGHTENGINE_ENABLED: "true" },
		{ MEDIA_SAFETY_ADAPTER: "configured", MODERATION_IMAGE_SIGHTENGINE_ENABLED: "true" },
		{ MEDIA_SAFETY_ADAPTER: "configured", VIDEO_V1_VIDEO_SAFETY_ADAPTER: "sightengine" },
	])("excludes retired moderation credentials despite stale switches: %j", (switches) => {
		const environment = workersRuntimeEnvironment({
			...retiredModerationEnvironment,
			...switches,
		});
		for (const key of Object.keys(retiredModerationEnvironment))
			expect(environment).not.toHaveProperty(key);
		// Invalid selectors remain visible to configuration validation; never translate
		// a stale provider choice into an enabled replacement provider.
		if (switches.MEDIA_SAFETY_ADAPTER)
			expect(environment).toHaveProperty("MEDIA_SAFETY_ADAPTER", switches.MEDIA_SAFETY_ADAPTER);
	});
});

const retiredModerationEnvironment = {
	SIGHTENGINE_API_USER: "retired-scanner-user",
	SIGHTENGINE_API_SECRET: "retired-scanner-secret",
	MODERATION_TEXT_SIGHTENGINE_ENABLED: "true",
	MODERATION_IMAGE_SIGHTENGINE_ENABLED: "true",
	VIDEO_V1_MODERATION_WEBHOOK_SECRET: "retired-callback-secret",
	VIDEO_V1_MODERATION_CALLBACK_CONFIGURED: "true",
	VIDEO_AUDIO_SAFETY_ADAPTER: "openai-transcript",
	OPENAI_AUDIO_MODERATION_API_KEY: "retired-audio-secret",
	OPENAI_AUDIO_TRANSCRIPTION_MODEL: "retired-audio-model",
};

const root = path.resolve(import.meta.dirname, "../../..");
// Fixture-only costs and credentials; artifact preparation performs no provider calls.
const multiModelVideoEnvironment = {
	VIDEO_V1_ENABLED: "true",
	MEDIA_GENERATION_ENABLED: "true",
	VIDEO_V1_ACCESS: "internal",
	VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
	KIE_API_KEY: "fixture-only",
	KIE_WEBHOOK_SECRET: "fixture-only",
	NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com",
	VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
	VIDEO_V1_IMAGE_SAFETY_ADAPTER: "seeapi",
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
	WAFFO_MERCHANT_ID: "fixture-only",
	WAFFO_PRIVATE_KEY: "fixture-only",
	SEEAPI_API_KEY: "fixture-only",
	VIDEO_SEEAPI_CALLBACK_SECRET: "local-video-seeapi-callback-secret-20261004",
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
		whkey_test: "whsec_local_test_signing_secret_20261004",
	}),
	VIDEO_V1_PROVIDER_CONCURRENCY: "5",
	VIDEO_V1_OUTPUT_ALLOWED_HOSTS: "cdn.example.test",
	VIDEO_V1_UPLOAD_CORS_READY: "true",
	VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
	VIDEO_PRICE_BASIS: "HYPOTHETICAL_TEST_ONLY_COSTS",
	VIDEO_PRICE_VALID_UNTIL: "2100-01-01T00:00:00.000Z",
	VIDEO_COST_VISUAL_POLICY_VERSION: createVideoVisualSafetyProfile("seeapi", 5).policyVersion,
	VIDEO_COST_TEXT_RULE_VERSION: createVideoTextSafetyProfile().ruleVersion,
	VIDEO_COST_MODERATION_BASE_MICROS: "10000",
	VIDEO_COST_MODERATION_PER_SECOND_MICROS: "5000",
	VIDEO_COST_RUNTIME_MICROS: "5000",
	VIDEO_COST_STORAGE_MICROS: "5000",
	VIDEO_COST_PAYMENT_FIXED_MICROS: "2000",
	VIDEO_COST_PAYMENT_FEE_BPS: "500",
	VIDEO_COST_NONBILLABLE_FAILURE_BPS: "1000",
};
function artifacts(
	profile: "workers" | "hybrid",
	overrides: Record<string, string> = {},
	templateVars?: Record<string, string>,
) {
	const config = (file: string) =>
		JSON.parse(readFileSync(path.join(root, file), "utf8")) as Record<string, unknown>;
	const jobsTemplate = config(
		`apps/workflows/${profileSettings(profile, "production").jobsConfig}`,
	);
	if (templateVars) {
		delete jobsTemplate.env;
		jobsTemplate.vars = templateVars;
	}
	return createProfileArtifacts({
		root,
		target: "production",
		profile,
		canonicalOrigin: "https://ezimageai.com",
		websiteTemplate: config("apps/saas/wrangler.jsonc"),
		jobsTemplate,
		environment: {
			DATABASE_URL: "postgresql://private:private@origin.example/db",
			BETTER_AUTH_SECRET: "private-auth-secret-at-least-32-characters",
			WORKFLOWS_DISPATCH_SECRET: "private-dispatch-secret-at-least-32-characters",
			WORKFLOWS_DISPATCH_URL: `https://${profileSettings(profile, "production").jobsName}.account.workers.dev/internal/dispatch`,
			CLOUDFLARE_HYPERDRIVE_ID: "a".repeat(32),
			CLOUDFLARE_WEB_CACHE_BUCKET: "website-cache",
			MEDIA_BUCKET_NAME: "private-media",
			MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "false",
			...overrides,
		},
	});
}

describe("prepared deployment artifacts", () => {
	it.each(["workers", "hybrid"] as const)(
		"keeps the build-only video flag out of %s runtime artifacts",
		(profile) => {
			const result = artifacts(profile, { VIDEO_V1_BUILD_ENABLED: "true" });
			for (const name of ["website", "workflows"] as const) {
				expect(result[name].vars).toMatchObject({ VIDEO_V1_ENABLED: "false" });
				expect(result[name].vars).not.toHaveProperty("VIDEO_V1_BUILD_ENABLED");
				expect(result[`${name}.secrets`]).not.toHaveProperty("VIDEO_V1_BUILD_ENABLED");
			}
			if (profile === "hybrid")
				expect(JSON.parse(result["workflows.secrets"].JOBS_RUNTIME_ENV)).not.toHaveProperty(
					"VIDEO_V1_BUILD_ENABLED",
				);
		},
	);
	it("rejects conflicting template video policies while removing identical legacy vars", () => {
		expect(() => artifacts("workers", {}, { VIDEO_V1_ACCESS: "public" })).toThrow(
			"VIDEO_RUNTIME_TEMPLATE_CONFLICT",
		);
		expect(() => artifacts("workers", {}, { VIDEO_RUNTIME_CONFIG: "{}" })).toThrow(
			"VIDEO_RUNTIME_TEMPLATE_CONFLICT",
		);
		const result = artifacts(
			"workers",
			{},
			{ VIDEO_V1_ACCESS: "internal", VIDEO_V1_BUILD_ENABLED: "true" },
		);
		expect(result.workflows.vars).not.toHaveProperty("VIDEO_V1_ACCESS");
		expect(result.workflows.vars).not.toHaveProperty("VIDEO_V1_BUILD_ENABLED");
		expect(result.workflows.vars).toMatchObject({ VIDEO_V1_ENABLED: "false" });
		expect(parseVideoRuntimeConfig(result["workflows.secrets"].VIDEO_RUNTIME_CONFIG)).toEqual({
			VIDEO_V1_ACCESS: "internal",
		});
	});
	it.each(["workers", "hybrid"] as const)(
		"packs all video policy privately and accepts packed-only input for %s",
		(profile) => {
			const input = {
				...multiModelVideoEnvironment,
				VIDEO_MODEL_ALLOWED_OPTIONS: '[{"productKey":"fixture-only"}]',
			};
			const flat = artifacts(profile, input);
			const packed = artifacts(profile, packVideoRuntimeEnvironment(input));
			const normalize = (value: typeof packed) => ({
				...value,
				"workflows.secrets": {
					...value["workflows.secrets"],
					...(profile === "hybrid"
						? { JOBS_RUNTIME_ENV: JSON.parse(value["workflows.secrets"].JOBS_RUNTIME_ENV) }
						: {}),
				},
			});
			expect(normalize(packed)).toEqual(normalize(flat));
			for (const name of ["website", "workflows"] as const) {
				const secrets = packed[`${name}.secrets`];
				const policy = parseVideoRuntimeConfig(secrets.VIDEO_RUNTIME_CONFIG);
				expect(policy).toMatchObject({
					VIDEO_V1_ACCESS: "internal",
					VIDEO_V1_UPLOAD_CORS_READY: "true",
					VIDEO_MODEL_ALLOWED_OPTIONS: input.VIDEO_MODEL_ALLOWED_OPTIONS,
				});
				for (const key of VIDEO_RUNTIME_ENVIRONMENT_KEYS) {
					expect(secrets).not.toHaveProperty(key);
					expect(packed[name].vars).not.toHaveProperty(key);
				}
				expect(policy).not.toHaveProperty("VIDEO_V1_ENABLED");
				expect(policy).not.toHaveProperty("SEEAPI_API_KEY");
				expect(packed[name].vars).toMatchObject({ VIDEO_V1_ENABLED: "true" });
				expect(packed[name].vars).not.toHaveProperty("VIDEO_RUNTIME_CONFIG");
			}
			if (profile === "hybrid")
				expect(JSON.parse(packed["workflows.secrets"].JOBS_RUNTIME_ENV)).toMatchObject(input);
		},
	);
	it("refuses conflicting packed policy before preparing artifacts", () => {
		expect(() =>
			artifacts("workers", {
				VIDEO_RUNTIME_CONFIG: '{"VIDEO_V1_ACCESS":"internal"}',
				VIDEO_V1_ACCESS: "public",
			}),
		).toThrow("VIDEO_RUNTIME_CONFIG_CONFLICT");
	});
	it("fits nineteen video policy fields into one binding without opening video", () => {
		const policy = Object.fromEntries(
			VIDEO_RUNTIME_ENVIRONMENT_KEYS.slice(0, 19).map((key) => [key, "fixture"]),
		);
		policy.VIDEO_V1_ACCESS = "internal";
		const base = artifacts("workers");
		const next = artifacts("workers", policy);
		for (const name of ["website", "workflows"] as const) {
			expect(Object.keys(next[`${name}.secrets`]).length).toBe(
				Object.keys(base[`${name}.secrets`]).length,
			);
			expect(next[name].vars).toMatchObject({ VIDEO_V1_ENABLED: "false" });
		}
	});
	it.each(["workers", "hybrid"] as const)(
		"replaces twelve model bindings with one for %s",
		(profile) => {
			const flags = Object.fromEntries(
				Object.values(EZPIC_IMAGE_PRODUCT_ENVIRONMENT_KEYS).map((key, index) => [
					key,
					index % 2 ? "false" : "true",
				]),
			);
			const baseline = artifacts(profile);
			const packed = artifacts(profile, flags);
			for (const name of ["website.secrets", "workflows.secrets"] as const) {
				expect(parseEzPicImageModelFlags(packed[name].MEDIA_IMAGE_MODEL_FLAGS)).toEqual(flags);
				for (const key of Object.keys(flags)) expect(packed[name]).not.toHaveProperty(key);
				expect(Object.keys(packed[name]).length).toBe(Object.keys(baseline[name]).length + 1);
			}
		},
	);
	it("counts the packed binding toward the unchanged 128 limit", () => {
		const flags = Object.fromEntries(
			Object.values(EZPIC_IMAGE_PRODUCT_ENVIRONMENT_KEYS).map((key) => [key, "false"]),
		);
		const baseline = artifacts("workers", flags);
		const count =
			Object.keys(baseline.website.vars as object).length +
			Object.keys(baseline["website.secrets"]).length;
		const extras = Object.fromEntries(
			Array.from({ length: 128 - count }, (_, index) => [`EXTRA_${index}`, "value"]),
		);
		expect(() => artifacts("workers", { ...flags, ...extras })).not.toThrow();
		expect(() => artifacts("workers", { ...flags, ...extras, ONE_TOO_MANY: "value" })).toThrow(
			"WORKER_TEXT_BINDING_LIMIT",
		);
	});
	it.each(["workers", "hybrid"] as const)(
		"binds direct private video runtime in actual %s artifacts with admission closed",
		(profile) => {
			const result = artifacts(profile);
			const name = `ezpic-video-v1-${profile}-production`;
			expect(result.website.workflows).toEqual([
				{
					name,
					binding: "VIDEO_WORKFLOW",
					class_name: "VideoGenerationWorkflowV1",
					script_name: profileSettings(profile, "production").jobsName,
				},
			]);
			expect(result.workflows.workflows).toContainEqual({
				name,
				binding: "VIDEO_WORKFLOW",
				class_name: "VideoGenerationWorkflowV1",
			});
			for (const config of [result.website, result.workflows]) {
				expect(config.vars).toMatchObject({
					VIDEO_V1_ENABLED: "false",
				});
				expect(config.vars).not.toHaveProperty("VIDEO_V1_ACCESS");
				expect(config.hyperdrive).toEqual([{ binding: "HYPERDRIVE", id: "a".repeat(32) }]);
				expect(config.r2_buckets).toContainEqual({
					binding: "VIDEO_MEDIA_BUCKET",
					bucket_name: "private-media",
				});
				expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
			}
		},
	);
	it("fails closed when enabling video without pricing and actual service configuration", () => {
		expect(() => artifacts("workers", { VIDEO_V1_ENABLED: "true" })).toThrow("VIDEO_V1_NOT_READY");
	});
	it.each(["workers", "hybrid"] as const)(
		"accepts current multi-model readiness without retired single-model fields for %s",
		(profile) => {
			const result = artifacts(profile, multiModelVideoEnvironment);
			for (const config of [result.website, result.workflows])
				expect(config.vars).toMatchObject({
					VIDEO_V1_ENABLED: "true",
				});
			expect(result["website.secrets"]).not.toHaveProperty("VIDEO_V1_CREDITS");
			expect(result["website.secrets"]).not.toHaveProperty("VIDEO_V1_MODEL_CONTRACT_VERSION");
		},
	);
	it.each([
		[{ VIDEO_MODEL_CONTRACT_VERSION: "" }, "VIDEO_MODEL_CONTRACT_NOT_CONFIRMED"],
		[{ VIDEO_SEEAPI_CALLBACK_SECRET: "" }, "VIDEO_SEEAPI_CALLBACK_NOT_CONFIGURED"],
		[{ VIDEO_V1_PROVIDER_CONCURRENCY: "" }, "VIDEO_CONCURRENCY_NOT_CONFIGURED"],
		[{ VIDEO_V1_UPLOAD_CORS_READY: "false" }, "VIDEO_BINDING_UPLOADCORS_NOT_READY"],
	] as const)("keeps current video safety gates closed for %j", (overrides, reason) => {
		expect(() => artifacts("workers", { ...multiModelVideoEnvironment, ...overrides })).toThrow(
			reason,
		);
	});
	it.each(["workers", "hybrid"] as const)(
		"excludes retired moderation from every %s runtime while preserving active provider secrets",
		(profile) => {
			const active = {
				MEDIA_SAFETY_ADAPTER: "configured",
				VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
				VIDEO_V1_IMAGE_SAFETY_ADAPTER: "seeapi",
				VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
				WAFFO_MERCHANT_ID: "active-merchant",
				WAFFO_PRIVATE_KEY: "active-waffo-secret",
				SEEAPI_API_KEY: "active-seeapi-secret",
				OPENAI_API_KEY: "unrelated-openai-secret",
			};
			const result = artifacts(profile, { ...retiredModerationEnvironment, ...active });
			const environments: Record<string, string>[] = [
				result["website.secrets"],
				result["workflows.secrets"],
			];
			if (profile === "hybrid")
				environments.push(JSON.parse(result["workflows.secrets"].JOBS_RUNTIME_ENV));
			for (const environment of environments) {
				expect(expandVideoRuntimeEnvironment(environment)).toMatchObject(active);
				for (const key of Object.keys(retiredModerationEnvironment))
					expect(environment).not.toHaveProperty(key);
			}
		},
	);
	it("rejects more than 128 text bindings before uploading either Worker", () => {
		const extras = Object.fromEntries(
			Array.from({ length: 128 }, (_, index) => [`EXTRA_${index}`, "value"]),
		);
		expect(() => artifacts("workers", extras)).toThrow("WORKER_TEXT_BINDING_LIMIT");
	});
	it("enables the website workers.dev address only for an explicitly configured callback origin", () => {
		const webhookOrigin = "https://ezimageai-site-production.account.workers.dev";
		expect(artifacts("workers").website.workers_dev).toBe(false);
		const value = artifacts("workers", { PAYMENT_WEBHOOK_INGRESS_ORIGIN: webhookOrigin });
		expect(value.website.workers_dev).toBe(true);
		expect(value.website.vars).toMatchObject({ PAYMENT_WEBHOOK_INGRESS_ORIGIN: webhookOrigin });
		expect(value["website.secrets"]).not.toHaveProperty("PAYMENT_WEBHOOK_INGRESS_ORIGIN");
	});
	it.each([
		"http://ezimageai-site-production.account.workers.dev",
		"https://ezimageai-site-production.other-account.workers.dev",
		"https://another.account.workers.dev",
		"https://ezimageai-site-production.account.workers.dev/api/webhooks/payments",
		"https://ezimageai-site-production.account.workers.dev?unexpected=1",
	])("rejects a callback origin outside this website and Workers account: %s", (webhookOrigin) => {
		expect(() => artifacts("workers", { PAYMENT_WEBHOOK_INGRESS_ORIGIN: webhookOrigin })).toThrow(
			"INVALID_PAYMENT_WEBHOOK_INGRESS_ORIGIN",
		);
	});
	it("builds the default pair without Containers and without public secrets", () => {
		const value = artifacts("workers");
		for (const config of [value.website, value.workflows]) {
			expect(config.containers).toBeUndefined();
			expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
			expect(JSON.stringify(config)).not.toContain("private-auth-secret");
			expect(JSON.stringify(config)).not.toContain("postgresql:");
		}
		expect(value["website.secrets"]).not.toHaveProperty("DATABASE_URL");
		expect(value["website.secrets"]).not.toHaveProperty("EZPIC_RUNTIME");
		expect(value["workflows.secrets"]).not.toHaveProperty("EZPIC_RUNTIME");
	});
	it("keeps the existing hybrid migration history and Node secret injection", () => {
		const value = artifacts("hybrid");
		expect(value.website.containers).toBeUndefined();
		expect(value.workflows.containers).toHaveLength(1);
		expect(value.workflows.migrations).toEqual([
			{ tag: "v1", new_sqlite_classes: ["JobsContainer"] },
		]);
		const secrets = value["workflows.secrets"];
		expect(secrets).toHaveProperty("JOBS_RUNTIME_ENV");
		expect(JSON.parse(secrets.JOBS_RUNTIME_ENV)).toMatchObject({ EZPIC_RUNTIME: "node" });
	});
	it("rejects mismatched task endpoints and shared media/cache buckets", () => {
		expect(() =>
			artifacts("workers", {
				WORKFLOWS_DISPATCH_URL:
					"https://ezpic-workflows-production.account.workers.dev/internal/dispatch",
			}),
		).toThrow("WORKFLOWS_DISPATCH_PROFILE_MISMATCH");
		expect(() => artifacts("workers", { CLOUDFLARE_WEB_CACHE_BUCKET: "private-media" })).toThrow(
			"WEBSITE_CACHE_MUST_USE_SEPARATE_BUCKET",
		);
		expect(() => artifacts("workers", { CLOUDFLARE_HYPERDRIVE_ID: "0".repeat(32) })).toThrow(
			"CLOUDFLARE_HYPERDRIVE_ID_REQUIRED",
		);
	});
});
