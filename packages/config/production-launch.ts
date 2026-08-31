import { z } from "zod";

import { validateServerEnvironment } from "./env";

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
				stripeWebhookScope: resourceIdSchema,
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
			"stripeWebhookScope",
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
	});

export type EzPicEnvironmentMatrix = z.infer<typeof environmentMatrixSchema>;

export interface EzPicLaunchEnvironment {
	environment: "staging" | "production";
	environmentId: string;
	deploymentVersion: string;
	origins: { marketing: string; saas: string };
	resources: {
		database: string;
		mediaBucket: string;
		stripeWebhookScope: string;
		triggerEnvironment: string;
		posthogProject: string;
		sentryEnvironment: string;
		mailProvider: string;
	};
	controls: {
		generationEnabled: boolean;
		standardEditEnabled: boolean;
		qualityEditEnabled: boolean;
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
			if (/placeholder|replace|example|not[-_./]?completed|not[-_./]?configured/i.test(value)) {
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
	const openRouterEnabled = serverEnvironment.mediaEnabledProviders.includes("openrouter");
	const openRouterCertified = optionalBoolean(input, "MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED");
	if (openRouterEnabled && openRouterCertified !== true) {
		throw new Error(
			"MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED=true is required when OpenRouter is enabled",
		);
	}
	if (!openRouterEnabled && openRouterCertified === true) {
		throw new Error(
			"MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED requires openrouter in MEDIA_ENABLED_PROVIDERS",
		);
	}

	const generationEnabled = requiredBoolean(input, "MEDIA_GENERATION_ENABLED");
	const standardEditEnabled = requiredBoolean(input, "MEDIA_STANDARD_EDIT_ENABLED");
	const qualityEditEnabled = requiredBoolean(input, "MEDIA_QUALITY_EDIT_ENABLED");
	if (qualityEditEnabled && !standardEditEnabled) {
		throw new Error("MEDIA_QUALITY_EDIT_ENABLED requires MEDIA_STANDARD_EDIT_ENABLED=true");
	}
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
	if (standardEditEnabled) {
		requireProductProvider(
			input,
			serverEnvironment.mediaEnabledProviders,
			"MEDIA_STANDARD_EDIT_ENABLED",
			[
				["replicate", "REPLICATE_API_TOKEN"],
				["fal", "FAL_API_KEY"],
				["openrouter", "OPENROUTER_API_KEY"],
			],
			requireProviderCredentials,
		);
	}
	if (qualityEditEnabled) {
		requireProductProvider(
			input,
			serverEnvironment.mediaEnabledProviders,
			"MEDIA_QUALITY_EDIT_ENABLED",
			[
				["gemini", "GEMINI_API_KEY"],
				["openrouter", "OPENROUTER_API_KEY"],
			],
			requireProviderCredentials,
		);
	}

	const marketing = realHttpsOrigin(input, "NEXT_PUBLIC_MARKETING_URL");
	const saas = realHttpsOrigin(input, "NEXT_PUBLIC_SAAS_URL");
	if (marketing !== saas) {
		throw new Error(
			"Public origins must match: NEXT_PUBLIC_MARKETING_URL and NEXT_PUBLIC_SAAS_URL",
		);
	}
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
		"STRIPE_SECRET_KEY",
		"STRIPE_WEBHOOK_SECRET",
		"SENTRY_DSN",
		"SIGHTENGINE_API_USER",
		"SIGHTENGINE_API_SECRET",
		"RESEND_API_KEY",
	] as const) {
		requiredString(input, key);
	}
	for (const key of [
		"PRICE_ID_CREATOR_MONTHLY",
		"PRICE_ID_CREATOR_YEARLY",
		"PRICE_ID_STUDIO_MONTHLY",
		"PRICE_ID_STUDIO_YEARLY",
	] as const) {
		if (!/^price_[A-Za-z0-9_]+$/.test(requiredString(input, key))) {
			throw new Error(`${key} must be a real Stripe price_ identifier`);
		}
	}
	if (!/^phc_[A-Za-z0-9_-]{10,}$/.test(requiredString(input, "NEXT_PUBLIC_POSTHOG_KEY"))) {
		throw new Error("NEXT_PUBLIC_POSTHOG_KEY must be a configured public project key");
	}
	assertNonPlaceholderToken(
		requiredString(input, "NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION"),
		"NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION",
	);
	assertNonPlaceholderToken(requiredString(input, "EZPIC_GSC_PROPERTY"), "EZPIC_GSC_PROPERTY");
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
		origins: { marketing, saas },
		resources: {
			database: requiredResourceId(input, "EZPIC_DATABASE_RESOURCE_ID"),
			mediaBucket: requiredResourceId(input, "EZPIC_MEDIA_BUCKET_RESOURCE_ID"),
			stripeWebhookScope: requiredResourceId(input, "EZPIC_STRIPE_WEBHOOK_SCOPE_ID"),
			triggerEnvironment: requiredResourceId(input, "EZPIC_TRIGGER_ENVIRONMENT_ID"),
			posthogProject: requiredResourceId(input, "EZPIC_POSTHOG_PROJECT_ID"),
			sentryEnvironment: requiredResourceId(input, "EZPIC_SENTRY_ENVIRONMENT"),
			mailProvider: requiredResourceId(input, "EZPIC_MAIL_PROVIDER_ID"),
		},
		controls: {
			generationEnabled,
			standardEditEnabled,
			qualityEditEnabled,
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
	if (productKey === "image-fast") {
		return failClosed
			? input.MEDIA_STANDARD_EDIT_ENABLED === "true"
			: input.MEDIA_STANDARD_EDIT_ENABLED !== "false";
	}
	if (productKey === "image-quality") {
		return failClosed
			? input.MEDIA_QUALITY_EDIT_ENABLED === "true"
			: input.MEDIA_QUALITY_EDIT_ENABLED !== "false";
	}
	return true;
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
