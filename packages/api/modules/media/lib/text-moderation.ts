import {
	createMediaSafetyAdapter,
	type MediaSafetyAdapter,
	type ModerationDecision,
} from "@repo/ai";
import { moderationConfiguration } from "@repo/config";
import {
	fingerprintGenerationQuoteSecurityPayload,
	type CreateModeratedGenerationQuoteInput,
} from "@repo/database/media-quotes";
import { createWaffoPromptScanner } from "@repo/payments/waffo-content-safety";

export const TEXT_MODERATION_RULE_VERSION = "text-safety-2026-09-16.2";

export interface TextModerationEvidence extends ModerationDecision {
	provider: "sightengine" | "sightengine+waffo" | "waffo" | "test";
	inputFingerprint: string;
}

interface ModerateQuoteDependencies<T> {
	provider: TextModerationEvidence["provider"];
	moderateText(input: { text: string; ruleVersion: string }): Promise<ModerationDecision>;
	persistApproved(evidence: TextModerationEvidence): Promise<T> | T;
	recordDenied(evidence: TextModerationEvidence): Promise<void> | void;
}

export async function moderateQuoteInput<T>(
	input: Omit<CreateModeratedGenerationQuoteInput, "moderation">,
	dependencies: ModerateQuoteDependencies<T>,
): Promise<T> {
	const result = await dependencies.moderateText({
		text: (input.inputSnapshot as { prompt: string }).prompt,
		ruleVersion: TEXT_MODERATION_RULE_VERSION,
	});
	const evidence: TextModerationEvidence = {
		...result,
		provider: dependencies.provider,
		inputFingerprint: fingerprintGenerationQuoteSecurityPayload(input),
	};
	if (result.decision !== "ALLOW") {
		await dependencies.recordDenied(evidence);
		throw new Error(`TEXT_MODERATION_${result.decision}`);
	}
	return dependencies.persistApproved(evidence);
}

export function createTextModerationAdapter(environment: Record<string, string | undefined>): {
	provider: TextModerationEvidence["provider"];
	adapter: Pick<MediaSafetyAdapter, "moderateText">;
} {
	const nodeEnv = normalizedNodeEnvironment(environment.NODE_ENV);
	if (environment.MEDIA_SAFETY_ADAPTER === "test") {
		if (environment.MEDIA_ALLOW_TEST_SAFETY_ADAPTER !== "true") {
			throw new Error("TEST_SAFETY_ADAPTER_DISABLED");
		}
		return {
			provider: "test",
			adapter: createMediaSafetyAdapter({
				kind: "test",
				nodeEnv: isLocalProductionBuildE2E(environment) ? "test" : nodeEnv,
			}),
		};
	}
	const config = moderationConfiguration(environment);
	if (!config.textWaffo && !config.textSightengine)
		throw new Error("TEXT_MODERATION_CONFIGURATION_ERROR");
	if (
		config.textSightengine &&
		(!environment.SIGHTENGINE_API_USER || !environment.SIGHTENGINE_API_SECRET)
	)
		throw new Error("TEXT_MODERATION_CONFIGURATION_ERROR");
	const primaryAdapter = config.textSightengine
		? createMediaSafetyAdapter({
				kind: "sightengine",
				nodeEnv,
				apiUser: environment.SIGHTENGINE_API_USER!,
				apiSecret: environment.SIGHTENGINE_API_SECRET!,
			})
		: undefined;
	const scanWaffo = config.textWaffo ? createWaffoPromptScanner(environment) : undefined;
	return {
		provider: textModerationProviderForEnvironment(environment),
		adapter: {
			async moderateText(input) {
				const primary = primaryAdapter ? await primaryAdapter.moderateText(input) : undefined;
				if (primary && primary.decision !== "ALLOW") return primary;
				if (!scanWaffo) return primary!;
				try {
					const secondary = await scanWaffo(input.text);
					return {
						decision: secondary.decision,
						reasonCode:
							secondary.decision === "ALLOW" && primary ? primary.reasonCode : secondary.reasonCode,
						ruleVersion: input.ruleVersion,
						...(secondary.evidence
							? {
									evidence: {
										...(primary?.evidence ?? {
											requestId: secondary.evidence.requestId,
											models: ["waffo-prompt-sift"],
											operations: 1,
											scores: {},
										}),
										waffo: secondary.evidence,
									},
								}
							: primary?.evidence
								? { evidence: primary.evidence }
								: {}),
					};
				} catch {
					return {
						decision: "ERROR",
						reasonCode: "MODERATION_UNAVAILABLE",
						ruleVersion: input.ruleVersion,
					};
				}
			},
		},
	};
}

export function textModerationProviderForEnvironment(
	environment: Record<string, string | undefined>,
): TextModerationEvidence["provider"] {
	if (environment.MEDIA_SAFETY_ADAPTER === "test" || !environment.MEDIA_SAFETY_ADAPTER)
		return "test";
	const config = moderationConfiguration(environment);
	if (config.textWaffo) return config.textSightengine ? "sightengine+waffo" : "waffo";
	if (config.textSightengine) return "sightengine";
	throw new Error("TEXT_MODERATION_CONFIGURATION_ERROR");
}

function normalizedNodeEnvironment(
	value: string | undefined,
): "development" | "test" | "production" {
	if (value === "production" || value === "test") return value;
	return "development";
}

function isLocalProductionBuildE2E(environment: Record<string, string | undefined>): boolean {
	if (
		environment.NODE_ENV !== "production" ||
		environment.E2E_USE_PRODUCTION_BUILD !== "true" ||
		environment.E2E_TEST_MEDIA_ADAPTERS !== "true" ||
		!environment.E2E_RUN_ID ||
		!/^[a-z0-9-]{6,48}$/i.test(environment.E2E_RUN_ID) ||
		!environment.DATABASE_URL ||
		!environment.TEST_DATABASE_URL ||
		environment.DATABASE_URL !== environment.TEST_DATABASE_URL
	) {
		return false;
	}
	try {
		const database = new URL(environment.DATABASE_URL);
		const saas = new URL(environment.NEXT_PUBLIC_SAAS_URL ?? "");
		return (
			isLoopbackHost(database.hostname) &&
			/test|testing/i.test(database.pathname) &&
			isLocalHttpOrigin(saas)
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
