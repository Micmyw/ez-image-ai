import { z } from "zod";

const booleanStringSchema = z
	.enum(["true", "false"])
	.default("false")
	.transform((value) => value === "true");

const optionalSecretSchema = z.string().min(1).optional();

export const mediaProviderKeySchema = z.enum(["replicate", "fal", "kie", "gemini"]);
export type MediaProviderKey = z.infer<typeof mediaProviderKeySchema>;

const mediaProviderAdapterSchema = z.enum(["replicate", "fal", "kie", "gemini", "mock"]);

const rawServerEnvironmentSchema = z.object({
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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
	TRIGGER_SECRET_KEY: optionalSecretSchema,
	STRIPE_SECRET_KEY: optionalSecretSchema,
	STRIPE_WEBHOOK_SECRET: optionalSecretSchema,
	SENTRY_DSN: z.url().optional(),
	SIGHTENGINE_API_USER: optionalSecretSchema,
	SIGHTENGINE_API_SECRET: optionalSecretSchema,
	REPLICATE_API_TOKEN: optionalSecretSchema,
	FAL_API_KEY: optionalSecretSchema,
	KIE_API_KEY: optionalSecretSchema,
	GEMINI_API_KEY: optionalSecretSchema,
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
	errorMonitoringEnabled: boolean;
	mediaProviderAdapter: "replicate" | "fal" | "kie" | "gemini" | "mock";
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
	| { provider: "mock" };
export interface ServerSecrets {
	databaseUrl: string | undefined;
	storage: StorageSecrets;
	triggerSecretKey: string | undefined;
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

export function validateServerEnvironment(
	input: Record<string, unknown>,
	options: ValidateServerEnvironmentOptions = {},
): ServerEnvironment {
	const parsed = rawServerEnvironmentSchema.parse(input);
	const issues: string[] = [];
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
			requireValues(parsed, issues, [
				"DATABASE_URL",
				"S3_ENDPOINT",
				"S3_REGION",
				"MEDIA_BUCKET_NAME",
				"S3_ACCESS_KEY_ID",
				"S3_SECRET_ACCESS_KEY",
				"TRIGGER_SECRET_KEY",
			]);
			if (parseMediaEnabledProviders(parsed).length === 0) {
				issues.push("MEDIA_ENABLED_PROVIDERS");
			}
			if (options.requireProviderCredentials ?? true) {
				requireEnabledProviderCredentials(parsed, issues);
			}
		}

		if (parsed.BILLING_ENABLED) {
			requireValues(parsed, issues, ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
		}

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
			triggerSecretKey: parsed.TRIGGER_SECRET_KEY,
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
		if (!input[key]) {
			issues.push(String(key));
		}
	}
}
