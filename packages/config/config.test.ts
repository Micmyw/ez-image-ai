import { describe, expect, it } from "vitest";

import {
	DEFAULT_PRODUCT_CONFIG,
	getPublicConfig,
	parseProductConfig,
	PLAN_ENTITLEMENTS,
} from "./index";
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

	it("requires every production submission provider to hold its worker credential", () => {
		const input: Record<string, string | undefined> = {
			...productionBase,
			MEDIA_ENABLED_PROVIDERS: "replicate,fal",
		};
		delete input.REPLICATE_API_TOKEN;

		expect(() => validateServerEnvironment(input)).toThrow(/REPLICATE_API_TOKEN|FAL_API_KEY/);
	});

	it("parses OpenRouter as a server-only provider and requires its worker credential", () => {
		const configured = {
			...productionBase,
			MEDIA_PROVIDER_ADAPTER: "openrouter",
			MEDIA_ENABLED_PROVIDERS: "openrouter",
			OPENROUTER_API_KEY: "openrouter-worker-secret",
		};
		expect(validateServerEnvironment(configured)).toMatchObject({
			mediaProviderAdapter: "openrouter",
			mediaEnabledProviders: ["openrouter"],
		});
		expect(() =>
			validateServerEnvironment({ ...configured, OPENROUTER_API_KEY: undefined }),
		).toThrow(/OPENROUTER_API_KEY/);
	});

	it("allows an API-only process to validate configured routes without worker provider credentials", () => {
		const input: Record<string, string | undefined> = {
			...productionBase,
			MEDIA_ENABLED_PROVIDERS: "replicate",
		};
		delete input.REPLICATE_API_TOKEN;

		expect(validateServerEnvironment(input, { requireProviderCredentials: false })).toMatchObject({
			mediaEnabledProviders: ["replicate"],
		});
		expect(() => validateServerEnvironment(input)).toThrow(/REPLICATE_API_TOKEN/);
	});

	it("rejects an explicit empty provider list when generation is enabled", () => {
		expect(() =>
			validateServerEnvironment({
				...productionBase,
				MEDIA_PROVIDER_ADAPTER: "mock",
				MEDIA_ENABLED_PROVIDERS: "",
			}),
		).toThrow(/MEDIA_ENABLED_PROVIDERS/);
	});

	it("allows shared real routes in production when the ignored legacy adapter remains mock", () => {
		expect(
			validateServerEnvironment({
				...productionBase,
				MEDIA_PROVIDER_ADAPTER: "mock",
				MEDIA_ENABLED_PROVIDERS: "replicate,fal",
				FAL_API_KEY: "fal-secret",
			}),
		).toMatchObject({ mediaEnabledProviders: ["replicate", "fal"] });
	});

	it("keeps explicit recovery providers server-side and independent from new submission routes", () => {
		expect(
			validateServerEnvironment({
				...productionBase,
				MEDIA_ENABLED_PROVIDERS: "fal",
				MEDIA_RECOVERY_PROVIDERS: "replicate,fal",
				FAL_API_KEY: "fal-secret",
			}),
		).toMatchObject({
			mediaEnabledProviders: ["fal"],
			mediaRecoveryProviders: ["replicate", "fal"],
		});
	});

	it("requires the legacy selected provider credential when the shared list is absent", () => {
		expect(() =>
			validateServerEnvironment({
				...productionBase,
				MEDIA_PROVIDER_ADAPTER: "kie",
				KIE_API_KEY: undefined,
			}),
		).toThrow(/KIE_API_KEY/);
	});

	it("rejects unknown and duplicate shared provider keys", () => {
		for (const mediaEnabledProviders of ["replicate,unknown", "replicate,replicate"]) {
			expect(() =>
				validateServerEnvironment({
					...productionBase,
					MEDIA_ENABLED_PROVIDERS: mediaEnabledProviders,
				}),
			).toThrow(/MEDIA_ENABLED_PROVIDERS/);
		}
		for (const mediaRecoveryProviders of ["replicate,unknown", "replicate,replicate"]) {
			expect(() =>
				validateServerEnvironment({
					...productionBase,
					MEDIA_RECOVERY_PROVIDERS: mediaRecoveryProviders,
				}),
			).toThrow(/MEDIA_RECOVERY_PROVIDERS/);
		}
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
	it("publishes the EzPic image-editing product contract without template branding", () => {
		const publicConfig = getPublicConfig();

		expect(DEFAULT_PRODUCT_CONFIG.productKeys).toEqual(["image-fast", "image-quality"]);
		expect(DEFAULT_PRODUCT_CONFIG.catalogVersion).toBe("2026-08-31.1");
		expect(DEFAULT_PRODUCT_CONFIG.pricingVersion).toBe("2026-08-31.1");
		expect(publicConfig.brand).toMatchObject({
			siteName: "EzPic",
			siteDescription: expect.stringMatching(/image edit/i),
			supportEmail: null,
		});
		expect(Object.values(publicConfig.publicUrls)).toEqual([
			"https://marketing.placeholder.invalid",
			"https://app.placeholder.invalid",
		]);
	});

	it("publishes the complete EzPic plan contract from one server-owned catalog", () => {
		expect(
			PLAN_ENTITLEMENTS.map(
				({
					id,
					monthlyCredits,
					maximumConcurrentJobs,
					maximumInputBytes,
					allowedProducts,
					prices,
				}) => ({
					id,
					monthlyCredits,
					maximumConcurrentJobs,
					maximumInputBytes,
					allowedProducts,
					prices,
				}),
			),
		).toEqual([
			{
				id: "free",
				monthlyCredits: 25,
				maximumConcurrentJobs: 1,
				maximumInputBytes: 10 * 1024 * 1024,
				allowedProducts: ["image-fast"],
				prices: [],
			},
			{
				id: "creator",
				monthlyCredits: 1_000,
				maximumConcurrentJobs: 3,
				maximumInputBytes: 20 * 1024 * 1024,
				allowedProducts: ["image-fast", "image-quality"],
				prices: [
					{ interval: "month", amount: 19, currency: "USD" },
					{ interval: "year", amount: 190, currency: "USD" },
				],
			},
			{
				id: "studio",
				monthlyCredits: 5_000,
				maximumConcurrentJobs: 10,
				maximumInputBytes: 20 * 1024 * 1024,
				allowedProducts: ["image-fast", "image-quality"],
				prices: [
					{ interval: "month", amount: 79, currency: "USD" },
					{ interval: "year", amount: 790, currency: "USD" },
				],
			},
		]);
	});

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
