import { z } from "zod";

import { assertWorkflowsConfiguration } from "./workflows";

export const WAFFO_PRODUCT_ID_PATTERN = /^PROD_[0-9A-Za-z]{22}$/;

const booleanStringSchema = z
	.enum(["true", "false"])
	.default("false")
	.transform((value) => value === "true");

const optionalSecretSchema = z.string().min(1).optional();
const optionalPayPalPlanIdSchema = z
	.string()
	.regex(/^P-[A-Z0-9-]+$/)
	.optional();
const optionalPayPalProductIdSchema = z
	.string()
	.regex(/^PROD-[A-Z0-9-]+$/)
	.optional();
const optionalWaffoProductIdSchema = z.string().regex(WAFFO_PRODUCT_ID_PATTERN).optional();

export const mediaProviderKeySchema = z.enum(["replicate", "fal", "kie", "gemini", "openrouter"]);
export type MediaProviderKey = z.infer<typeof mediaProviderKeySchema>;

const mediaProviderAdapterSchema = z.enum([
	"replicate",
	"fal",
	"kie",
	"gemini",
	"openrouter",
	"mock",
]);

const rawServerEnvironmentSchema = z.object({
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
	EZPIC_RUNTIME: z.enum(["node", "workers"]).optional(),
	EZPIC_DATABASE_BINDING: z.literal("hyperdrive").optional(),
	MEDIA_GENERATION_ENABLED: booleanStringSchema,
	MEDIA_MODERATION_ENABLED: booleanStringSchema,
	BILLING_ENABLED: booleanStringSchema,
	ERROR_MONITORING_ENABLED: booleanStringSchema,
	DATABASE_URL: optionalSecretSchema,
	S3_ENDPOINT: z.url().optional(),
	S3_REGION: optionalSecretSchema,
	MEDIA_BUCKET_NAME: optionalSecretSchema,
	S3_ACCESS_KEY_ID: optionalSecretSchema,
	S3_SECRET_ACCESS_KEY: optionalSecretSchema,
	WORKFLOWS_DISPATCH_URL: optionalSecretSchema,
	WORKFLOWS_DISPATCH_SECRET: optionalSecretSchema,
	STRIPE_SECRET_KEY: optionalSecretSchema,
	STRIPE_WEBHOOK_SECRET: optionalSecretSchema,
	PAYPAL_ENVIRONMENT: z.enum(["sandbox", "live"]).optional(),
	PAYPAL_CLIENT_ID: optionalSecretSchema,
	PAYPAL_CLIENT_SECRET: optionalSecretSchema,
	PAYPAL_WEBHOOK_ID: optionalSecretSchema,
	PAYPAL_PLAN_ID_CREATOR_MONTHLY: optionalPayPalPlanIdSchema,
	PAYPAL_PLAN_ID_CREATOR_YEARLY: optionalPayPalPlanIdSchema,
	PAYPAL_PLAN_ID_ULTIMATE_MONTHLY: optionalPayPalPlanIdSchema,
	PAYPAL_PLAN_ID_ULTIMATE_YEARLY: optionalPayPalPlanIdSchema,
	PAYPAL_PLAN_ID_STUDIO_MONTHLY: optionalPayPalPlanIdSchema,
	PAYPAL_PLAN_ID_STUDIO_YEARLY: optionalPayPalPlanIdSchema,
	PAYPAL_PRODUCT_ID_CREDITS_1500: optionalPayPalProductIdSchema,
	PAYPAL_PRODUCT_ID_CREDITS_3000: optionalPayPalProductIdSchema,
	PAYPAL_PRODUCT_ID_CREDITS_5000: optionalPayPalProductIdSchema,
	PAYPAL_PRODUCT_ID_CREDITS_8000: optionalPayPalProductIdSchema,
	WAFFO_ENVIRONMENT: z.enum(["test", "prod"]).optional(),
	WAFFO_STORE_ID: optionalSecretSchema,
	WAFFO_MERCHANT_ID: optionalSecretSchema,
	WAFFO_PRIVATE_KEY: optionalSecretSchema,
	WAFFO_WEBHOOK_PUBLIC_KEY: optionalSecretSchema,
	WAFFO_PRODUCT_ID_CREATOR_MONTHLY: optionalWaffoProductIdSchema,
	WAFFO_PRODUCT_ID_CREATOR_YEARLY: optionalWaffoProductIdSchema,
	WAFFO_PRODUCT_ID_ULTIMATE_MONTHLY: optionalWaffoProductIdSchema,
	WAFFO_PRODUCT_ID_ULTIMATE_YEARLY: optionalWaffoProductIdSchema,
	WAFFO_PRODUCT_ID_STUDIO_MONTHLY: optionalWaffoProductIdSchema,
	WAFFO_PRODUCT_ID_STUDIO_YEARLY: optionalWaffoProductIdSchema,
	WAFFO_PRODUCT_ID_CREDITS_1500: optionalWaffoProductIdSchema,
	WAFFO_PRODUCT_ID_CREDITS_3000: optionalWaffoProductIdSchema,
	WAFFO_PRODUCT_ID_CREDITS_5000: optionalWaffoProductIdSchema,
	WAFFO_PRODUCT_ID_CREDITS_8000: optionalWaffoProductIdSchema,
	SENTRY_DSN: z.url().optional(),
	SIGHTENGINE_API_USER: optionalSecretSchema,
	SIGHTENGINE_API_SECRET: optionalSecretSchema,
	REPLICATE_API_TOKEN: optionalSecretSchema,
	FAL_API_KEY: optionalSecretSchema,
	KIE_API_KEY: optionalSecretSchema,
	GEMINI_API_KEY: optionalSecretSchema,
	OPENROUTER_API_KEY: optionalSecretSchema,
	MEDIA_PROVIDER_ADAPTER: mediaProviderAdapterSchema.default("mock"),
	MEDIA_ENABLED_PROVIDERS: z.string().optional(),
	MEDIA_RECOVERY_PROVIDERS: z.string().optional(),
	MEDIA_SAFETY_ADAPTER: z.enum(["sightengine", "test"]).default("test"),
	MEDIA_ALLOW_TEST_SAFETY_ADAPTER: booleanStringSchema,
	GUEST_MEDIA_ENABLED: booleanStringSchema,
	GUEST_PROMOTION_PERIOD: z.string().trim().min(1).optional(),
	GUEST_COST_EVIDENCE_ID: z.string().trim().min(1).optional(),
	GUEST_HARD_BUDGET_MICROS: z
		.string()
		.regex(/^[1-9][0-9]*$/)
		.optional(),
	GUEST_RISK_BUDGET_MICROS: z
		.string()
		.regex(/^[1-9][0-9]*$/)
		.optional(),
	GUEST_TURNSTILE_SECRET_KEY: optionalSecretSchema,
	NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY: optionalSecretSchema,
	MEDIA_TRUSTED_PROXY_PROVIDER: z.enum(["vercel", "cloudflare"]).optional(),
});

export interface ServerEnvironment {
	nodeEnv: "development" | "test" | "production";
	mediaGenerationEnabled: boolean;
	mediaModerationEnabled: boolean;
	billingEnabled: boolean;
	checkoutPaymentProviders: CheckoutPaymentProvider[];
	stripeLegacyLifecycleEnabled: boolean;
	errorMonitoringEnabled: boolean;
	mediaProviderAdapter: "replicate" | "fal" | "kie" | "gemini" | "openrouter" | "mock";
	mediaEnabledProviders: MediaProviderKey[];
	mediaRecoveryProviders: MediaProviderKey[];
	mediaSafetyAdapter: "sightengine" | "test";
	allowTestSafetyAdapter: boolean;
	guestMediaRequestedEnabled: boolean;
	guestMediaPromotionPeriod: string | undefined;
	secrets: ServerSecrets;
}

export interface StorageSecrets {
	endpoint: string | undefined;
	region: string | undefined;
	bucket: string | undefined;
	accessKeyId: string | undefined;
	secretAccessKey: string | undefined;
}
export type ProviderSecrets =
	| { provider: "replicate"; apiToken: string | undefined }
	| { provider: "fal"; apiKey: string | undefined }
	| { provider: "kie"; apiKey: string | undefined }
	| { provider: "gemini"; apiKey: string | undefined }
	| { provider: "openrouter"; apiKey: string | undefined }
	| { provider: "mock" };
export interface ServerSecrets {
	databaseUrl: string | undefined;
	storage: StorageSecrets;
	workflowsDispatchUrl: string | undefined;
	workflowsDispatchSecret: string | undefined;
	stripeSecretKey: string | undefined;
	stripeWebhookSecret: string | undefined;
	sentryDsn: string | undefined;
	sightengineApiUser: string | undefined;
	sightengineApiSecret: string | undefined;
	guestTurnstileSecretKey: string | undefined;
	provider: ProviderSecrets;
}

export interface ValidateServerEnvironmentOptions {
	/** API-only processes validate provider configuration but do not hold provider worker keys. */
	requireProviderCredentials?: boolean;
}

export type CheckoutPaymentProvider = "paypal" | "waffo";
export type StripeLegacyLifecycleStatus = "DISABLED" | "INCOMPLETE" | "CONFIGURED";

const PAYPAL_REQUIRED_CONFIGURATION_KEYS = [
	"PAYPAL_ENVIRONMENT",
	"PAYPAL_CLIENT_ID",
	"PAYPAL_CLIENT_SECRET",
	"PAYPAL_WEBHOOK_ID",
] as const;

const WAFFO_REQUIRED_CONFIGURATION_KEYS = [
	"WAFFO_ENVIRONMENT",
	"WAFFO_STORE_ID",
	"WAFFO_MERCHANT_ID",
	"WAFFO_PRIVATE_KEY",
	"WAFFO_WEBHOOK_PUBLIC_KEY",
] as const;

const STRIPE_LEGACY_LIFECYCLE_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const;

export function getStripeLegacyLifecycleStatus(input: {
	STRIPE_SECRET_KEY?: unknown;
	STRIPE_WEBHOOK_SECRET?: unknown;
}): StripeLegacyLifecycleStatus {
	const configuredCount = STRIPE_LEGACY_LIFECYCLE_KEYS.filter((key) =>
		hasConfiguredValue(input[key]),
	).length;
	if (configuredCount === 0) return "DISABLED";
	return configuredCount === STRIPE_LEGACY_LIFECYCLE_KEYS.length ? "CONFIGURED" : "INCOMPLETE";
}

export function validateServerEnvironment(
	input: Record<string, unknown>,
	options: ValidateServerEnvironmentOptions = {},
): ServerEnvironment {
	const parsed = rawServerEnvironmentSchema.parse(input);
	const issues: string[] = [];
	const checkoutPaymentProviders = getCheckoutPaymentProviders(parsed);
	const stripeLegacyLifecycleStatus = getStripeLegacyLifecycleStatus(parsed);
	if (parsed.MEDIA_SAFETY_ADAPTER === "test" && !parsed.MEDIA_ALLOW_TEST_SAFETY_ADAPTER) {
		issues.push("MEDIA_ALLOW_TEST_SAFETY_ADAPTER");
	}

	if (parsed.NODE_ENV === "production") {
		const legacyMockProviderIsActive =
			parsed.MEDIA_ENABLED_PROVIDERS === undefined && parsed.MEDIA_PROVIDER_ADAPTER === "mock";
		if (legacyMockProviderIsActive || parsed.MEDIA_SAFETY_ADAPTER === "test") {
			issues.push("Production cannot use mock or test adapters");
		}

		if (parsed.MEDIA_GENERATION_ENABLED) {
			assertWorkflowsConfiguration(parsed);
			requireValues(parsed, issues, [
				"S3_ENDPOINT",
				"S3_REGION",
				"MEDIA_BUCKET_NAME",
				"S3_ACCESS_KEY_ID",
				"S3_SECRET_ACCESS_KEY",
			]);
			if (!usesHyperdriveDatabase(parsed)) requireValues(parsed, issues, ["DATABASE_URL"]);
			if (parseMediaEnabledProviders(parsed).length === 0) {
				issues.push("MEDIA_ENABLED_PROVIDERS");
			}
			if (options.requireProviderCredentials ?? true) {
				requireEnabledProviderCredentials(parsed, issues);
			}
		}

		if (parsed.BILLING_ENABLED && checkoutPaymentProviders.length === 0) {
			issues.push("PAYPAL_OR_WAFFO_PAYMENT_CONFIGURATION");
		}
		if (stripeLegacyLifecycleStatus === "INCOMPLETE") {
			requireValues(parsed, issues, [...STRIPE_LEGACY_LIFECYCLE_KEYS]);
		}
		validateOptionalPaymentProviders(parsed, issues);

		if (parsed.ERROR_MONITORING_ENABLED) {
			requireValues(parsed, issues, ["SENTRY_DSN"]);
		}

		if (parsed.MEDIA_MODERATION_ENABLED) {
			requireValues(parsed, issues, ["SIGHTENGINE_API_USER", "SIGHTENGINE_API_SECRET"]);
		}
	}

	if (issues.length > 0) {
		throw new Error(`Invalid server environment: ${issues.join(", ")}`);
	}

	return {
		nodeEnv: parsed.NODE_ENV,
		mediaGenerationEnabled: parsed.MEDIA_GENERATION_ENABLED,
		mediaModerationEnabled: parsed.MEDIA_MODERATION_ENABLED,
		billingEnabled: parsed.BILLING_ENABLED,
		checkoutPaymentProviders,
		stripeLegacyLifecycleEnabled: stripeLegacyLifecycleStatus === "CONFIGURED",
		errorMonitoringEnabled: parsed.ERROR_MONITORING_ENABLED,
		mediaProviderAdapter: parsed.MEDIA_PROVIDER_ADAPTER,
		mediaEnabledProviders: parseMediaEnabledProviders(parsed),
		mediaRecoveryProviders: parseMediaRecoveryProviders(parsed),
		mediaSafetyAdapter: parsed.MEDIA_SAFETY_ADAPTER,
		allowTestSafetyAdapter: parsed.MEDIA_ALLOW_TEST_SAFETY_ADAPTER,
		guestMediaRequestedEnabled: parsed.GUEST_MEDIA_ENABLED,
		guestMediaPromotionPeriod: parsed.GUEST_PROMOTION_PERIOD,
		secrets: Object.freeze({
			databaseUrl: parsed.DATABASE_URL,
			storage: Object.freeze({
				endpoint: parsed.S3_ENDPOINT,
				region: parsed.S3_REGION,
				bucket: parsed.MEDIA_BUCKET_NAME,
				accessKeyId: parsed.S3_ACCESS_KEY_ID,
				secretAccessKey: parsed.S3_SECRET_ACCESS_KEY,
			}),
			workflowsDispatchUrl: parsed.WORKFLOWS_DISPATCH_URL,
			workflowsDispatchSecret: parsed.WORKFLOWS_DISPATCH_SECRET,
			stripeSecretKey: parsed.STRIPE_SECRET_KEY,
			stripeWebhookSecret: parsed.STRIPE_WEBHOOK_SECRET,
			sentryDsn: parsed.SENTRY_DSN,
			sightengineApiUser: parsed.SIGHTENGINE_API_USER,
			sightengineApiSecret: parsed.SIGHTENGINE_API_SECRET,
			guestTurnstileSecretKey: parsed.GUEST_TURNSTILE_SECRET_KEY,
			provider: selectedProviderSecrets(parsed),
		}),
	};
}

/** Runtime wrappers verify the actual binding before invoking any business code. */
export function usesHyperdriveDatabase(environment: Record<string, unknown>): boolean {
	return (
		environment.EZPIC_RUNTIME === "workers" && environment.EZPIC_DATABASE_BINDING === "hyperdrive"
	);
}

function validateOptionalPaymentProviders(
	input: z.infer<typeof rawServerEnvironmentSchema>,
	issues: string[],
): void {
	requireCompleteProviderGroup(
		input,
		issues,
		[...PAYPAL_REQUIRED_CONFIGURATION_KEYS],
		[
			"PAYPAL_PLAN_ID_CREATOR_MONTHLY",
			"PAYPAL_PLAN_ID_CREATOR_YEARLY",
			"PAYPAL_PLAN_ID_ULTIMATE_MONTHLY",
			"PAYPAL_PLAN_ID_ULTIMATE_YEARLY",
			"PAYPAL_PLAN_ID_STUDIO_MONTHLY",
			"PAYPAL_PLAN_ID_STUDIO_YEARLY",
			"PAYPAL_PRODUCT_ID_CREDITS_1500",
			"PAYPAL_PRODUCT_ID_CREDITS_3000",
			"PAYPAL_PRODUCT_ID_CREDITS_5000",
			"PAYPAL_PRODUCT_ID_CREDITS_8000",
		],
	);
	requireCompleteProviderGroup(
		input,
		issues,
		[...WAFFO_REQUIRED_CONFIGURATION_KEYS],
		[
			"WAFFO_PRODUCT_ID_CREATOR_MONTHLY",
			"WAFFO_PRODUCT_ID_CREATOR_YEARLY",
			"WAFFO_PRODUCT_ID_ULTIMATE_MONTHLY",
			"WAFFO_PRODUCT_ID_ULTIMATE_YEARLY",
			"WAFFO_PRODUCT_ID_STUDIO_MONTHLY",
			"WAFFO_PRODUCT_ID_STUDIO_YEARLY",
			"WAFFO_PRODUCT_ID_CREDITS_1500",
			"WAFFO_PRODUCT_ID_CREDITS_3000",
			"WAFFO_PRODUCT_ID_CREDITS_5000",
			"WAFFO_PRODUCT_ID_CREDITS_8000",
		],
	);
}

function getCheckoutPaymentProviders(
	input: z.infer<typeof rawServerEnvironmentSchema>,
): CheckoutPaymentProvider[] {
	const providers: CheckoutPaymentProvider[] = [];
	if (PAYPAL_REQUIRED_CONFIGURATION_KEYS.every((key) => hasConfiguredValue(input[key]))) {
		providers.push("paypal");
	}
	if (WAFFO_REQUIRED_CONFIGURATION_KEYS.every((key) => hasConfiguredValue(input[key]))) {
		providers.push("waffo");
	}
	return providers;
}

function requireCompleteProviderGroup(
	input: z.infer<typeof rawServerEnvironmentSchema>,
	issues: string[],
	requiredKeys: Array<keyof z.infer<typeof rawServerEnvironmentSchema>>,
	priceKeys: Array<keyof z.infer<typeof rawServerEnvironmentSchema>>,
): void {
	if (![...requiredKeys, ...priceKeys].some((key) => hasConfiguredValue(input[key]))) return;
	requireValues(input, issues, requiredKeys);
}

export function parseMediaEnabledProviders(input: {
	MEDIA_ENABLED_PROVIDERS?: string;
	MEDIA_PROVIDER_ADAPTER?: z.infer<typeof mediaProviderAdapterSchema>;
}): MediaProviderKey[] {
	if (input.MEDIA_ENABLED_PROVIDERS !== undefined) {
		return parseProviderList(input.MEDIA_ENABLED_PROVIDERS, "MEDIA_ENABLED_PROVIDERS");
	}

	const legacy = input.MEDIA_PROVIDER_ADAPTER ?? "mock";
	return legacy === "mock" ? [] : [legacy];
}

/**
 * Recovery routes are worker-only: they may drain callbacks and retrieve already accepted
 * provider tasks, but they never make a provider eligible for a new submission. Falling back
 * to the submission list preserves the pre-recovery configuration until an operator explicitly
 * keeps a disabled provider available for drain.
 */
export function parseMediaRecoveryProviders(input: {
	MEDIA_RECOVERY_PROVIDERS?: string;
	MEDIA_ENABLED_PROVIDERS?: string;
	MEDIA_PROVIDER_ADAPTER?: z.infer<typeof mediaProviderAdapterSchema>;
}): MediaProviderKey[] {
	if (input.MEDIA_RECOVERY_PROVIDERS !== undefined) {
		return parseProviderList(input.MEDIA_RECOVERY_PROVIDERS, "MEDIA_RECOVERY_PROVIDERS");
	}
	return parseMediaEnabledProviders(input);
}

function parseProviderList(value: string, key: string): MediaProviderKey[] {
	if (!value.trim()) return [];
	const providers = value.split(",").map((item) => item.trim());
	if (providers.some((provider) => !provider)) {
		throw new Error(`Invalid ${key}`);
	}
	const normalized = providers.map((provider) => {
		const parsed = mediaProviderKeySchema.safeParse(provider);
		if (!parsed.success) throw new Error(`Invalid ${key}`);
		return parsed.data;
	});
	if (new Set(normalized).size !== normalized.length) {
		throw new Error(`Invalid ${key}`);
	}
	return normalized;
}

function requireEnabledProviderCredentials(
	input: z.infer<typeof rawServerEnvironmentSchema>,
	issues: string[],
): void {
	const credentialKeys = {
		replicate: "REPLICATE_API_TOKEN",
		fal: "FAL_API_KEY",
		kie: "KIE_API_KEY",
		gemini: "GEMINI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
	} as const;
	for (const provider of parseMediaEnabledProviders(input)) {
		const key = credentialKeys[provider];
		if (!input[key]) issues.push(key);
	}
}

function selectedProviderSecrets(
	input: z.infer<typeof rawServerEnvironmentSchema>,
): ProviderSecrets {
	switch (input.MEDIA_PROVIDER_ADAPTER) {
		case "replicate":
			return { provider: "replicate", apiToken: input.REPLICATE_API_TOKEN };
		case "fal":
			return { provider: "fal", apiKey: input.FAL_API_KEY };
		case "kie":
			return { provider: "kie", apiKey: input.KIE_API_KEY };
		case "gemini":
			return { provider: "gemini", apiKey: input.GEMINI_API_KEY };
		case "openrouter":
			return { provider: "openrouter", apiKey: input.OPENROUTER_API_KEY };
		case "mock":
			return { provider: "mock" };
	}
}

function requireValues(
	input: z.infer<typeof rawServerEnvironmentSchema>,
	issues: string[],
	keys: Array<keyof z.infer<typeof rawServerEnvironmentSchema>>,
): void {
	for (const key of keys) {
		if (!hasConfiguredValue(input[key])) {
			issues.push(String(key));
		}
	}
}

function hasConfiguredValue(value: unknown): boolean {
	return typeof value === "string"
		? value.trim().length > 0
		: value !== undefined && value !== null;
}
