import { describe, expect, it } from "vitest";

import { getPublicConfig, parseProductConfig } from "./index";
import {
	getConfigurationFingerprint,
	maximumMediaStorageBytes,
	validateServerEnvironment,
} from "./server";

const productionBase = {
	NODE_ENV: "production",
	MEDIA_GENERATION_ENABLED: "true",
	MEDIA_MODERATION_ENABLED: "true",
	BILLING_ENABLED: "true",
	ERROR_MONITORING_ENABLED: "true",
	DATABASE_URL: "postgresql://user:password@localhost:5432/app",
	S3_ENDPOINT: "https://storage.example.com",
	S3_REGION: "auto",
	MEDIA_BUCKET_NAME: "media-private",
	S3_ACCESS_KEY_ID: "access",
	S3_SECRET_ACCESS_KEY: "secret",
	TRIGGER_SECRET_KEY: "tr_prod_secret",
	STRIPE_SECRET_KEY: "sk_live_secret",
	STRIPE_WEBHOOK_SECRET: "whsec_secret",
	SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
	SIGHTENGINE_API_USER: "api-user",
	SIGHTENGINE_API_SECRET: "api-secret",
	MEDIA_PROVIDER_ADAPTER: "replicate",
	MEDIA_SAFETY_ADAPTER: "sightengine",
	REPLICATE_API_TOKEN: "replicate-secret",
} as const;

describe("validateServerEnvironment", () => {
	it.each([
		["DATABASE_URL", ["DATABASE_URL"]],
		["S3/R2", ["S3_ENDPOINT"]],
		["Trigger.dev", ["TRIGGER_SECRET_KEY"]],
		["Stripe", ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]],
		["Sentry", ["SENTRY_DSN"]],
		["Sightengine", ["SIGHTENGINE_API_USER", "SIGHTENGINE_API_SECRET"]],
	])("requires %s credentials for enabled production features", (label, keys) => {
		const input: Record<string, string | undefined> = { ...productionBase };
		for (const key of keys) {
			delete input[key];
		}

		expect(() => validateServerEnvironment(input), label).toThrow(new RegExp(keys.join("|")));
	});

	it("allows explicit mock adapters in test mode", () => {
		expect(
			validateServerEnvironment({
				NODE_ENV: "test",
				MEDIA_GENERATION_ENABLED: "true",
				MEDIA_MODERATION_ENABLED: "true",
				MEDIA_PROVIDER_ADAPTER: "mock",
				MEDIA_SAFETY_ADAPTER: "test",
				MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
			}),
		).toMatchObject({
			mediaProviderAdapter: "mock",
			mediaSafetyAdapter: "test",
		});
	});

	it("requires the explicit safety switch for the test adapter", () => {
		expect(() =>
			validateServerEnvironment({
				NODE_ENV: "test",
				MEDIA_SAFETY_ADAPTER: "test",
			}),
		).toThrow(/MEDIA_ALLOW_TEST_SAFETY_ADAPTER/);
	});

	it("rejects test adapters in production", () => {
		expect(() =>
			validateServerEnvironment({
				...productionBase,
				MEDIA_PROVIDER_ADAPTER: "mock",
				MEDIA_SAFETY_ADAPTER: "test",
			}),
		).toThrow(/test|mock/i);
	});

	it.each([
		["replicate", "REPLICATE_API_TOKEN"],
		["fal", "FAL_API_KEY"],
		["kie", "KIE_API_KEY"],
		["gemini", "GEMINI_API_KEY"],
	] as const)("requires the selected %s provider credential", (provider, credential) => {
		const input: Record<string, string | undefined> = {
			...productionBase,
			MEDIA_PROVIDER_ADAPTER: provider,
		};
		delete input[credential];
		expect(() => validateServerEnvironment(input)).toThrow(new RegExp(credential));
	});

	it("returns typed server-only storage and selected provider secrets", () => {
		const result = validateServerEnvironment({
			...productionBase,
			REPLICATE_API_TOKEN: "replicate-secret",
		});
		expect(result.secrets.storage).toEqual({
			endpoint: "https://storage.example.com",
			region: "auto",
			bucket: "media-private",
			accessKeyId: "access",
			secretAccessKey: "secret",
		});
		expect(result.secrets.provider).toEqual({
			provider: "replicate",
			apiToken: "replicate-secret",
		});
		expect(JSON.stringify(getPublicConfig())).not.toContain("replicate-secret");
	});

	it("requires the same MEDIA_BUCKET_NAME consumed by private media storage", () => {
		const input: Record<string, string | undefined> = { ...productionBase };
		delete input.MEDIA_BUCKET_NAME;
		input.S3_BUCKET = "legacy-wrong-bucket";
		expect(() => validateServerEnvironment(input)).toThrow(/MEDIA_BUCKET_NAME/);
	});
});

describe("server media limits", () => {
	it("parses one deployment-wide media storage cap with a safe fallback", () => {
		expect(maximumMediaStorageBytes({ MEDIA_MAX_STORAGE_BYTES: "123" })).toBe(123n);
		expect(maximumMediaStorageBytes({ MEDIA_MAX_STORAGE_BYTES: "0" })).toBe(
			2n * 1024n * 1024n * 1024n,
		);
		expect(maximumMediaStorageBytes({ MEDIA_MAX_STORAGE_BYTES: "not-a-number" })).toBe(
			2n * 1024n * 1024n * 1024n,
		);
	});
});

describe("product configuration", () => {
	it("schema-validates identifiers, versions, flags, limits, and public URLs", () => {
		expect(() =>
			parseProductConfig({
				planIds: ["Not A Slug"],
				productKeys: ["bad key"],
				catalogVersion: "latest",
				pricingVersion: "v1",
				features: { mediaGeneration: "yes" },
				uploadLimits: { imageBytes: -1, videoBytes: 0 },
				publicUrls: { marketing: "javascript:alert(1)", saas: "not-a-url" },
			}),
		).toThrow();
	});

	it("projects only browser-safe configuration", () => {
		const publicConfig = getPublicConfig();

		expect(publicConfig).not.toHaveProperty("stripeSecretKey");
		expect(publicConfig).not.toHaveProperty("providerRoutes");
		expect(JSON.stringify(publicConfig)).not.toContain("providerModelId");
	});

	it("creates a stable fingerprint from normalized non-secret configuration", () => {
		const first = getConfigurationFingerprint();
		const second = getConfigurationFingerprint();

		expect(first).toMatch(/^[a-f0-9]{64}$/);
		expect(second).toBe(first);
	});

	it("rejects secret-bearing arbitrary fingerprint input", () => {
		// @ts-expect-error fingerprint input is intentionally closed and non-secret
		expect(() => getConfigurationFingerprint({ stripeSecretKey: "sk_live_leak" })).toThrow();
	});
});
