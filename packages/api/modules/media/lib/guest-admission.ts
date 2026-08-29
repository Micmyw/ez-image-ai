import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	type MediaModelInput,
	type ModerationDecision,
} from "@repo/ai";
import {
	createGuestGenerationTransaction,
	fingerprintGenerationQuoteSecurityPayload,
	type CreateGuestGenerationTransactionInput,
	type CreateGuestGenerationTransactionResult,
	type GuestAdmissionDenialReason,
	type GuestJobSnapshot,
	recordGuestAdmissionDenial,
} from "@repo/database";
import { db } from "@repo/database/client";

import { trustedGuestClientIdentity } from "./draft-client-identity";
import {
	assertGuestCapabilityVersion,
	hashGuestAbuseBinding,
	loadGuestCapability,
	requireGuestAbuseHmac,
} from "./guest-capability";
import { buildMediaQuote } from "./quote";
import {
	createTextModerationAdapter,
	TEXT_MODERATION_RULE_VERSION,
	type TextModerationEvidence,
} from "./text-moderation";
import {
	cloudflareTurnstileVerifier,
	verifyGuestTurnstileEvidence,
	type VerifiedGuestTurnstileToken,
} from "./turnstile";

const GUEST_ESTIMATED_SERVICE_TIME_MS = 60_000;
const GUEST_QUEUE_CAPACITY = 1;
const GUEST_QUOTE_TTL_MS = 10 * 60_000;

export interface GuestAdmissionBoundary {
	ownerId: string;
	sessionId: string;
	origin: string | null;
	headers: Headers;
}

export interface SubmitGuestGenerationInput {
	capabilityVersion: string;
	sourceAssetId: string;
	prompt: string;
	idempotencyKey: string;
	deviceId: string;
	turnstileToken: string;
}

interface GuestSourceAsset {
	id: string;
	ownerType: string;
	ownerId: string;
	kind: string;
	status: string;
	retentionClass: string;
	deleteAfter: Date | null;
	mimeType: string;
	byteSize: bigint;
	checksum: string | null;
	verificationValidUntil: Date | null;
}

interface GuestSourceBootstrap {
	id: string;
	claimedDraftId: string | null;
	sourceAssetId: string | null;
}

interface GuestQuote {
	productKey: string;
	catalogVersion: string;
	pricingVersion: string;
	credits: bigint;
	costMicros: bigint;
	pricingSnapshot: unknown;
}

interface GuestAdmissionConfig {
	enabled: boolean;
	promotionPeriod: string | null;
	productKey: string;
	sponsorCredits: bigint;
	maximumBytes: number;
	mimeTypes: readonly string[];
	retentionMs: number;
	queueTtlMs: number;
	abuseEvidenceTtlMs: number;
	limits: {
		maximumActiveJobsPerGuest: number;
		maximumAcceptedTrialsPerSession?: number;
		maximumActiveJobsPerDevice?: number;
		maximumAcceptedTrialsPerDevicePromotion?: number;
		maximumActiveJobsPerIp?: number;
		maximumRequestsPerIpPerTenMinutes?: number;
		maximumRequestsPerIpPerDay?: number;
		maximumRequestsPerSubnetPerDay?: number;
		maximumGlobalRequestsPerMinute?: number;
		maximumGlobalRequestsPerHour?: number;
		maximumGlobalRequestsPerDay?: number;
		maximumRequestsPerMinute: number;
		maximumRequestsPerIpPerHour: number;
		maximumGlobalQueueDepth: number;
	};
	riskBudgetMicros: bigint;
	abuseHmac: {
		keyVersion: string | null;
		secretKey: string | null;
	};
	turnstile: { required: boolean; secretKey: string | null };
}

interface GuestAdmissionDependencies {
	now(): Date;
	saasOrigin: string;
	loadCapability(): Promise<{
		snapshot: { version: string };
		config: GuestAdmissionConfig;
	}>;
	resolveIdentity(headers: Headers): { ip: string; subnet: string } | null;
	verifyTurnstile(input: {
		token: string;
		hostname: string;
		clientIp: string;
		now: Date;
		config: GuestAdmissionConfig;
	}): Promise<VerifiedGuestTurnstileToken>;
	loadSourceAsset(assetId: string, ownerId: string): Promise<GuestSourceAsset | null>;
	loadSourceBootstrap(input: {
		ownerId: string;
		promotionPeriod: string;
		sourceAssetId: string;
		now: Date;
	}): Promise<GuestSourceBootstrap | null>;
	buildQuote(input: {
		productKey: "image-fast";
		input: { kind: "image-to-image"; prompt: string; sourceAssetId: string };
	}): GuestQuote;
	moderatePrompt(input: { text: string; ruleVersion: string }): Promise<ModerationDecision>;
	moderationProvider?: TextModerationEvidence["provider"];
	transactionRecordsDenials?: boolean;
	recordDenial(input: {
		promotionPeriod: string;
		reason: GuestAdmissionDenialReason;
		subjectHash: string;
		now: Date;
		evidenceTtlMs: number;
	}): Promise<void>;
	createTransaction(
		input: CreateGuestGenerationTransactionInput,
	): Promise<CreateGuestGenerationTransactionResult>;
}

export const guestAdmissionDependencies: GuestAdmissionDependencies = {
	now: () => new Date(),
	saasOrigin: process.env.NEXT_PUBLIC_SAAS_URL ?? "",
	loadCapability: () => loadGuestCapability(),
	resolveIdentity: (headers) => trustedGuestClientIdentity(headers, process.env),
	verifyTurnstile: async ({ token, hostname, clientIp, now, config }) => {
		const verify = config.turnstile.required
			? cloudflareTurnstileVerifier(requiredSecret(config.turnstile.secretKey))
			: async () => ({
					success: true,
					hostname,
					action: "guest_generate" as const,
					challengeTimestamp: now.toISOString(),
				});
		return verifyGuestTurnstileEvidence(
			{ token, action: "guest_generate", hostname, clientIp, now },
			{ verify },
		);
	},
	loadSourceAsset: (assetId, ownerId) =>
		db.mediaAsset.findFirst({
			where: { id: assetId, ownerType: "USER", ownerId },
			select: {
				id: true,
				ownerType: true,
				ownerId: true,
				kind: true,
				status: true,
				retentionClass: true,
				deleteAfter: true,
				mimeType: true,
				byteSize: true,
				checksum: true,
				verificationValidUntil: true,
			},
		}),
	loadSourceBootstrap: ({ ownerId, promotionPeriod, sourceAssetId, now }) =>
		db.guestSessionBootstrap.findFirst({
			where: {
				ownerId,
				promotionPeriod,
				sourceAssetId,
				completedAt: { not: null },
				expiresAt: { gt: now },
			},
			select: { id: true, claimedDraftId: true, sourceAssetId: true },
		}),
	buildQuote: (input) => buildMediaQuote(input),
	moderatePrompt: async (input) => {
		const selection = createTextModerationAdapter(process.env);
		return selection.adapter.moderateText(input);
	},
	moderationProvider: undefined,
	transactionRecordsDenials: true,
	recordDenial: (input) => recordGuestAdmissionDenial(input, db),
	createTransaction: (input) =>
		createGuestGenerationTransaction(input, db, ({ productKey, inputSnapshot }) =>
			buildMediaQuote({ productKey, input: inputSnapshot as MediaModelInput }),
		),
};

export async function submitGuestGenerationForGuest(
	boundary: GuestAdmissionBoundary,
	input: SubmitGuestGenerationInput,
	dependencySelection: GuestAdmissionDependencies | "default" = "default",
): Promise<GuestJobSnapshot> {
	const dependencies =
		dependencySelection === "default" ? guestAdmissionDependencies : dependencySelection;
	const now = dependencies.now();
	assertExactOrigin(boundary.origin, dependencies.saasOrigin);
	const identity = dependencies.resolveIdentity(boundary.headers);
	if (!identity) throw new Error("GUEST_TRUSTED_CLIENT_REQUIRED");
	if (!isRandomDeviceId(input.deviceId)) throw new Error("GUEST_DEVICE_INVALID");

	const loaded = await dependencies.loadCapability();
	const abuseHmac = requireGuestAbuseHmac(loaded.config);
	if (!loaded.config.enabled || !loaded.config.promotionPeriod) {
		return rejectGuestAdmission(
			dependencies,
			boundary,
			input,
			abuseHmac,
			loaded.config.promotionPeriod,
			loaded.config.abuseEvidenceTtlMs,
			now,
			"CAPABILITY",
			new Error("GUEST_CAPABILITY_DISABLED"),
		);
	}
	try {
		assertGuestCapabilityVersion(input.capabilityVersion, loaded.snapshot.version);
	} catch (error) {
		return rejectGuestAdmission(
			dependencies,
			boundary,
			input,
			abuseHmac,
			loaded.config.promotionPeriod,
			loaded.config.abuseEvidenceTtlMs,
			now,
			"CAPABILITY",
			error,
		);
	}
	let verifiedTurnstile: VerifiedGuestTurnstileToken;
	try {
		verifiedTurnstile = await dependencies.verifyTurnstile({
			token: input.turnstileToken,
			hostname: new URL(dependencies.saasOrigin).hostname,
			clientIp: identity.ip,
			now,
			config: loaded.config,
		});
	} catch (error) {
		return rejectGuestAdmission(
			dependencies,
			boundary,
			input,
			abuseHmac,
			loaded.config.promotionPeriod,
			loaded.config.abuseEvidenceTtlMs,
			now,
			"TURNSTILE",
			error,
		);
	}

	const source = await dependencies.loadSourceAsset(input.sourceAssetId, boundary.ownerId);
	if (!isEligibleGuestSource(source, boundary.ownerId, loaded.config, now)) {
		return rejectGuestAdmission(
			dependencies,
			boundary,
			input,
			abuseHmac,
			loaded.config.promotionPeriod,
			loaded.config.abuseEvidenceTtlMs,
			now,
			"INPUT",
			new Error("GUEST_INPUT_UNAVAILABLE"),
		);
	}
	const bootstrap = await dependencies.loadSourceBootstrap({
		ownerId: boundary.ownerId,
		promotionPeriod: loaded.config.promotionPeriod,
		sourceAssetId: source.id,
		now,
	});
	if (!bootstrap?.claimedDraftId || bootstrap.sourceAssetId !== source.id) {
		return rejectGuestAdmission(
			dependencies,
			boundary,
			input,
			abuseHmac,
			loaded.config.promotionPeriod,
			loaded.config.abuseEvidenceTtlMs,
			now,
			"INPUT",
			new Error("GUEST_INPUT_UNAVAILABLE"),
		);
	}

	const modelInput = {
		kind: "image-to-image" as const,
		prompt: input.prompt.trim(),
		sourceAssetId: source.id,
	};
	const quote = dependencies.buildQuote({ productKey: "image-fast", input: modelInput });
	if (
		quote.productKey !== loaded.config.productKey ||
		quote.credits !== loaded.config.sponsorCredits ||
		quote.credits !== 4n ||
		quote.costMicros <= 0n
	) {
		return rejectGuestAdmission(
			dependencies,
			boundary,
			input,
			abuseHmac,
			loaded.config.promotionPeriod,
			loaded.config.abuseEvidenceTtlMs,
			now,
			"QUOTE",
			new Error("GUEST_PRICE_CHANGED"),
		);
	}
	const quoteBase = {
		ownerType: "USER" as const,
		ownerId: boundary.ownerId,
		submittedByUserId: boundary.ownerId,
		productKey: "image-fast",
		catalogVersion: quote.catalogVersion,
		pricingVersion: quote.pricingVersion,
		credits: quote.credits,
		costMicros: quote.costMicros,
		inputSnapshot: modelInput,
		pricingSnapshot:
			quote.pricingSnapshot as CreateGuestGenerationTransactionInput["quote"]["pricingSnapshot"],
		expiresAt: new Date(now.getTime() + GUEST_QUOTE_TTL_MS),
	};
	const moderation = await dependencies.moderatePrompt({
		text: modelInput.prompt,
		ruleVersion: TEXT_MODERATION_RULE_VERSION,
	});
	if (moderation.decision !== "ALLOW") {
		return rejectGuestAdmission(
			dependencies,
			boundary,
			input,
			abuseHmac,
			loaded.config.promotionPeriod,
			loaded.config.abuseEvidenceTtlMs,
			now,
			"CONTENT",
			new Error(`TEXT_MODERATION_${moderation.decision}`),
		);
	}
	const moderationProvider =
		dependencies.moderationProvider ??
		(process.env.MEDIA_SAFETY_ADAPTER === "sightengine" ? "sightengine" : "test");
	const sourceSessionHash = hashGuestAbuseBinding(
		abuseHmac.secretKey,
		abuseHmac.keyVersion,
		"guest-source-session",
		boundary.sessionId,
	);
	const deviceHash = hashGuestAbuseBinding(
		abuseHmac.secretKey,
		abuseHmac.keyVersion,
		"guest-device",
		input.deviceId,
	);
	const idempotencyFingerprint = hashGuestAbuseBinding(
		abuseHmac.secretKey,
		abuseHmac.keyVersion,
		"guest-admission-idempotency",
		[
			boundary.ownerId,
			input.idempotencyKey,
			source.id,
			source.checksum,
			modelInput.prompt,
			quote.catalogVersion,
			quote.pricingVersion,
		].join("\n"),
	);
	const transactionInput = {
		ownerId: boundary.ownerId,
		promotionPeriod: loaded.config.promotionPeriod,
		capabilityVersion: loaded.snapshot.version,
		sourceSessionHash,
		deviceHash,
		ipHash: hashGuestAbuseBinding(
			abuseHmac.secretKey,
			abuseHmac.keyVersion,
			"guest-ip",
			identity.ip,
		),
		subnetHash: hashGuestAbuseBinding(
			abuseHmac.secretKey,
			abuseHmac.keyVersion,
			"guest-subnet",
			identity.subnet,
		),
		idempotencyKey: input.idempotencyKey,
		idempotencyFingerprint,
		turnstile: verifiedTurnstile,
		sourceDraftId: bootstrap.claimedDraftId,
		sourceBootstrapId: bootstrap.id,
		sourceAssetId: source.id,
		sourceAssetChecksum: source.checksum,
		now,
		retentionMs: loaded.config.retentionMs,
		queueTtlMs: loaded.config.queueTtlMs,
		serviceTimeMs: GUEST_ESTIMATED_SERVICE_TIME_MS,
		queueCapacity: GUEST_QUEUE_CAPACITY,
		maximumBytes: loaded.config.maximumBytes,
		maximumGlobalQueueDepth: loaded.config.limits.maximumGlobalQueueDepth,
		maximumActiveJobsPerGuest: loaded.config.limits.maximumActiveJobsPerGuest,
		maximumRequestsPerMinute: loaded.config.limits.maximumRequestsPerMinute,
		maximumRequestsPerIpPerHour: loaded.config.limits.maximumRequestsPerIpPerHour,
		maximumAcceptedTrialsPerSession: loaded.config.limits.maximumAcceptedTrialsPerSession,
		maximumActiveJobsPerDevice: loaded.config.limits.maximumActiveJobsPerDevice,
		maximumAcceptedTrialsPerDevicePromotion:
			loaded.config.limits.maximumAcceptedTrialsPerDevicePromotion,
		maximumActiveJobsPerIp: loaded.config.limits.maximumActiveJobsPerIp,
		maximumRequestsPerIpPerTenMinutes: loaded.config.limits.maximumRequestsPerIpPerTenMinutes,
		maximumRequestsPerIpPerDay: loaded.config.limits.maximumRequestsPerIpPerDay,
		maximumRequestsPerSubnetPerDay: loaded.config.limits.maximumRequestsPerSubnetPerDay,
		maximumGlobalRequestsPerMinute: loaded.config.limits.maximumGlobalRequestsPerMinute,
		maximumGlobalRequestsPerHour: loaded.config.limits.maximumGlobalRequestsPerHour,
		maximumGlobalRequestsPerDay: loaded.config.limits.maximumGlobalRequestsPerDay,
		abuseEvidenceTtlMs: loaded.config.abuseEvidenceTtlMs,
		riskBudgetMicros: loaded.config.riskBudgetMicros,
		sponsorCredits: loaded.config.sponsorCredits,
		assetModeration: {
			provider: process.env.MEDIA_SAFETY_ADAPTER ?? "test",
			ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		},
		quote: {
			...quoteBase,
			moderation: {
				...moderation,
				provider: moderationProvider,
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteBase),
			},
		},
	} satisfies CreateGuestGenerationTransactionInput;
	try {
		return await dependencies.createTransaction(transactionInput);
	} catch (error) {
		const reason = transactionDenialReason(error);
		if (!reason) throw error;
		if (dependencies.transactionRecordsDenials === true) throw error;
		return rejectGuestAdmission(
			dependencies,
			boundary,
			input,
			abuseHmac,
			loaded.config.promotionPeriod,
			loaded.config.abuseEvidenceTtlMs,
			now,
			reason,
			error,
		);
	}
}

async function rejectGuestAdmission(
	dependencies: GuestAdmissionDependencies,
	boundary: GuestAdmissionBoundary,
	input: SubmitGuestGenerationInput,
	abuseHmac: { secretKey: string; keyVersion: string },
	promotionPeriod: string | null,
	evidenceTtlMs: number,
	now: Date,
	reason: GuestAdmissionDenialReason,
	error: unknown,
): Promise<never> {
	if (promotionPeriod) {
		const subjectHash = hashGuestAbuseBinding(
			abuseHmac.secretKey,
			abuseHmac.keyVersion,
			"guest-denial-idempotency",
			`${boundary.ownerId}\n${input.idempotencyKey}`,
		);
		await dependencies
			.recordDenial({ promotionPeriod, reason, subjectHash, now, evidenceTtlMs })
			.catch(() => undefined);
	}
	throw error instanceof Error ? error : new Error("GUEST_ADMISSION_REJECTED");
}

function transactionDenialReason(error: unknown): GuestAdmissionDenialReason | null {
	if (!(error instanceof Error)) return null;
	const reasonByCode: Partial<Record<string, GuestAdmissionDenialReason>> = {
		GUEST_DEVICE_LIMIT: "DEVICE_LIMIT",
		GUEST_GLOBAL_RATE_LIMIT: "GLOBAL_RATE_LIMIT",
		GUEST_INPUT_UNAVAILABLE: "INPUT",
		GUEST_IP_RATE_LIMIT: "IP_RATE_LIMIT",
		GUEST_LINK_IN_PROGRESS: "TRIAL_UNAVAILABLE",
		GUEST_OWNER_CAPACITY: "OWNER_CAPACITY",
		GUEST_PRICE_CHANGED: "QUOTE",
		GUEST_QUEUE_CAPACITY: "QUEUE_CAPACITY",
		GUEST_RISK_CAPACITY: "RISK_CAPACITY",
		GUEST_SUBNET_RATE_LIMIT: "SUBNET_RATE_LIMIT",
		GUEST_TRIAL_UNAVAILABLE: "TRIAL_UNAVAILABLE",
		TURNSTILE_REPLAYED: "TURNSTILE_REPLAY",
	};
	return reasonByCode[error.message] ?? null;
}

function isEligibleGuestSource(
	source: GuestSourceAsset | null,
	ownerId: string,
	config: GuestAdmissionConfig,
	now: Date,
): source is GuestSourceAsset & { checksum: string } {
	return Boolean(
		source &&
		source.ownerType === "USER" &&
		source.ownerId === ownerId &&
		source.kind === "INPUT" &&
		source.status === "READY" &&
		source.retentionClass === "GUEST_TRIAL" &&
		source.deleteAfter &&
		source.deleteAfter > now &&
		source.verificationValidUntil &&
		source.verificationValidUntil > now &&
		source.byteSize <= BigInt(config.maximumBytes) &&
		config.mimeTypes.includes(source.mimeType as (typeof config.mimeTypes)[number]) &&
		source.checksum &&
		/^[a-f0-9]{64}$/.test(source.checksum),
	);
}

function assertExactOrigin(actualValue: string | null, expectedValue: string): void {
	let actual: URL;
	let expected: URL;
	try {
		if (!actualValue || !expectedValue) throw new Error("missing");
		actual = new URL(actualValue);
		expected = new URL(expectedValue);
	} catch {
		throw new Error("FORBIDDEN_ORIGIN");
	}
	if (actualValue !== actual.origin || actual.origin !== expected.origin) {
		throw new Error("FORBIDDEN_ORIGIN");
	}
}

function isRandomDeviceId(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requiredSecret(value: string | null): string {
	if (!value) throw new Error("GUEST_CONFIGURATION_ERROR");
	return value;
}
