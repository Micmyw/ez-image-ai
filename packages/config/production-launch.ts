import { z } from "zod";

import { validateServerEnvironment } from "./env";
import { catalogVersionSchema, DEFAULT_PRODUCT_CONFIG, EZPIC_PRODUCT_KEYS } from "./product";

const environmentNameSchema = z.enum(["development", "test", "staging", "production"]);
const resourceIdSchema = z
	.string()
	.trim()
	.min(3)
	.max(160)
	.regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/, "Invalid non-secret resource identifier");

const environmentManifestSchema = z
	.object({
		environment: environmentNameSchema,
		environmentId: resourceIdSchema,
		resources: z
			.object({
				database: resourceIdSchema,
				mediaBucket: resourceIdSchema,
				stripeWebhookScope: resourceIdSchema.optional(),
				triggerEnvironment: resourceIdSchema,
				posthogProject: resourceIdSchema,
				sentryEnvironment: resourceIdSchema,
				mailProvider: resourceIdSchema,
			})
			.strict(),
	})
	.strict();

const environmentMatrixSchema = z
	.object({
		version: z.literal(1),
		environments: z.array(environmentManifestSchema).length(4),
	})
	.strict()
	.superRefine((matrix, context) => {
		const required = environmentNameSchema.options;
		for (const environment of required) {
			const count = matrix.environments.filter((item) => item.environment === environment).length;
			if (count !== 1) {
				context.addIssue({
					code: "custom",
					path: ["environments"],
					message: `${environment} must appear exactly once`,
				});
			}
		}

		assertUniqueMatrixValues(
			matrix.environments.map((item) => item.environmentId),
			"environmentId",
			context,
		);
		for (const resource of [
			"database",
			"mediaBucket",
			"triggerEnvironment",
			"posthogProject",
			"sentryEnvironment",
			"mailProvider",
		] as const) {
			assertUniqueMatrixValues(
				matrix.environments.map((item) => item.resources[resource]),
				resource,
				context,
			);
		}
		assertUniqueMatrixValues(
			matrix.environments.flatMap((item) =>
				item.resources.stripeWebhookScope ? [item.resources.stripeWebhookScope] : [],
			),
			"stripeWebhookScope",
			context,
		);
	});

export type EzPicEnvironmentMatrix = z.infer<typeof environmentMatrixSchema>;

export interface EzPicLaunchEnvironment {
	environment: "staging" | "production";
	environmentId: string;
	deploymentVersion: string;
	origins: { saas: string };
	resources: {
		database: string;
		mediaBucket: string;
		stripeWebhookScope?: string;
		triggerEnvironment: string;
		posthogProject: string;
		sentryEnvironment: string;
		mailProvider: string;
	};
	controls: {
		generationEnabled: boolean;
		nanoBanana2LiteEnabled: boolean;
		nanoBananaEnabled: boolean;
		nanoBanana2Enabled: boolean;
		nanoBananaProEnabled: boolean;
		gptImage15Enabled: boolean;
		gptImage2Enabled: boolean;
		seedream45Enabled: boolean;
		seedream5LiteEnabled: boolean;
		seedream5ProEnabled: boolean;
		dailyProviderCostBudgetMicros: bigint;
		alerts: {
			errorRateBasisPoints: number;
			p95LatencyMs: number;
			moderationRejectionRateBasisPoints: number;
			channelId: string;
		};
	};
}

export interface ValidateEzPicLaunchEnvironmentOptions {
	requireProviderCredentials?: boolean;
}

export function validateEzPicEnvironmentMatrix(input: unknown): EzPicEnvironmentMatrix {
	return environmentMatrixSchema.parse(input);
}

export function assertEzPicEnvironmentMatrixConfigured(matrix: EzPicEnvironmentMatrix): void {
	for (const manifest of matrix.environments) {
		for (const [resource, value] of Object.entries({
			environmentId: manifest.environmentId,
			...manifest.resources,
		})) {
			if (
				value !== undefined &&
				/placeholder|replace|example|not[-_./]?completed|not[-_./]?configured/i.test(value)
			) {
				throw new Error(`NOT_COMPLETED: ${manifest.environment} ${resource} is a placeholder`);
			}
		}
	}
}

/**
 * Validates the deploy-time production contract. Secret-bearing values are checked only for
 * presence and are never included in the returned report.
 */
export function validateEzPicLaunchEnvironment(
	input: Record<string, unknown>,
	options: ValidateEzPicLaunchEnvironmentOptions = {},
): EzPicLaunchEnvironment {
	const environment = requiredString(input, "EZPIC_DEPLOYMENT_ENVIRONMENT");
	if (environment !== "staging" && environment !== "production") {
		throw new Error("EZPIC_DEPLOYMENT_ENVIRONMENT must be staging or production");
	}
	if (input.NODE_ENV !== "production") {
		throw new Error("NODE_ENV must be production for staging and production launch validation");
	}

	// Reuse the existing server/worker contract before applying EzPic release-specific gates.
	const requireProviderCredentials = options.requireProviderCredentials ?? true;
	const serverEnvironment = validateServerEnvironment(input, { requireProviderCredentials });
	if (
		environment === "production" &&
		serverEnvironment.checkoutPaymentProviders.includes("paypal") &&
		input.PAYPAL_ENVIRONMENT !== "live"
	) {
		throw new Error("PAYPAL_ENVIRONMENT must be live in production");
	}
	if (
		environment === "production" &&
		serverEnvironment.checkoutPaymentProviders.includes("waffo") &&
		input.WAFFO_ENVIRONMENT !== "prod"
	) {
		throw new Error("WAFFO_ENVIRONMENT must be prod in production");
	}
	const openRouterEnabled = serverEnvironment.mediaEnabledProviders.includes("openrouter");
	const openRouterRecoveryEnabled = serverEnvironment.mediaRecoveryProviders.includes("openrouter");
	if (openRouterEnabled) {
		throw new Error("OpenRouter is recovery-only and cannot appear in MEDIA_ENABLED_PROVIDERS");
	}
	const openRouterConfigured = openRouterRecoveryEnabled;
	const openRouterCertified = optionalBoolean(input, "MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED");
	if (openRouterConfigured && openRouterCertified !== true) {
		throw new Error(
			"MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED=true is required when OpenRouter recovery is enabled",
		);
	}
	if (!openRouterConfigured && openRouterCertified === true) {
		throw new Error(
			"MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED requires openrouter in MEDIA_RECOVERY_PROVIDERS",
		);
	}
	if (
		openRouterRecoveryEnabled &&
		requireProviderCredentials &&
		!(typeof input.OPENROUTER_API_KEY === "string" && input.OPENROUTER_API_KEY.trim())
	) {
		throw new Error("OpenRouter recovery requires OPENROUTER_API_KEY");
	}

	const generationEnabled = requiredBoolean(input, "MEDIA_GENERATION_ENABLED");
	const nanoBanana2LiteEnabled = requiredBoolean(input, "MEDIA_NANO_BANANA_2_LITE_ENABLED");
	const nanoBananaEnabled = requiredBoolean(input, "MEDIA_NANO_BANANA_ENABLED");
	const nanoBanana2Enabled = requiredBoolean(input, "MEDIA_NANO_BANANA_2_ENABLED");
	const nanoBananaProEnabled = requiredBoolean(input, "MEDIA_NANO_BANANA_PRO_ENABLED");
	const gptImage15Enabled = requiredBoolean(input, "MEDIA_GPT_IMAGE_1_5_ENABLED");
	const gptImage2Enabled = requiredBoolean(input, "MEDIA_GPT_IMAGE_2_ENABLED");
	const seedream45Enabled = requiredBoolean(input, "MEDIA_SEEDREAM_4_5_ENABLED");
	const seedream5LiteEnabled = requiredBoolean(input, "MEDIA_SEEDREAM_5_LITE_ENABLED");
	const seedream5ProEnabled = requiredBoolean(input, "MEDIA_SEEDREAM_5_PRO_ENABLED");
	const kieImageCatalogVersions = optionalCatalogVersionSet(
		input,
		"MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS",
	);
	for (const key of [
		"MEDIA_MODERATION_ENABLED",
		"BILLING_ENABLED",
		"ERROR_MONITORING_ENABLED",
	] as const) {
		requireTrue(input, key);
	}

	requireFalse(input, "LEGACY_AI_STREAM_ENABLED");
	requireFalse(input, "E2E_TEST_MEDIA_ADAPTERS");
	requireFalse(input, "E2E_DRAFT_HANDOFF");
	requireFalse(input, "LOAD_TESTING_ENABLED");
	requireFalse(input, "MEDIA_ALLOW_TEST_SAFETY_ADAPTER");
	if (input.MEDIA_SAFETY_ADAPTER !== "sightengine") {
		throw new Error("MEDIA_SAFETY_ADAPTER must be sightengine; test moderation is forbidden");
	}
	if (serverEnvironment.mediaProviderAdapter === "mock") {
		throw new Error("Production cannot use the mock Provider adapter");
	}
	const enabledKieImageControls = [
		["MEDIA_NANO_BANANA_2_LITE_ENABLED", nanoBanana2LiteEnabled],
		["MEDIA_NANO_BANANA_ENABLED", nanoBananaEnabled],
		["MEDIA_NANO_BANANA_2_ENABLED", nanoBanana2Enabled],
		["MEDIA_NANO_BANANA_PRO_ENABLED", nanoBananaProEnabled],
		["MEDIA_GPT_IMAGE_1_5_ENABLED", gptImage15Enabled],
		["MEDIA_GPT_IMAGE_2_ENABLED", gptImage2Enabled],
		["MEDIA_SEEDREAM_4_5_ENABLED", seedream45Enabled],
		["MEDIA_SEEDREAM_5_LITE_ENABLED", seedream5LiteEnabled],
		["MEDIA_SEEDREAM_5_PRO_ENABLED", seedream5ProEnabled],
	] as const;
	for (const [control, enabled] of enabledKieImageControls) {
		if (!enabled) continue;
		requireProductProvider(
			input,
			serverEnvironment.mediaEnabledProviders,
			control,
			[["kie", "KIE_API_KEY"]],
			requireProviderCredentials,
		);
		if (!kieImageCatalogVersions.has(DEFAULT_PRODUCT_CONFIG.catalogVersion)) {
			throw new Error(
				`${control} requires MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS to include the active catalog version`,
			);
		}
	}
	if (
		kieImageCatalogVersions.size > 0 &&
		!serverEnvironment.mediaEnabledProviders.includes("kie") &&
		!serverEnvironment.mediaRecoveryProviders.includes("kie")
	) {
		throw new Error(
			"MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS requires kie in MEDIA_ENABLED_PROVIDERS or MEDIA_RECOVERY_PROVIDERS",
		);
	}

	const saas = realHttpsOrigin(input, "NEXT_PUBLIC_SAAS_URL");
	realHttpsOrigin(input, "S3_ENDPOINT");
	realHttpsOrigin(input, "NEXT_PUBLIC_POSTHOG_HOST");

	for (const key of [
		"DATABASE_URL",
		"BETTER_AUTH_SECRET",
		"S3_REGION",
		"MEDIA_BUCKET_NAME",
		"S3_ACCESS_KEY_ID",
		"S3_SECRET_ACCESS_KEY",
		"TRIGGER_PROJECT_REF",
		"TRIGGER_SECRET_KEY",
		"SENTRY_DSN",
		"SIGHTENGINE_API_USER",
		"SIGHTENGINE_API_SECRET",
		"RESEND_API_KEY",
	] as const) {
		requiredString(input, key);
	}
	if (!/^phc_[A-Za-z0-9_-]{10,}$/.test(requiredString(input, "NEXT_PUBLIC_POSTHOG_KEY"))) {
		throw new Error("NEXT_PUBLIC_POSTHOG_KEY must be a configured public project key");
	}
	assertNonPlaceholderToken(
		requiredString(input, "NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION"),
		"NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION",
	);
	assertNonPlaceholderToken(requiredString(input, "EZPIC_GSC_PROPERTY"), "EZPIC_GSC_PROPERTY");
	assertProductionSupportEmail(requiredString(input, "NEXT_PUBLIC_SUPPORT_EMAIL"));
	assertProductionMailFrom(requiredString(input, "MAIL_FROM"));

	const deploymentVersion = requiredString(input, "DEPLOYMENT_VERSION");
	assertNonPlaceholderToken(deploymentVersion, "DEPLOYMENT_VERSION");
	const dailyProviderCostBudgetMicros = mediaDailyProviderCostBudgetMicros(input);
	if (dailyProviderCostBudgetMicros === undefined) {
		throw new Error("MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS is required");
	}

	return {
		environment,
		environmentId: requiredResourceId(input, "EZPIC_ENVIRONMENT_ID"),
		deploymentVersion,
		origins: { saas },
		resources: {
			database: requiredResourceId(input, "EZPIC_DATABASE_RESOURCE_ID"),
			mediaBucket: requiredResourceId(input, "EZPIC_MEDIA_BUCKET_RESOURCE_ID"),
			...(serverEnvironment.stripeLegacyLifecycleEnabled
				? {
						stripeWebhookScope: requiredResourceId(input, "EZPIC_STRIPE_WEBHOOK_SCOPE_ID"),
					}
				: {}),
			triggerEnvironment: requiredResourceId(input, "EZPIC_TRIGGER_ENVIRONMENT_ID"),
			posthogProject: requiredResourceId(input, "EZPIC_POSTHOG_PROJECT_ID"),
			sentryEnvironment: requiredResourceId(input, "EZPIC_SENTRY_ENVIRONMENT"),
			mailProvider: requiredResourceId(input, "EZPIC_MAIL_PROVIDER_ID"),
		},
		controls: {
			generationEnabled,
			nanoBanana2LiteEnabled,
			nanoBananaEnabled,
			nanoBanana2Enabled,
			nanoBananaProEnabled,
			gptImage15Enabled,
			gptImage2Enabled,
			seedream45Enabled,
			seedream5LiteEnabled,
			seedream5ProEnabled,
			dailyProviderCostBudgetMicros,
			alerts: {
				errorRateBasisPoints: requiredInteger(input, "MEDIA_ALERT_ERROR_RATE_BPS", 1, 10_000),
				p95LatencyMs: requiredInteger(input, "MEDIA_ALERT_P95_LATENCY_MS", 1, 900_000),
				moderationRejectionRateBasisPoints: requiredInteger(
					input,
					"MEDIA_ALERT_MODERATION_REJECTION_RATE_BPS",
					1,
					10_000,
				),
				channelId: requiredResourceId(input, "MEDIA_ALERT_CHANNEL_ID"),
			},
		},
	};
}

function assertProductionSupportEmail(value: string): void {
	const parsed = z.email().safeParse(value);
	const domain = value.slice(value.lastIndexOf("@") + 1).toLowerCase();
	if (
		!parsed.success ||
		/placeholder|replace[-_]?me/i.test(value) ||
		domain === "localhost" ||
		domain.endsWith(".invalid") ||
		["example.com", "example.net", "example.org"].includes(domain)
	) {
		throw new Error("NEXT_PUBLIC_SUPPORT_EMAIL must be a real public support address");
	}
}

export function mediaDailyProviderCostBudgetMicros(
	input: Record<string, unknown>,
): bigint | undefined {
	const raw = input.MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS;
	if (raw === undefined) return undefined;
	if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) {
		throw new Error("MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS must be a positive integer");
	}
	return BigInt(raw);
}

export function isEzPicProductEnvironmentEnabled(
	productKey: string,
	input: Record<string, unknown> = process.env,
): boolean {
	const failClosed =
		input.NODE_ENV === "production" ||
		input.EZPIC_DEPLOYMENT_ENVIRONMENT === "staging" ||
		input.EZPIC_DEPLOYMENT_ENVIRONMENT === "production";
	const environmentKey = EZPIC_IMAGE_PRODUCT_ENVIRONMENT_KEYS[productKey];
	if (environmentKey) {
		return failClosed ? input[environmentKey] === "true" : input[environmentKey] !== "false";
	}
	return true;
}

const EZPIC_IMAGE_PRODUCT_ENVIRONMENT_KEYS: Readonly<Record<string, string>> = Object.freeze({
	"image-nano-banana-2-lite": "MEDIA_NANO_BANANA_2_LITE_ENABLED",
	"image-nano-banana": "MEDIA_NANO_BANANA_ENABLED",
	"image-nano-banana-2": "MEDIA_NANO_BANANA_2_ENABLED",
	"image-nano-banana-pro": "MEDIA_NANO_BANANA_PRO_ENABLED",
	"image-gpt-image-1-5": "MEDIA_GPT_IMAGE_1_5_ENABLED",
	"image-gpt-image-2": "MEDIA_GPT_IMAGE_2_ENABLED",
	"image-seedream-4-5": "MEDIA_SEEDREAM_4_5_ENABLED",
	"image-seedream-5-lite": "MEDIA_SEEDREAM_5_LITE_ENABLED",
	"image-seedream-5-pro": "MEDIA_SEEDREAM_5_PRO_ENABLED",
} satisfies Record<(typeof EZPIC_PRODUCT_KEYS)[number], string>);

function optionalCatalogVersionSet(input: Record<string, unknown>, key: string): Set<string> {
	const raw = input[key];
	if (raw === undefined) return new Set();
	if (typeof raw !== "string") throw new Error(`${key} must be a comma-separated version list`);
	const versions = raw
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (versions.length === 0 || new Set(versions).size !== versions.length) {
		throw new Error(`${key} must contain unique catalog versions`);
	}
	for (const version of versions) {
		if (!catalogVersionSchema.safeParse(version).success) {
			throw new Error(`${key} contains an invalid catalog version`);
		}
	}
	return new Set(versions);
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${key} must be true or false`);
}

function assertUniqueMatrixValues(values: string[], label: string, context: z.RefinementCtx): void {
	if (new Set(values).size !== values.length) {
		context.addIssue({
			code: "custom",
			path: ["environments"],
			message: `${label} must be distinct across development, test, staging, and production`,
		});
	}
}

function requiredString(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
	return value.trim();
}

function requiredResourceId(input: Record<string, unknown>, key: string): string {
	const parsed = resourceIdSchema.safeParse(requiredString(input, key));
	if (!parsed.success) throw new Error(`${key} must be a non-secret resource identifier`);
	if (/placeholder|replace|example|not[-_./]?completed|not[-_./]?configured/i.test(parsed.data)) {
		throw new Error(`${key} must not be a placeholder`);
	}
	return parsed.data;
}

function requiredBoolean(input: Record<string, unknown>, key: string): boolean {
	const value = input[key];
	if (value !== "true" && value !== "false") throw new Error(`${key} must be true or false`);
	return value === "true";
}

function requireFalse(input: Record<string, unknown>, key: string): void {
	if (input[key] !== "false") throw new Error(`${key} must be false for staging/production`);
}

function requireTrue(input: Record<string, unknown>, key: string): void {
	if (input[key] !== "true") throw new Error(`${key} must be true for staging/production`);
}

function requireProductProvider(
	input: Record<string, unknown>,
	enabledProviders: readonly string[],
	productControl: string,
	routes: ReadonlyArray<readonly [provider: string, credentialKey: string]>,
	requireCredential: boolean,
): void {
	const configuredRoutes = routes.filter(([provider]) => enabledProviders.includes(provider));
	if (configuredRoutes.length === 0) {
		throw new Error(
			`${productControl} requires MEDIA_ENABLED_PROVIDERS to include ${routes
				.map(([provider]) => provider)
				.join(" or ")}`,
		);
	}
	if (
		requireCredential &&
		!configuredRoutes.some(([, key]) => typeof input[key] === "string" && input[key].trim())
	) {
		throw new Error(
			`${productControl} requires ${configuredRoutes.map(([, key]) => key).join(" or ")}`,
		);
	}
}

function requiredInteger(
	input: Record<string, unknown>,
	key: string,
	minimum: number,
	maximum: number,
): number {
	const value = requiredString(input, key);
	if (!/^\d+$/.test(value)) throw new Error(`${key} must be an integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${key} must be between ${minimum} and ${maximum}`);
	}
	return parsed;
}

function realHttpsOrigin(input: Record<string, unknown>, key: string): string {
	const value = requiredString(input, key);
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${key} must be a valid URL`);
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.hostname.endsWith(".invalid") ||
		/(^|\.)(?:example\.com|example\.net|example\.org)$/.test(url.hostname) ||
		["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
		url.search ||
		url.hash
	) {
		throw new Error(`${key} must be a real credential-free HTTPS origin`);
	}
	return url.origin;
}

function assertNonPlaceholderToken(value: string, key: string): void {
	if (value.length < 8 || /placeholder|replace|example|local|not[_-]?completed/i.test(value)) {
		throw new Error(`${key} must not be a placeholder`);
	}
}

function assertProductionMailFrom(value: string): void {
	const match = /(?:^|<)([^<>\s]+@[^<>\s]+)(?:>|$)/.exec(value);
	if (!match?.[1] || /@(?:localhost|[^@]+\.invalid)$/i.test(match[1])) {
		throw new Error("MAIL_FROM must use a production sender domain");
	}
}
