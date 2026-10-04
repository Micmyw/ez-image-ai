import { describe, expect, it } from "vitest";

import {
	assertEzPicEnvironmentMatrixConfigured,
	EZPIC_IMAGE_PRODUCT_ENVIRONMENT_KEYS,
	isEzPicProductEnvironmentEnabled,
	mediaDailyProviderCostBudgetMicros,
	packEzPicImageModelFlags,
	parseEzPicImageModelFlags,
	validateEzPicEnvironmentMatrix,
	validateEzPicLaunchEnvironment,
} from "./production-launch";

const productionEnvironment = {
	NODE_ENV: "production",
	EZPIC_DEPLOYMENT_ENVIRONMENT: "production",
	EZPIC_ENVIRONMENT_ID: "ezpic-production",
	DEPLOYMENT_VERSION: "98287b05a8b4881cbf9c1b415738c52cda086ee5",
	DATABASE_URL: "postgresql://runtime:secret@db.example.net/ezpic_production",
	EZPIC_DATABASE_RESOURCE_ID: "postgres:ezpic-production",
	NEXT_PUBLIC_SAAS_URL: "https://www.ezpic.ai",
	NEXT_PUBLIC_SUPPORT_EMAIL: "support@ezpic.ai",
	NEXT_PUBLIC_SITE_NAME: "EzPic",
	NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION: "gsc-verification-token-123456",
	EZPIC_GSC_PROPERTY: "sc-domain:ezpic.ai",
	BETTER_AUTH_SECRET: "server-secret-present-only-and-long-enough-123",
	MEDIA_GENERATION_ENABLED: "true",
	LEGACY_AI_STREAM_ENABLED: "false",
	MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
	MEDIA_NANO_BANANA_ENABLED: "false",
	MEDIA_NANO_BANANA_2_ENABLED: "false",
	MEDIA_NANO_BANANA_PRO_ENABLED: "false",
	MEDIA_GPT_IMAGE_1_5_ENABLED: "false",
	MEDIA_GPT_IMAGE_2_ENABLED: "false",
	MEDIA_SEEDREAM_4_5_ENABLED: "false",
	MEDIA_SEEDREAM_5_LITE_ENABLED: "false",
	MEDIA_SEEDREAM_5_PRO_ENABLED: "false",
	MEDIA_MODERATION_ENABLED: "true",
	BILLING_ENABLED: "true",
	ERROR_MONITORING_ENABLED: "true",
	E2E_TEST_MEDIA_ADAPTERS: "false",
	E2E_DRAFT_HANDOFF: "false",
	LOAD_TESTING_ENABLED: "false",
	MEDIA_PROVIDER_ADAPTER: "kie",
	MEDIA_ENABLED_PROVIDERS: "kie",
	MEDIA_RECOVERY_PROVIDERS: "kie",
	MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED: "false",
	MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: "2026-09-07.2,2026-09-14.1",
	KIE_API_KEY: "kie-worker-secret-present-only",
	MEDIA_SAFETY_ADAPTER: "configured",
	MODERATION_TEXT_WAFFO_ENABLED: "true",
	MODERATION_IMAGE_SEEAPI_ENABLED: "true",
	SEEAPI_API_KEY: "moderation-key-present-only",
	MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "false",
	S3_ENDPOINT: "https://storage.ezpic.ai",
	S3_REGION: "auto",
	MEDIA_BUCKET_NAME: "ezpic-production-private",
	S3_ACCESS_KEY_ID: "storage-key-present-only",
	S3_SECRET_ACCESS_KEY: "storage-secret-present-only",
	EZPIC_MEDIA_BUCKET_RESOURCE_ID: "r2:ezpic-production-private",
	WORKFLOWS_DISPATCH_URL: "https://jobs.ezpic.ai/internal/dispatch",
	WORKFLOWS_DISPATCH_SECRET: "workflows-dispatch-test-secret-32-characters",
	EZPIC_WORKFLOWS_ENVIRONMENT_ID: "workflows:ezpic-production",
	STRIPE_SECRET_KEY: "stripe-secret-present-only",
	STRIPE_WEBHOOK_SECRET: "stripe-webhook-secret-present-only",
	PAYPAL_ENVIRONMENT: "live",
	PAYPAL_CLIENT_ID: "paypal-client-present-only",
	PAYPAL_CLIENT_SECRET: "paypal-secret-present-only",
	PAYPAL_WEBHOOK_ID: "WH-paypal-webhook",
	PAYPAL_PLAN_ID_CREATOR_MONTHLY: "P-CREATOR-MONTHLY",
	WAFFO_ENVIRONMENT: "prod",
	WAFFO_STORE_ID: "STO_0123456789AbCdEfGhIjKl",
	WAFFO_MERCHANT_ID: "waffo-merchant-present-only",
	WAFFO_PRIVATE_KEY: "waffo-private-key-present-only",
	WAFFO_WEBHOOK_PUBLIC_KEY: "waffo-webhook-public-key-present-only",
	WAFFO_PRODUCT_ID_CREATOR_MONTHLY: "PROD_0123456789AbCdEfGhIjKl",
	PRICE_ID_CREATOR_MONTHLY: "price_CreatorMonthlyProduction",
	PRICE_ID_CREATOR_YEARLY: "price_CreatorYearlyProduction",
	PRICE_ID_STUDIO_MONTHLY: "price_StudioMonthlyProduction",
	PRICE_ID_STUDIO_YEARLY: "price_StudioYearlyProduction",
	EZPIC_STRIPE_WEBHOOK_SCOPE_ID: "stripe-webhook:ezpic-production",
	SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
	EZPIC_SENTRY_ENVIRONMENT: "ezpic-production",
	NEXT_PUBLIC_POSTHOG_KEY: "phc_public_project_key_123456",
	NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com",
	EZPIC_POSTHOG_PROJECT_ID: "posthog:ezpic-production",
	MAIL_FROM: "EzPic <noreply@ezpic.ai>",
	RESEND_API_KEY: "mail-secret-present-only",
	EZPIC_MAIL_PROVIDER_ID: "resend:ezpic-production",
	MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS: "250000000",
	MEDIA_ALERT_ERROR_RATE_BPS: "500",
	MEDIA_ALERT_P95_LATENCY_MS: "120000",
	MEDIA_ALERT_MODERATION_REJECTION_RATE_BPS: "1500",
	MEDIA_ALERT_CHANNEL_ID: "ops:ezpic-production",
} as const;

describe("packed image model environment flags", () => {
	const modelEntries = Object.entries(EZPIC_IMAGE_PRODUCT_ENVIRONMENT_KEYS);
	const optionalKeys = new Set([
		"MEDIA_GPT_IMAGE_2_5_FLARE_ENABLED",
		"MEDIA_GPT_IMAGE_2_5_SUNBURST_ENABLED",
		"MEDIA_SEEDREAM_4_ENABLED",
	]);

	it("preserves the complete launch report and absent optional flags", () => {
		const packed = packEzPicImageModelFlags(productionEnvironment);
		expect(validateEzPicLaunchEnvironment(packed)).toEqual(
			validateEzPicLaunchEnvironment(productionEnvironment),
		);
		const flags = parseEzPicImageModelFlags(packed.MEDIA_IMAGE_MODEL_FLAGS);
		for (const [, key] of modelEntries) expect(packed).not.toHaveProperty(key);
		for (const key of optionalKeys) expect(flags).not.toHaveProperty(key);
		expect(packed.MEDIA_GENERATION_ENABLED).toBe("true");
		expect(packed.MEDIA_MODERATION_ENABLED).toBe("true");
		expect(packed.BILLING_ENABLED).toBe("true");
	});

	it.each(modelEntries)(
		"preserves true/false and reads each environment afresh for %s",
		(product, key) => {
			for (const value of ["true", "false", "true"] as const) {
				const flat = { ...productionEnvironment, [key]: value };
				const packed = packEzPicImageModelFlags(flat);
				expect(isEzPicProductEnvironmentEnabled(product, packed)).toBe(value === "true");
				expect(isEzPicProductEnvironmentEnabled(product, packed)).toBe(
					isEzPicProductEnvironmentEnabled(product, flat),
				);
				expect(validateEzPicLaunchEnvironment(packed)).toEqual(
					validateEzPicLaunchEnvironment(flat),
				);
			}
		},
	);

	it.each(modelEntries.filter(([, key]) => !optionalKeys.has(key)))(
		"does not fill a missing required switch for %s",
		(_product, key) => {
			const flat: Record<string, string> = { ...productionEnvironment };
			delete flat[key];
			expect(() => validateEzPicLaunchEnvironment(packEzPicImageModelFlags(flat))).toThrow(
				`${key} must be true or false`,
			);
		},
	);

	it.each(modelEntries)("retains legacy absence defaults for %s", (product, key) => {
		expect(isEzPicProductEnvironmentEnabled(product, { NODE_ENV: "production" })).toBe(false);
		expect(isEzPicProductEnvironmentEnabled(product, { NODE_ENV: "development" })).toBe(
			!optionalKeys.has(key),
		);
		expect(
			isEzPicProductEnvironmentEnabled(product, {
				NODE_ENV: "production",
				MEDIA_IMAGE_MODEL_FLAGS: "{}",
			}),
		).toBe(false);
	});

	it.each([
		"",
		"{",
		"null",
		"[]",
		"true",
		"0",
		JSON.stringify({ MEDIA_GPT_IMAGE_2_ENABLED: true }),
		JSON.stringify({ MEDIA_GPT_IMAGE_2_ENABLED: "TRUE" }),
		JSON.stringify({ MEDIA_GPT_IMAGE_2_ENABLED: "" }),
		JSON.stringify({ MEDIA_GPT_IMAGE_2_ENABLED: 0 }),
		JSON.stringify({ MEDIA_MODERATION_ENABLED: "false" }),
		JSON.stringify({ BILLING_ENABLED: "false" }),
		JSON.stringify({ MEDIA_GENERATION_ENABLED: "true" }),
		'{"__proto__":{"MEDIA_GPT_IMAGE_2_ENABLED":"true"}}',
		undefined,
		null,
		{},
	])(
		"rejects a malformed present binding without falling back to enabled flat flags: %j",
		(value) => {
			expect(() => parseEzPicImageModelFlags(value)).toThrow("MEDIA_IMAGE_MODEL_FLAGS");
			if (value === undefined) return; // Only an absent binding keeps the legacy path.
			for (const NODE_ENV of ["production", "development"]) {
				const input = { ...productionEnvironment, NODE_ENV, MEDIA_IMAGE_MODEL_FLAGS: value };
				expect(isEzPicProductEnvironmentEnabled("image-nano-banana-2-lite", input)).toBe(false);
				expect(() => validateEzPicLaunchEnvironment(input)).toThrow("MEDIA_IMAGE_MODEL_FLAGS");
			}
		},
	);

	it.each(["true", "false"])("rejects conflicting flat and packed flags: %s", (value) => {
		const key = "MEDIA_NANO_BANANA_2_LITE_ENABLED";
		const input = {
			...packEzPicImageModelFlags({ ...productionEnvironment, [key]: value }),
			[key]: value === "true" ? "false" : "true",
		};
		expect(isEzPicProductEnvironmentEnabled("image-nano-banana-2-lite", input)).toBe(false);
		expect(() => validateEzPicLaunchEnvironment(input)).toThrow(
			"MEDIA_IMAGE_MODEL_FLAGS conflicts",
		);
		expect(() => packEzPicImageModelFlags(input)).toThrow("MEDIA_IMAGE_MODEL_FLAGS conflicts");
	});

	it("accepts matching flat values during transition but preserves other launch gates", () => {
		const input = {
			...productionEnvironment,
			...packEzPicImageModelFlags(productionEnvironment),
		};
		expect(validateEzPicLaunchEnvironment(input)).toEqual(
			validateEzPicLaunchEnvironment(productionEnvironment),
		);
		for (const key of ["MEDIA_MODERATION_ENABLED", "BILLING_ENABLED"])
			expect(() => validateEzPicLaunchEnvironment({ ...input, [key]: "false" })).toThrow(key);
		expect(
			validateEzPicLaunchEnvironment({ ...input, MEDIA_GENERATION_ENABLED: "false" }).controls
				.generationEnabled,
		).toBe(false);
		expect(() => validateEzPicLaunchEnvironment({ ...input, KIE_API_KEY: undefined })).toThrow();
	});
});

it("validates a Workers launch with Hyperdrive and no database origin secret", () => {
	expect(() =>
		validateEzPicLaunchEnvironment({
			...productionEnvironment,
			DATABASE_URL: undefined,
			EZPIC_RUNTIME: "workers",
			EZPIC_DATABASE_BINDING: "hyperdrive",
		}),
	).not.toThrow();
});

function environmentMatrix() {
	return {
		version: 1,
		environments: (["development", "test", "staging", "production"] as const).map(
			(environment) => ({
				environment,
				environmentId: `ezpic-${environment}`,
				resources: {
					database: `postgres:ezpic-${environment}`,
					mediaBucket: `r2:ezpic-${environment}`,
					stripeWebhookScope: `stripe-webhook:ezpic-${environment}`,
					workflowEnvironment: `workflows:ezpic-${environment}`,
					posthogProject: `posthog:ezpic-${environment}`,
					sentryEnvironment: `sentry:ezpic-${environment}`,
					mailProvider: `mail:ezpic-${environment}`,
				},
			}),
		),
	};
}

describe("EzPic production launch environment", () => {
	it.each([undefined, "", "   "])(
		"accepts DNS-verified Search Console without an HTML verification token (%s)",
		(token) => {
			expect(() =>
				validateEzPicLaunchEnvironment({
					...productionEnvironment,
					EZPIC_GSC_PROPERTY: "sc-domain:ezpic.ai",
					NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION: token,
				}),
			).not.toThrow();
		},
	);

	it("does not activate Waffo payments when only its prompt-scanning credentials are supplied", () => {
		const input: Record<string, unknown> = {
			...productionEnvironment,
			MEDIA_SAFETY_ADAPTER: "configured",
			MODERATION_TEXT_WAFFO_ENABLED: "true",
			MODERATION_IMAGE_SEEAPI_ENABLED: "true",
			SEEAPI_API_KEY: "fixture",
		};
		for (const key of Object.keys(input)) if (key.startsWith("WAFFO_")) delete input[key];
		input.WAFFO_MERCHANT_ID = "merchant";
		input.WAFFO_PRIVATE_KEY = "private";
		expect(() => validateEzPicLaunchEnvironment(input)).not.toThrow();
	});
	it("validates Waffo and SeeAPI without retired provider credentials and rejects all-off", () => {
		const input = {
			...productionEnvironment,
			MEDIA_SAFETY_ADAPTER: "configured",
			MODERATION_TEXT_WAFFO_ENABLED: "true",
			MODERATION_IMAGE_SEEAPI_ENABLED: "true",
			SEEAPI_API_KEY: "seeapi-fixture",
		};
		expect(() => validateEzPicLaunchEnvironment(input)).not.toThrow();
		expect(() =>
			validateEzPicLaunchEnvironment({ ...input, MODERATION_IMAGE_SEEAPI_ENABLED: "false" }),
		).toThrow("SeeAPI image moderation must be enabled");
	});
	it("accepts PayPal/Waffo production billing without Stripe lifecycle configuration", () => {
		const input: Record<string, string | undefined> = { ...productionEnvironment };
		for (const key of [
			"STRIPE_SECRET_KEY",
			"STRIPE_WEBHOOK_SECRET",
			"PRICE_ID_CREATOR_MONTHLY",
			"PRICE_ID_CREATOR_YEARLY",
			"PRICE_ID_STUDIO_MONTHLY",
			"PRICE_ID_STUDIO_YEARLY",
			"EZPIC_STRIPE_WEBHOOK_SCOPE_ID",
		]) {
			delete input[key];
		}

		const result = validateEzPicLaunchEnvironment(input);
		expect(result.resources).not.toHaveProperty("stripeWebhookScope");
	});

	it("requires a Stripe Webhook scope only when legacy Stripe lifecycle is configured", () => {
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				EZPIC_STRIPE_WEBHOOK_SCOPE_ID: undefined,
			}),
		).toThrow(/EZPIC_STRIPE_WEBHOOK_SCOPE_ID/);
	});

	it("accepts a complete production configuration without returning secret values", () => {
		const result = validateEzPicLaunchEnvironment(productionEnvironment);

		expect(result).toMatchObject({
			environment: "production",
			environmentId: "ezpic-production",
			controls: {
				generationEnabled: true,
				nanoBanana2LiteEnabled: true,
				nanoBananaEnabled: false,
				nanoBanana2Enabled: false,
				nanoBananaProEnabled: false,
				gptImage15Enabled: false,
				gptImage2Enabled: false,
				seedream45Enabled: false,
				seedream5LiteEnabled: false,
				seedream5ProEnabled: false,
				dailyProviderCostBudgetMicros: 250_000_000n,
			},
		});
		const serialized = JSON.stringify(result, (_key, value) =>
			typeof value === "bigint" ? value.toString() : value,
		);
		for (const secret of [
			"server-secret-present-only-and-long-enough-123",
			"kie-worker-secret-present-only",
			"storage-secret-present-only",
			"stripe-secret-present-only",
			"stripe-webhook-secret-present-only",
			"paypal-secret-present-only",
			"waffo-private-key-present-only",
			"mail-secret-present-only",
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it.each([
		["image-nano-banana-2-lite", "MEDIA_NANO_BANANA_2_LITE_ENABLED"],
		["image-nano-banana", "MEDIA_NANO_BANANA_ENABLED"],
		["image-nano-banana-2", "MEDIA_NANO_BANANA_2_ENABLED"],
		["image-nano-banana-pro", "MEDIA_NANO_BANANA_PRO_ENABLED"],
		["image-gpt-image-1-5", "MEDIA_GPT_IMAGE_1_5_ENABLED"],
		["image-gpt-image-2", "MEDIA_GPT_IMAGE_2_ENABLED"],
		["image-seedream-4-5", "MEDIA_SEEDREAM_4_5_ENABLED"],
		["image-seedream-5-lite", "MEDIA_SEEDREAM_5_LITE_ENABLED"],
		["image-seedream-5-pro", "MEDIA_SEEDREAM_5_PRO_ENABLED"],
	] as const)("uses an independent fail-closed gate for %s", (productKey, environmentKey) => {
		expect(
			isEzPicProductEnvironmentEnabled(productKey, {
				NODE_ENV: "production",
				[environmentKey]: undefined,
			}),
		).toBe(false);
		expect(
			isEzPicProductEnvironmentEnabled(productKey, {
				NODE_ENV: "production",
				[environmentKey]: "true",
			}),
		).toBe(true);
	});

	it("rejects launch configuration that Waffo checkout would reject locally", () => {
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				WAFFO_PRODUCT_ID_CREATOR_MONTHLY: "PROD_CreatorMonthly",
			}),
		).toThrow(/WAFFO_PRODUCT_ID_CREATOR_MONTHLY/);
	});

	it("rejects sandbox payment environments in a production launch", () => {
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				PAYPAL_ENVIRONMENT: "sandbox",
			}),
		).toThrow(/PAYPAL_ENVIRONMENT.*live/i);
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				WAFFO_ENVIRONMENT: "test",
			}),
		).toThrow(/WAFFO_ENVIRONMENT.*prod/i);
	});

	it.each([undefined, "", "support@localhost.invalid", "replace-me@example.com"])(
		"requires a real public support email (%s)",
		(value) => {
			expect(() =>
				validateEzPicLaunchEnvironment({
					...productionEnvironment,
					NEXT_PUBLIC_SUPPORT_EMAIL: value,
				}),
			).toThrow(/NEXT_PUBLIC_SUPPORT_EMAIL/);
		},
	);

	it("accepts the SaaS origin as the only canonical public origin", () => {
		expect(() => validateEzPicLaunchEnvironment(productionEnvironment)).not.toThrow();
	});

	it("does not reactivate a retired public-origin compatibility value", () => {
		const retiredOriginKey = ["NEXT", "PUBLIC", "MARKETING", "URL"].join("_");
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				[retiredOriginKey]: "https://legacy.placeholder.invalid",
			}),
		).not.toThrow();
	});

	it.each([
		["a mock Provider", { MEDIA_ENABLED_PROVIDERS: undefined, MEDIA_PROVIDER_ADAPTER: "mock" }],
		["a masked mock Provider", { MEDIA_ENABLED_PROVIDERS: "kie", MEDIA_PROVIDER_ADAPTER: "mock" }],
		["the test moderation adapter", { MEDIA_SAFETY_ADAPTER: "test" }],
		["test browser adapters", { E2E_TEST_MEDIA_ADAPTERS: "true" }],
		["the legacy AI stream", { LEGACY_AI_STREAM_ENABLED: "true" }],
		["a load-test route", { LOAD_TESTING_ENABLED: "true" }],
	] as const)("rejects production with %s", (_label, override) => {
		expect(() => validateEzPicLaunchEnvironment({ ...productionEnvironment, ...override })).toThrow(
			/mock|test|legacy|load/i,
		);
	});

	it.each(["MEDIA_MODERATION_ENABLED", "BILLING_ENABLED", "ERROR_MONITORING_ENABLED"] as const)(
		"requires production service control %s to be enabled",
		(key) => {
			expect(() =>
				validateEzPicLaunchEnvironment({ ...productionEnvironment, [key]: "false" }),
			).toThrow(new RegExp(key));
		},
	);

	it.each([
		"MEDIA_NANO_BANANA_2_LITE_ENABLED",
		"MEDIA_NANO_BANANA_ENABLED",
		"MEDIA_NANO_BANANA_2_ENABLED",
		"MEDIA_NANO_BANANA_PRO_ENABLED",
		"MEDIA_GPT_IMAGE_1_5_ENABLED",
		"MEDIA_GPT_IMAGE_2_ENABLED",
		"MEDIA_SEEDREAM_4_5_ENABLED",
		"MEDIA_SEEDREAM_5_LITE_ENABLED",
		"MEDIA_SEEDREAM_5_PRO_ENABLED",
	] as const)("fails closed when %s has no Kie route", (control) => {
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				MEDIA_GENERATION_ENABLED: "false",
				MEDIA_NANO_BANANA_2_LITE_ENABLED: "false",
				MEDIA_NANO_BANANA_ENABLED: "false",
				MEDIA_NANO_BANANA_2_ENABLED: "false",
				MEDIA_NANO_BANANA_PRO_ENABLED: "false",
				MEDIA_GPT_IMAGE_1_5_ENABLED: "false",
				MEDIA_GPT_IMAGE_2_ENABLED: "false",
				MEDIA_SEEDREAM_4_5_ENABLED: "false",
				MEDIA_SEEDREAM_5_LITE_ENABLED: "false",
				MEDIA_SEEDREAM_5_PRO_ENABLED: "false",
				[control]: "true",
				MEDIA_PROVIDER_ADAPTER: "fal",
				MEDIA_ENABLED_PROVIDERS: "fal",
				MEDIA_RECOVERY_PROVIDERS: "fal",
				MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: undefined,
				FAL_API_KEY: "fal-worker-secret-present-only",
			}),
		).toThrow(/MEDIA_ENABLED_PROVIDERS.*kie/i);
	});

	it.each([
		"MEDIA_NANO_BANANA_2_LITE_ENABLED",
		"MEDIA_NANO_BANANA_ENABLED",
		"MEDIA_NANO_BANANA_2_ENABLED",
		"MEDIA_NANO_BANANA_PRO_ENABLED",
		"MEDIA_GPT_IMAGE_1_5_ENABLED",
		"MEDIA_GPT_IMAGE_2_ENABLED",
		"MEDIA_SEEDREAM_4_5_ENABLED",
		"MEDIA_SEEDREAM_5_LITE_ENABLED",
		"MEDIA_SEEDREAM_5_PRO_ENABLED",
	] as const)("fails closed when %s has no Kie credential", (control) => {
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				MEDIA_GENERATION_ENABLED: "false",
				MEDIA_NANO_BANANA_2_LITE_ENABLED: "false",
				MEDIA_NANO_BANANA_ENABLED: "false",
				MEDIA_NANO_BANANA_2_ENABLED: "false",
				MEDIA_NANO_BANANA_PRO_ENABLED: "false",
				MEDIA_GPT_IMAGE_1_5_ENABLED: "false",
				MEDIA_GPT_IMAGE_2_ENABLED: "false",
				MEDIA_SEEDREAM_4_5_ENABLED: "false",
				MEDIA_SEEDREAM_5_LITE_ENABLED: "false",
				MEDIA_SEEDREAM_5_PRO_ENABLED: "false",
				[control]: "true",
				KIE_API_KEY: undefined,
			}),
		).toThrow(/KIE_API_KEY/);
	});

	it("accepts the controlled initial deployment with all generation switches off", () => {
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				MEDIA_GENERATION_ENABLED: "false",
				MEDIA_NANO_BANANA_2_LITE_ENABLED: "false",
				MEDIA_NANO_BANANA_ENABLED: "false",
				MEDIA_NANO_BANANA_2_ENABLED: "false",
				MEDIA_NANO_BANANA_PRO_ENABLED: "false",
				MEDIA_GPT_IMAGE_1_5_ENABLED: "false",
				MEDIA_GPT_IMAGE_2_ENABLED: "false",
				MEDIA_SEEDREAM_4_5_ENABLED: "false",
				MEDIA_SEEDREAM_5_LITE_ENABLED: "false",
				MEDIA_SEEDREAM_5_PRO_ENABLED: "false",
			}),
		).not.toThrow();
	});

	it("does not allow legacy OpenRouter to serve a new Kie product", () => {
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				MEDIA_GENERATION_ENABLED: "false",
				MEDIA_PROVIDER_ADAPTER: "openrouter",
				MEDIA_ENABLED_PROVIDERS: "openrouter",
				MEDIA_RECOVERY_PROVIDERS: "openrouter",
				MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED: "true",
				MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: undefined,
				OPENROUTER_API_KEY: "openrouter-worker-secret-present-only",
			}),
		).toThrow(/OpenRouter.*recovery-only/i);
	});

	it("lets an API readiness process validate routes without holding worker credentials", () => {
		expect(() =>
			validateEzPicLaunchEnvironment(
				{
					...productionEnvironment,
					KIE_API_KEY: undefined,
				},
				{ requireProviderCredentials: false },
			),
		).not.toThrow();
	});

	it("allows certified OpenRouter recovery without enabling new OpenRouter submissions", () => {
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				MEDIA_RECOVERY_PROVIDERS: "kie,openrouter",
				MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED: "true",
				OPENROUTER_API_KEY: "openrouter-worker-secret-present-only",
			}),
		).not.toThrow();
	});

	it("requires the OpenRouter credential only in the recovery worker", () => {
		const recoveryEnvironment = {
			...productionEnvironment,
			MEDIA_RECOVERY_PROVIDERS: "kie,openrouter",
			MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED: "true",
			OPENROUTER_API_KEY: undefined,
		};

		expect(() => validateEzPicLaunchEnvironment(recoveryEnvironment)).toThrow(/OPENROUTER_API_KEY/);
		expect(() =>
			validateEzPicLaunchEnvironment(recoveryEnvironment, {
				requireProviderCredentials: false,
			}),
		).not.toThrow();
	});

	it("rejects OpenRouter from the new-submission provider set even when Kie is enabled", () => {
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				MEDIA_ENABLED_PROVIDERS: "kie,openrouter",
				MEDIA_RECOVERY_PROVIDERS: "kie,openrouter",
				MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED: "true",
				OPENROUTER_API_KEY: "openrouter-worker-secret-present-only",
			}),
		).toThrow(/OpenRouter.*recovery-only/i);
	});

	it("fails closed for every mismatched OpenRouter recovery certification", () => {
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				MEDIA_RECOVERY_PROVIDERS: "kie,openrouter",
				MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED: undefined,
				OPENROUTER_API_KEY: "openrouter-worker-secret-present-only",
			}),
		).toThrow(/MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED/);
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED: "true",
			}),
		).toThrow(/MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED.*MEDIA_RECOVERY_PROVIDERS/);
	});

	it("does not require or interpret the retired Kie image certification setting", () => {
		for (const versions of [undefined, "", "2026-09-06.1", "obsolete-value"] as const) {
			expect(() =>
				validateEzPicLaunchEnvironment({
					...productionEnvironment,
					MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: versions,
				}),
			).not.toThrow();
		}
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: "2026-09-07.2,2026-09-14.1",
			}),
		).not.toThrow();
	});

	it.each([
		["NEXT_PUBLIC_SAAS_URL", "http://127.0.0.1:3000"],
		["NEXT_PUBLIC_SAAS_URL", "https://app.ezpic.ai/unexpected-path"],
		["S3_ENDPOINT", "http://127.0.0.1:59000"],
		["NEXT_PUBLIC_POSTHOG_HOST", "https://posthog.placeholder.invalid"],
	] as const)("rejects a non-production %s", (key, value) => {
		expect(() =>
			validateEzPicLaunchEnvironment({ ...productionEnvironment, [key]: value }),
		).toThrow(new RegExp(key));
	});

	it.each([
		"EZPIC_ENVIRONMENT_ID",
		"EZPIC_DATABASE_RESOURCE_ID",
		"EZPIC_MEDIA_BUCKET_RESOURCE_ID",
		"EZPIC_STRIPE_WEBHOOK_SCOPE_ID",
		"EZPIC_WORKFLOWS_ENVIRONMENT_ID",
		"EZPIC_POSTHOG_PROJECT_ID",
		"EZPIC_SENTRY_ENVIRONMENT",
		"EZPIC_MAIL_PROVIDER_ID",
	] as const)("rejects placeholder launch resource %s", (key) => {
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				[key]: "not-completed/production/resource",
			}),
		).toThrow(new RegExp(key));
	});

	it.each([
		"MEDIA_GENERATION_ENABLED",
		"MEDIA_NANO_BANANA_2_LITE_ENABLED",
		"MEDIA_NANO_BANANA_ENABLED",
		"MEDIA_NANO_BANANA_2_ENABLED",
		"MEDIA_NANO_BANANA_PRO_ENABLED",
		"MEDIA_GPT_IMAGE_1_5_ENABLED",
		"MEDIA_GPT_IMAGE_2_ENABLED",
		"MEDIA_SEEDREAM_4_5_ENABLED",
		"MEDIA_SEEDREAM_5_LITE_ENABLED",
		"MEDIA_SEEDREAM_5_PRO_ENABLED",
		"MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS",
		"MEDIA_ALERT_ERROR_RATE_BPS",
		"MEDIA_ALERT_P95_LATENCY_MS",
		"MEDIA_ALERT_MODERATION_REJECTION_RATE_BPS",
		"MEDIA_ALERT_CHANNEL_ID",
	] as const)("fails closed when launch control %s is absent", (key) => {
		const input: Record<string, string | undefined> = { ...productionEnvironment };
		delete input[key];
		expect(() => validateEzPicLaunchEnvironment(input)).toThrow(new RegExp(key));
	});

	it("requires every external service contract without exposing its secret", () => {
		for (const key of [
			"DATABASE_URL",
			"WORKFLOWS_DISPATCH_URL",
			"WORKFLOWS_DISPATCH_SECRET",
			"MEDIA_BUCKET_NAME",
			"KIE_API_KEY",
			"SEEAPI_API_KEY",
			"STRIPE_WEBHOOK_SECRET",
			"PAYPAL_CLIENT_SECRET",
			"WAFFO_PRIVATE_KEY",
			"SENTRY_DSN",
			"NEXT_PUBLIC_POSTHOG_KEY",
			"EZPIC_GSC_PROPERTY",
			"RESEND_API_KEY",
		] as const) {
			const input: Record<string, string | undefined> = { ...productionEnvironment };
			delete input[key];
			expect(() => validateEzPicLaunchEnvironment(input), key).toThrow(new RegExp(key));
		}
	});

	it("parses the enforced global daily Provider budget only when explicitly positive", () => {
		expect(mediaDailyProviderCostBudgetMicros(productionEnvironment)).toBe(250_000_000n);
		expect(mediaDailyProviderCostBudgetMicros({})).toBeUndefined();
		expect(() =>
			mediaDailyProviderCostBudgetMicros({
				MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS: "0",
			}),
		).toThrow(/MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS/);
	});
});

describe("EzPic environment isolation matrix", () => {
	it("allows environments that do not provision a legacy Stripe Webhook scope", () => {
		const matrix = environmentMatrix();
		for (const manifest of matrix.environments) {
			delete (manifest.resources as Partial<typeof manifest.resources>).stripeWebhookScope;
		}

		expect(() => validateEzPicEnvironmentMatrix(matrix)).not.toThrow();
	});

	it("requires one distinct dev, test, staging, and production resource set", () => {
		const matrix = validateEzPicEnvironmentMatrix(environmentMatrix());
		expect(matrix.environments).toHaveLength(4);
		expect(() => assertEzPicEnvironmentMatrixConfigured(matrix)).not.toThrow();
	});

	it("keeps a placeholder matrix structurally valid but refuses to certify it", () => {
		const matrix = environmentMatrix();
		matrix.environments[3]!.resources.database = "not-completed/production/database";
		expect(() =>
			assertEzPicEnvironmentMatrixConfigured(validateEzPicEnvironmentMatrix(matrix)),
		).toThrow(/NOT_COMPLETED.*database/i);
	});

	it.each(["database", "mediaBucket", "stripeWebhookScope", "workflowEnvironment"] as const)(
		"rejects a shared %s",
		(resource) => {
			const matrix = environmentMatrix();
			matrix.environments[3]!.resources[resource] = matrix.environments[2]!.resources[resource];
			expect(() => validateEzPicEnvironmentMatrix(matrix)).toThrow(new RegExp(resource, "i"));
		},
	);

	it("rejects a matrix that omits any required environment", () => {
		const matrix = environmentMatrix();
		matrix.environments.pop();
		expect(() => validateEzPicEnvironmentMatrix(matrix)).toThrow(/production/i);
	});
});
