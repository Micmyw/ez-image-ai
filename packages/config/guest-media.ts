export const GUEST_MEDIA_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type GuestMediaDisabledReason =
	| "GUEST_ENVIRONMENT_INVALID"
	| "GUEST_ENVIRONMENT_DISABLED"
	| "GUEST_RUNTIME_DISABLED"
	| "GUEST_PROMOTION_PERIOD_REQUIRED"
	| "GUEST_CONFIGURATION_INVALID"
	| "GUEST_PRODUCTION_EVIDENCE_REQUIRED"
	| "GUEST_PRODUCTION_TURNSTILE_REQUIRED"
	| "GUEST_PRODUCTION_TRUSTED_PROXY_REQUIRED";

export interface GuestAdmissionLimits {
	maximumActiveJobsPerGuest: number;
	maximumRequestsPerMinute: number;
	maximumRequestsPerIpPerHour: number;
	maximumGlobalQueueDepth: number;
}

export type GuestMediaRuntimeOverride = boolean | null | undefined;

export interface GuestMediaConfig {
	enabled: boolean;
	reason: GuestMediaDisabledReason | null;
	promotionPeriod: string | null;
	productKey: "image-fast";
	sponsorCredits: bigint;
	maximumBytes: number;
	mimeTypes: typeof GUEST_MEDIA_MIME_TYPES;
	retentionMs: number;
	queueTtlMs: number;
	bootstrapTtlMs: number;
	linkIntentTtlMs: number;
	resultGrantTtlMs: number;
	limits: GuestAdmissionLimits;
	riskBudgetMicros: bigint;
	productionEvidence: {
		costEvidenceId: string | null;
		hardBudgetMicros: bigint | null;
	};
	turnstile: {
		required: boolean;
		siteKey: string | null;
		secretKey: string | null;
	};
	trustedProxyPolicy: {
		provider: "none" | "vercel" | "cloudflare";
		required: boolean;
	};
}

const FIXED_GUEST_MEDIA_CONFIG = {
	productKey: "image-fast",
	sponsorCredits: BigInt(4),
	maximumBytes: 10 * 1024 * 1024,
	mimeTypes: GUEST_MEDIA_MIME_TYPES,
	retentionMs: 24 * 60 * 60 * 1_000,
	queueTtlMs: 15 * 60 * 1_000,
	bootstrapTtlMs: 30 * 60 * 1_000,
	linkIntentTtlMs: 15 * 60 * 1_000,
	resultGrantTtlMs: 15 * 60 * 1_000,
	limits: Object.freeze({
		maximumActiveJobsPerGuest: 1,
		maximumRequestsPerMinute: 3,
		maximumRequestsPerIpPerHour: 12,
		maximumGlobalQueueDepth: 100,
	}),
} as const;

export function getGuestMediaConfig(
	environment: Record<string, unknown>,
	runtimeOverride: unknown,
): GuestMediaConfig {
	const nodeEnvironment = stringValue(environment.NODE_ENV);
	const production = nodeEnvironment === "production";
	const promotionPeriod = normalizedPromotionPeriod(environment.GUEST_PROMOTION_PERIOD);
	const costEvidenceId = normalizedNonEmptyString(environment.GUEST_COST_EVIDENCE_ID);
	const hardBudgetMicros = positiveBigInt(environment.GUEST_HARD_BUDGET_MICROS);
	const riskBudgetMicros = positiveBigInt(environment.GUEST_RISK_BUDGET_MICROS) ?? BigInt(250_000);
	const siteKey = normalizedNonEmptyString(environment.NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY);
	const secretKey = normalizedNonEmptyString(environment.GUEST_TURNSTILE_SECRET_KEY);
	const proxyProvider = trustedProxyProvider(environment.MEDIA_TRUSTED_PROXY_PROVIDER);
	const productionControlsRequired =
		production && !isLocalProductionBuildE2EEnvironment(environment);

	let reason: GuestMediaDisabledReason | null = null;
	if (
		nodeEnvironment !== "development" &&
		nodeEnvironment !== "test" &&
		nodeEnvironment !== "production"
	) {
		reason = "GUEST_ENVIRONMENT_INVALID";
	} else if (environment.GUEST_MEDIA_ENABLED !== "true") {
		reason = "GUEST_ENVIRONMENT_DISABLED";
	} else if (runtimeOverride !== true) {
		reason = "GUEST_RUNTIME_DISABLED";
	} else if (!promotionPeriod) {
		reason = "GUEST_PROMOTION_PERIOD_REQUIRED";
	} else if (environment.GUEST_HARD_BUDGET_MICROS !== undefined && hardBudgetMicros === null) {
		reason = "GUEST_CONFIGURATION_INVALID";
	} else if (productionControlsRequired && (!costEvidenceId || hardBudgetMicros === null)) {
		reason = "GUEST_PRODUCTION_EVIDENCE_REQUIRED";
	} else if (productionControlsRequired && (!siteKey || !secretKey)) {
		reason = "GUEST_PRODUCTION_TURNSTILE_REQUIRED";
	} else if (productionControlsRequired && proxyProvider === "none") {
		reason = "GUEST_PRODUCTION_TRUSTED_PROXY_REQUIRED";
	}

	return Object.freeze({
		enabled: reason === null,
		reason,
		promotionPeriod,
		...FIXED_GUEST_MEDIA_CONFIG,
		riskBudgetMicros,
		productionEvidence: Object.freeze({ costEvidenceId, hardBudgetMicros }),
		turnstile: Object.freeze({ required: productionControlsRequired, siteKey, secretKey }),
		trustedProxyPolicy: Object.freeze({
			provider: proxyProvider,
			required: productionControlsRequired,
		}),
	});
}

export function isLocalProductionBuildE2EEnvironment(
	environment: Record<string, unknown>,
): boolean {
	const databaseUrl = normalizedNonEmptyString(environment.DATABASE_URL);
	const testDatabaseUrl = normalizedNonEmptyString(environment.TEST_DATABASE_URL);
	const runId = normalizedNonEmptyString(environment.E2E_RUN_ID);
	if (
		environment.NODE_ENV !== "production" ||
		environment.E2E_USE_PRODUCTION_BUILD !== "true" ||
		environment.E2E_TEST_MEDIA_ADAPTERS !== "true" ||
		environment.MEDIA_PROVIDER_ADAPTER !== "mock" ||
		environment.MEDIA_SAFETY_ADAPTER !== "test" ||
		environment.MEDIA_ALLOW_TEST_SAFETY_ADAPTER !== "true" ||
		!runId ||
		!/^[a-z0-9-]{6,48}$/i.test(runId) ||
		!databaseUrl ||
		!testDatabaseUrl ||
		databaseUrl !== testDatabaseUrl
	) {
		return false;
	}
	try {
		const database = new URL(databaseUrl);
		const saas = new URL(normalizedNonEmptyString(environment.NEXT_PUBLIC_SAAS_URL) ?? "");
		const marketing = new URL(
			normalizedNonEmptyString(environment.NEXT_PUBLIC_MARKETING_URL) ?? "",
		);
		return (
			isLoopbackHost(database.hostname) &&
			/test|testing/i.test(database.pathname) &&
			isLocalHttpOrigin(saas) &&
			isLocalHttpOrigin(marketing) &&
			saas.origin !== marketing.origin
		);
	} catch {
		return false;
	}
}

function isLocalHttpOrigin(url: URL): boolean {
	return (
		url.protocol === "http:" &&
		isLoopbackHost(url.hostname) &&
		url.pathname === "/" &&
		!url.username &&
		!url.password &&
		!url.search &&
		!url.hash
	);
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function normalizedPromotionPeriod(value: unknown): string | null {
	const candidate = normalizedNonEmptyString(value);
	return candidate && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(candidate) ? candidate : null;
}

function normalizedNonEmptyString(value: unknown): string | null {
	const candidate = stringValue(value)?.trim();
	return candidate ? candidate : null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function positiveBigInt(value: unknown): bigint | null {
	const candidate = normalizedNonEmptyString(value);
	if (!candidate || !/^[1-9][0-9]*$/.test(candidate)) return null;
	try {
		return BigInt(candidate);
	} catch {
		return null;
	}
}

function trustedProxyProvider(value: unknown): "none" | "vercel" | "cloudflare" {
	const candidate = normalizedNonEmptyString(value)?.toLowerCase();
	return candidate === "vercel" || candidate === "cloudflare" ? candidate : "none";
}
