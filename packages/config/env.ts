import { z } from "zod";

const booleanStringSchema = z
	.enum(["true", "false"])
	.default("false")
	.transform((value) => value === "true");

const optionalSecretSchema = z.string().min(1).optional();

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
	MEDIA_PROVIDER_ADAPTER: z.enum(["replicate", "fal", "kie", "gemini", "mock"]).default("mock"),
	MEDIA_SAFETY_ADAPTER: z.enum(["sightengine", "test"]).default("test"),
	MEDIA_ALLOW_TEST_SAFETY_ADAPTER: booleanStringSchema,
});

export interface ServerEnvironment {
	nodeEnv: "development" | "test" | "production";
	mediaGenerationEnabled: boolean;
	mediaModerationEnabled: boolean;
	billingEnabled: boolean;
	errorMonitoringEnabled: boolean;
	mediaProviderAdapter: "replicate" | "fal" | "kie" | "gemini" | "mock";
	mediaSafetyAdapter: "sightengine" | "test";
	allowTestSafetyAdapter: boolean;
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
	provider: ProviderSecrets;
}

export function validateServerEnvironment(input: Record<string, unknown>): ServerEnvironment {
	const parsed = rawServerEnvironmentSchema.parse(input);
	const issues: string[] = [];
	if (parsed.MEDIA_SAFETY_ADAPTER === "test" && !parsed.MEDIA_ALLOW_TEST_SAFETY_ADAPTER) {
		issues.push("MEDIA_ALLOW_TEST_SAFETY_ADAPTER");
	}

	if (parsed.NODE_ENV === "production") {
		if (parsed.MEDIA_PROVIDER_ADAPTER === "mock" || parsed.MEDIA_SAFETY_ADAPTER === "test") {
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
			requireSelectedProviderCredential(parsed, issues);
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
		mediaSafetyAdapter: parsed.MEDIA_SAFETY_ADAPTER,
		allowTestSafetyAdapter: parsed.MEDIA_ALLOW_TEST_SAFETY_ADAPTER,
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
			provider: selectedProviderSecrets(parsed),
		}),
	};
}

function requireSelectedProviderCredential(
	input: z.infer<typeof rawServerEnvironmentSchema>,
	issues: string[],
): void {
	const key = {
		replicate: "REPLICATE_API_TOKEN",
		fal: "FAL_API_KEY",
		kie: "KIE_API_KEY",
		gemini: "GEMINI_API_KEY",
		mock: null,
	}[input.MEDIA_PROVIDER_ADAPTER] as keyof typeof input | null;
	if (key && !input[key]) issues.push(String(key));
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
