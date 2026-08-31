import { createHash } from "node:crypto";

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
	maximumAcceptedTrialsPerSession: number;
	maximumActiveJobsPerDevice: number;
	maximumAcceptedTrialsPerDevicePromotion: number;
	maximumActiveJobsPerIp: number;
	maximumRequestsPerIpPerTenMinutes: number;
	maximumRequestsPerIpPerDay: number;
	maximumRequestsPerSubnetPerDay: number;
	maximumGlobalRequestsPerMinute: number;
	maximumGlobalRequestsPerHour: number;
	maximumGlobalRequestsPerDay: number;
	maximumOutstandingBootstraps: number;
	maximumTemporaryPrincipals: number;
	/** Compatibility aliases for the upload boundary while it migrates to the complete envelope. */
	maximumRequestsPerMinute: number;
	maximumRequestsPerIpPerHour: number;
	maximumGlobalQueueDepth: number;
}

export interface GuestMediaRuntimeOverrideRecord {
	enabled: true;
	version: number;
	createdAt: Date;
	abuseHmacKeyVersion: string | null;
	abuseHmacKeyIdentity: string | null;
}

export type GuestMediaRuntimeOverride = true | GuestMediaRuntimeOverrideRecord | null | undefined;

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
	abuseEvidenceTtlMs: number;
	bootstrapTtlMs: number;
	linkIntentTtlMs: number;
	resultGrantTtlMs: number;
	limits: GuestAdmissionLimits;
	riskBudgetMicros: bigint;
	abuseHmac: {
		keyVersion: string | null;
		keyIdentity: string | null;
		secretKey: string | null;
	};
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
	queueTtlMs: 10 * 60 * 1_000,
	abuseEvidenceTtlMs: 30 * 24 * 60 * 60 * 1_000,
	bootstrapTtlMs: 30 * 60 * 1_000,
	linkIntentTtlMs: 15 * 60 * 1_000,
	resultGrantTtlMs: 15 * 60 * 1_000,
	limits: Object.freeze({
		maximumActiveJobsPerGuest: 1,
		maximumAcceptedTrialsPerSession: 1,
		maximumActiveJobsPerDevice: 1,
		maximumAcceptedTrialsPerDevicePromotion: 1,
		maximumActiveJobsPerIp: 2,
		maximumRequestsPerIpPerTenMinutes: 1,
		maximumRequestsPerIpPerDay: 3,
		maximumRequestsPerSubnetPerDay: 20,
		maximumGlobalRequestsPerMinute: 3,
		maximumGlobalRequestsPerHour: 30,
		maximumGlobalRequestsPerDay: 100,
		maximumOutstandingBootstraps: 25,
		maximumTemporaryPrincipals: 100,
		maximumRequestsPerMinute: 3,
		maximumRequestsPerIpPerHour: 3,
		maximumGlobalQueueDepth: 25,
	}),
} as const;

export function getGuestMediaConfig(
	environment: Record<string, unknown>,
	runtimeOverride: unknown,
	now: Date = new Date(),
): GuestMediaConfig {
	const nodeEnvironment = stringValue(environment.NODE_ENV);
	const production = nodeEnvironment === "production";
	const promotionPeriod = normalizedPromotionPeriod(environment.GUEST_PROMOTION_PERIOD);
	const costEvidenceId = normalizedNonEmptyString(environment.GUEST_COST_EVIDENCE_ID);
	const hardBudgetMicros = positiveBigInt(environment.GUEST_HARD_BUDGET_MICROS);
	const configuredRiskBudgetMicros = positiveBigInt(environment.GUEST_RISK_BUDGET_MICROS);
	const riskBudgetMicros = configuredRiskBudgetMicros ?? BigInt(350_000);
	const siteKey = normalizedNonEmptyString(environment.NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY);
	const secretKey = normalizedNonEmptyString(environment.GUEST_TURNSTILE_SECRET_KEY);
	const proxyProvider = trustedProxyProvider(environment.MEDIA_TRUSTED_PROXY_PROVIDER);
	const abuseSecretKey = stringValue(environment.GUEST_ABUSE_HMAC_SECRET);
	const abuseKeyVersion = normalizedGuestAbuseHmacVersion(environment.GUEST_ABUSE_HMAC_VERSION);
	const abuseKeyIdentity = abuseSecretKey ? guestAbuseHmacKeyIdentity(abuseSecretKey) : null;
	const normalizedRuntimeOverride = normalizeRuntimeOverride(runtimeOverride);
	const productionControlsRequired =
		production && !isLocalProductionBuildE2EEnvironment(environment);
	const productionEnvelope = productionControlsRequired
		? readProductionGuestEnvelope(environment)
		: null;

	let reason: GuestMediaDisabledReason | null = null;
	if (
		nodeEnvironment !== "development" &&
		nodeEnvironment !== "test" &&
		nodeEnvironment !== "production"
	) {
		reason = "GUEST_ENVIRONMENT_INVALID";
	} else if (environment.GUEST_MEDIA_ENABLED !== "true") {
		reason = "GUEST_ENVIRONMENT_DISABLED";
	} else if (!normalizedRuntimeOverride.enabled) {
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
	} else if (
		productionControlsRequired &&
		(configuredRiskBudgetMicros === null || configuredRiskBudgetMicros > BigInt(350_000))
	) {
		reason = "GUEST_CONFIGURATION_INVALID";
	} else if (productionControlsRequired && productionEnvelope === null) {
		reason = "GUEST_CONFIGURATION_INVALID";
	} else if (
		productionControlsRequired &&
		(!abuseSecretKey ||
			abuseSecretKey.length < 32 ||
			!abuseKeyVersion ||
			!productionEnvelope ||
			!productionAbuseOverrideReady({
				override: normalizedRuntimeOverride.record,
				keyVersion: abuseKeyVersion,
				keyIdentity: abuseKeyIdentity,
				evidenceTtlMs: productionEnvelope.abuseEvidenceTtlMs,
				now,
			}))
	) {
		reason = "GUEST_CONFIGURATION_INVALID";
	}
	const queueTtlMs = productionEnvelope?.queueTtlMs ?? FIXED_GUEST_MEDIA_CONFIG.queueTtlMs;
	const abuseEvidenceTtlMs =
		productionEnvelope?.abuseEvidenceTtlMs ?? FIXED_GUEST_MEDIA_CONFIG.abuseEvidenceTtlMs;
	const limits = Object.freeze(productionEnvelope?.limits ?? FIXED_GUEST_MEDIA_CONFIG.limits);

	return Object.freeze({
		enabled: reason === null,
		reason,
		promotionPeriod,
		...FIXED_GUEST_MEDIA_CONFIG,
		queueTtlMs,
		abuseEvidenceTtlMs,
		limits,
		riskBudgetMicros,
		abuseHmac: Object.freeze({
			keyVersion: abuseKeyVersion,
			keyIdentity: abuseKeyIdentity,
			secretKey: abuseSecretKey,
		}),
		productionEvidence: Object.freeze({ costEvidenceId, hardBudgetMicros }),
		turnstile: Object.freeze({ required: productionControlsRequired, siteKey, secretKey }),
		trustedProxyPolicy: Object.freeze({
			provider: proxyProvider,
			required: productionControlsRequired,
		}),
	});
}

export function guestAbuseHmacKeyIdentity(secret: string): string {
	return createHash("sha256").update(`guest-abuse-hmac-key\0${secret}`, "utf8").digest("hex");
}

function normalizeRuntimeOverride(runtimeOverride: unknown): {
	enabled: boolean;
	record: GuestMediaRuntimeOverrideRecord | null;
} {
	if (runtimeOverride === true) return { enabled: true, record: null };
	if (!runtimeOverride || typeof runtimeOverride !== "object") {
		return { enabled: false, record: null };
	}
	const candidate = runtimeOverride as Partial<GuestMediaRuntimeOverrideRecord>;
	if (
		candidate.enabled !== true ||
		!Number.isSafeInteger(candidate.version) ||
		(candidate.version ?? -1) < 0 ||
		!(candidate.createdAt instanceof Date) ||
		!Number.isFinite(candidate.createdAt.getTime()) ||
		!(
			candidate.abuseHmacKeyVersion === null || typeof candidate.abuseHmacKeyVersion === "string"
		) ||
		!(candidate.abuseHmacKeyIdentity === null || typeof candidate.abuseHmacKeyIdentity === "string")
	) {
		return { enabled: false, record: null };
	}
	return { enabled: true, record: candidate as GuestMediaRuntimeOverrideRecord };
}

function productionAbuseOverrideReady(input: {
	override: GuestMediaRuntimeOverrideRecord | null;
	keyVersion: string;
	keyIdentity: string | null;
	evidenceTtlMs: number;
	now: Date;
}): boolean {
	return Boolean(
		input.override &&
		input.keyIdentity &&
		input.override.abuseHmacKeyVersion === input.keyVersion &&
		input.override.abuseHmacKeyIdentity === input.keyIdentity &&
		input.now.getTime() - input.override.createdAt.getTime() >= input.evidenceTtlMs,
	);
}

function readProductionGuestEnvelope(environment: Record<string, unknown>): {
	queueTtlMs: number;
	abuseEvidenceTtlMs: number;
	limits: GuestAdmissionLimits;
} | null {
	const queueTtlSeconds = positiveInteger(environment.GUEST_QUEUE_TTL_SECONDS);
	const abuseEvidenceTtlDays = positiveInteger(environment.GUEST_ABUSE_EVIDENCE_TTL_DAYS);
	const configured = {
		maximumActiveJobsPerGuest: positiveInteger(environment.GUEST_SESSION_MAX_ACTIVE_JOBS),
		maximumAcceptedTrialsPerSession: positiveInteger(environment.GUEST_SESSION_MAX_ACCEPTED_TRIALS),
		maximumActiveJobsPerDevice: positiveInteger(environment.GUEST_DEVICE_MAX_ACTIVE_JOBS),
		maximumAcceptedTrialsPerDevicePromotion: positiveInteger(
			environment.GUEST_DEVICE_MAX_ACCEPTED_PER_PROMOTION,
		),
		maximumActiveJobsPerIp: positiveInteger(environment.GUEST_IP_MAX_ACTIVE_JOBS),
		maximumRequestsPerIpPerTenMinutes: positiveInteger(environment.GUEST_IP_MAX_PER_10_MINUTES),
		maximumRequestsPerIpPerDay: positiveInteger(environment.GUEST_IP_MAX_PER_24_HOURS),
		maximumRequestsPerSubnetPerDay: positiveInteger(environment.GUEST_SUBNET_MAX_PER_24_HOURS),
		maximumGlobalRequestsPerMinute: positiveInteger(environment.GUEST_GLOBAL_MAX_PER_MINUTE),
		maximumGlobalRequestsPerHour: positiveInteger(environment.GUEST_GLOBAL_MAX_PER_HOUR),
		maximumGlobalRequestsPerDay: positiveInteger(environment.GUEST_GLOBAL_MAX_PER_24_HOURS),
		maximumGlobalQueueDepth: positiveInteger(environment.GUEST_QUEUE_MAX_DEPTH),
		maximumOutstandingBootstraps: positiveInteger(environment.GUEST_BOOTSTRAP_MAX_OUTSTANDING),
		maximumTemporaryPrincipals: positiveInteger(environment.GUEST_TEMPORARY_PRINCIPAL_MAX_TOTAL),
	};
	if (
		queueTtlSeconds === null ||
		abuseEvidenceTtlDays === null ||
		Object.values(configured).some((value) => value === null)
	) {
		return null;
	}
	const completeLimits = configured as Record<keyof typeof configured, number>;
	if (
		queueTtlSeconds > 600 ||
		abuseEvidenceTtlDays !== 30 ||
		completeLimits.maximumActiveJobsPerGuest > 1 ||
		completeLimits.maximumAcceptedTrialsPerSession > 1 ||
		completeLimits.maximumActiveJobsPerDevice > 1 ||
		completeLimits.maximumAcceptedTrialsPerDevicePromotion > 1 ||
		completeLimits.maximumActiveJobsPerIp > 2 ||
		completeLimits.maximumRequestsPerIpPerTenMinutes > 1 ||
		completeLimits.maximumRequestsPerIpPerDay > 3 ||
		completeLimits.maximumRequestsPerSubnetPerDay > 20 ||
		completeLimits.maximumGlobalRequestsPerMinute > 3 ||
		completeLimits.maximumGlobalRequestsPerHour > 30 ||
		completeLimits.maximumGlobalRequestsPerDay > 100 ||
		completeLimits.maximumGlobalQueueDepth > 25 ||
		completeLimits.maximumOutstandingBootstraps > 25 ||
		completeLimits.maximumTemporaryPrincipals > 100
	) {
		return null;
	}
	return {
		queueTtlMs: queueTtlSeconds * 1_000,
		abuseEvidenceTtlMs: abuseEvidenceTtlDays * 24 * 60 * 60 * 1_000,
		limits: {
			...completeLimits,
			maximumRequestsPerMinute: completeLimits.maximumGlobalRequestsPerMinute,
			maximumRequestsPerIpPerHour: Math.min(
				completeLimits.maximumRequestsPerIpPerDay,
				completeLimits.maximumRequestsPerSubnetPerDay,
			),
		} as GuestAdmissionLimits,
	};
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
			saas.origin === marketing.origin
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

function normalizedGuestAbuseHmacVersion(value: unknown): string | null {
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

function positiveInteger(value: unknown): number | null {
	const candidate = normalizedNonEmptyString(value);
	if (!candidate || !/^[1-9][0-9]*$/.test(candidate)) return null;
	const parsed = Number(candidate);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function trustedProxyProvider(value: unknown): "none" | "vercel" | "cloudflare" {
	const candidate = normalizedNonEmptyString(value)?.toLowerCase();
	return candidate === "vercel" || candidate === "cloudflare" ? candidate : "none";
}
