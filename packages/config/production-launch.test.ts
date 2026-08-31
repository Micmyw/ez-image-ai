import { describe, expect, it } from "vitest";

import {
	assertEzPicEnvironmentMatrixConfigured,
	mediaDailyProviderCostBudgetMicros,
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
	NEXT_PUBLIC_MARKETING_URL: "https://www.ezpic.ai",
	NEXT_PUBLIC_SAAS_URL: "https://www.ezpic.ai",
	NEXT_PUBLIC_SUPPORT_EMAIL: "support@ezpic.ai",
	NEXT_PUBLIC_SITE_NAME: "EzPic",
	NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION: "gsc-verification-token-123456",
	EZPIC_GSC_PROPERTY: "sc-domain:ezpic.ai",
	BETTER_AUTH_SECRET: "server-secret-present-only-and-long-enough-123",
	MEDIA_GENERATION_ENABLED: "true",
	LEGACY_AI_STREAM_ENABLED: "false",
	MEDIA_STANDARD_EDIT_ENABLED: "true",
	MEDIA_QUALITY_EDIT_ENABLED: "false",
	MEDIA_MODERATION_ENABLED: "true",
	BILLING_ENABLED: "true",
	ERROR_MONITORING_ENABLED: "true",
	E2E_TEST_MEDIA_ADAPTERS: "false",
	E2E_DRAFT_HANDOFF: "false",
	LOAD_TESTING_ENABLED: "false",
	MEDIA_PROVIDER_ADAPTER: "replicate",
	MEDIA_ENABLED_PROVIDERS: "replicate,gemini",
	REPLICATE_API_TOKEN: "provider-secret-present-only",
	GEMINI_API_KEY: "quality-secret-present-only",
	MEDIA_SAFETY_ADAPTER: "sightengine",
	MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "false",
	SIGHTENGINE_API_USER: "moderation-user-present-only",
	SIGHTENGINE_API_SECRET: "moderation-secret-present-only",
	S3_ENDPOINT: "https://storage.ezpic.ai",
	S3_REGION: "auto",
	MEDIA_BUCKET_NAME: "ezpic-production-private",
	S3_ACCESS_KEY_ID: "storage-key-present-only",
	S3_SECRET_ACCESS_KEY: "storage-secret-present-only",
	EZPIC_MEDIA_BUCKET_RESOURCE_ID: "r2:ezpic-production-private",
	TRIGGER_PROJECT_REF: "proj_ezpic",
	TRIGGER_SECRET_KEY: "trigger-secret-present-only",
	EZPIC_TRIGGER_ENVIRONMENT_ID: "trigger:ezpic-production",
	STRIPE_SECRET_KEY: "stripe-secret-present-only",
	STRIPE_WEBHOOK_SECRET: "stripe-webhook-secret-present-only",
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
					triggerEnvironment: `trigger:ezpic-${environment}`,
					posthogProject: `posthog:ezpic-${environment}`,
					sentryEnvironment: `sentry:ezpic-${environment}`,
					mailProvider: `mail:ezpic-${environment}`,
				},
			}),
		),
	};
}

describe("EzPic production launch environment", () => {
	it("accepts a complete production configuration without returning secret values", () => {
		const result = validateEzPicLaunchEnvironment(productionEnvironment);

		expect(result).toMatchObject({
			environment: "production",
			environmentId: "ezpic-production",
			controls: {
				generationEnabled: true,
				standardEditEnabled: true,
				qualityEditEnabled: false,
				dailyProviderCostBudgetMicros: 250_000_000n,
			},
		});
		const serialized = JSON.stringify(result, (_key, value) =>
			typeof value === "bigint" ? value.toString() : value,
		);
		for (const secret of [
			"server-secret-present-only-and-long-enough-123",
			"provider-secret-present-only",
			"quality-secret-present-only",
			"storage-secret-present-only",
			"stripe-secret-present-only",
			"stripe-webhook-secret-present-only",
			"mail-secret-present-only",
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it("accepts one canonical origin for the public tool and authenticated product", () => {
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				NEXT_PUBLIC_MARKETING_URL: productionEnvironment.NEXT_PUBLIC_SAAS_URL,
			}),
		).not.toThrow();
	});

	it("rejects a separate marketing service origin", () => {
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				NEXT_PUBLIC_MARKETING_URL: "https://marketing.ezpic.ai",
			}),
		).toThrow(/origin.*match|same origin/i);
	});

	it.each([
		["a mock Provider", { MEDIA_ENABLED_PROVIDERS: undefined, MEDIA_PROVIDER_ADAPTER: "mock" }],
		[
			"a masked mock Provider",
			{ MEDIA_ENABLED_PROVIDERS: "replicate,gemini", MEDIA_PROVIDER_ADAPTER: "mock" },
		],
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
		[
			"Standard route",
			{
				MEDIA_GENERATION_ENABLED: "false",
				MEDIA_STANDARD_EDIT_ENABLED: "true",
				MEDIA_QUALITY_EDIT_ENABLED: "false",
				MEDIA_ENABLED_PROVIDERS: "gemini",
			},
			/MEDIA_ENABLED_PROVIDERS.*replicate/i,
		],
		[
			"Standard credential",
			{
				MEDIA_GENERATION_ENABLED: "false",
				MEDIA_STANDARD_EDIT_ENABLED: "true",
				MEDIA_QUALITY_EDIT_ENABLED: "false",
				MEDIA_ENABLED_PROVIDERS: "replicate",
				REPLICATE_API_TOKEN: undefined,
			},
			/REPLICATE_API_TOKEN/,
		],
		[
			"Quality route",
			{
				MEDIA_GENERATION_ENABLED: "false",
				MEDIA_STANDARD_EDIT_ENABLED: "true",
				MEDIA_QUALITY_EDIT_ENABLED: "true",
				MEDIA_ENABLED_PROVIDERS: "replicate",
			},
			/MEDIA_ENABLED_PROVIDERS.*gemini/i,
		],
		[
			"Quality credential",
			{
				MEDIA_GENERATION_ENABLED: "false",
				MEDIA_STANDARD_EDIT_ENABLED: "true",
				MEDIA_QUALITY_EDIT_ENABLED: "true",
				MEDIA_ENABLED_PROVIDERS: "replicate,gemini",
				GEMINI_API_KEY: undefined,
			},
			/GEMINI_API_KEY/,
		],
	] as const)("fails closed when the enabled %s is unavailable", (_label, override, error) => {
		expect(() => validateEzPicLaunchEnvironment({ ...productionEnvironment, ...override })).toThrow(
			error,
		);
	});

	it("accepts the controlled initial deployment with all generation switches off", () => {
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				MEDIA_GENERATION_ENABLED: "false",
				MEDIA_STANDARD_EDIT_ENABLED: "false",
				MEDIA_QUALITY_EDIT_ENABLED: "false",
			}),
		).not.toThrow();
	});

	it("accepts the existing Fal route as a certified Standard Provider", () => {
		expect(() =>
			validateEzPicLaunchEnvironment({
				...productionEnvironment,
				MEDIA_GENERATION_ENABLED: "false",
				MEDIA_STANDARD_EDIT_ENABLED: "true",
				MEDIA_QUALITY_EDIT_ENABLED: "false",
				MEDIA_PROVIDER_ADAPTER: "fal",
				MEDIA_ENABLED_PROVIDERS: "fal",
				REPLICATE_API_TOKEN: undefined,
				FAL_API_KEY: "fal-worker-secret-present-only",
			}),
		).not.toThrow();
	});

	it("lets an API readiness process validate routes without holding worker credentials", () => {
		expect(() =>
			validateEzPicLaunchEnvironment(
				{
					...productionEnvironment,
					REPLICATE_API_TOKEN: undefined,
					GEMINI_API_KEY: undefined,
				},
				{ requireProviderCredentials: false },
			),
		).not.toThrow();
	});

	it.each([
		["NEXT_PUBLIC_MARKETING_URL", "https://marketing.placeholder.invalid"],
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
		"EZPIC_TRIGGER_ENVIRONMENT_ID",
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
		"MEDIA_STANDARD_EDIT_ENABLED",
		"MEDIA_QUALITY_EDIT_ENABLED",
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
			"TRIGGER_PROJECT_REF",
			"TRIGGER_SECRET_KEY",
			"MEDIA_BUCKET_NAME",
			"REPLICATE_API_TOKEN",
			"GEMINI_API_KEY",
			"SIGHTENGINE_API_SECRET",
			"STRIPE_WEBHOOK_SECRET",
			"SENTRY_DSN",
			"NEXT_PUBLIC_POSTHOG_KEY",
			"NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION",
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

	it.each(["database", "mediaBucket", "stripeWebhookScope", "triggerEnvironment"] as const)(
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
