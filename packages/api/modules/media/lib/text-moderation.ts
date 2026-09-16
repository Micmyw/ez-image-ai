import {
	createMediaSafetyAdapter,
	type MediaSafetyAdapter,
	type ModerationDecision,
} from "@repo/ai";
import {
	moderationConfiguration,
	isRetryableModerationError,
	MODERATION_BYPASS_REASON,
	MODERATION_MAX_FAILURES,
} from "@repo/config";
import {
	fingerprintGenerationQuoteSecurityPayload,
	type CreateModeratedGenerationQuoteInput,
} from "@repo/database/media-quotes";
import { createWaffoPromptScanner } from "@repo/payments/waffo-content-safety";

import { TextModerationError } from "./public-moderation-reason";

export const TEXT_MODERATION_RULE_VERSION = "text-safety-2026-09-16.3";

export interface TextModerationEvidence extends Omit<ModerationDecision, "decision"> {
	decision: ModerationDecision["decision"] | "BYPASS";
	retry?: { failures: number; lastErrorCode: string; startedAt: string; lastFailureAt: string };
	provider: "sightengine" | "sightengine+waffo" | "waffo" | "test";
	inputFingerprint: string;
}

interface ModerateQuoteDependencies<T> {
	provider: TextModerationEvidence["provider"];
	moderateText(input: { text: string; ruleVersion: string }): Promise<ModerationDecision>;
	persistApproved(evidence: TextModerationEvidence): Promise<T> | T;
	recordDenied(evidence: TextModerationEvidence): Promise<void> | void;
	retryWait?: (milliseconds: number) => Promise<void>;
}

export async function moderateTextWithRetry(
	input: { text: string; ruleVersion: string },
	scan: (input: { text: string; ruleVersion: string }) => Promise<ModerationDecision>,
	wait = (milliseconds: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
): Promise<Omit<TextModerationEvidence, "provider" | "inputFingerprint">> {
	const startedAt = new Date().toISOString();
	let failures = 0;
	let lastErrorCode = "";
	let lastFailureAt = startedAt;
	while (true) {
		// Adapters classify network failures. Programming/configuration exceptions do not grant access.
		const result = await scan(input);
		if (result.decision !== "ERROR") {
			return { ...result, retry: { failures, lastErrorCode, startedAt, lastFailureAt } };
		}
		failures += 1;
		lastErrorCode = result.reasonCode;
		lastFailureAt = new Date().toISOString();
		if (!isRetryableModerationError(result.reasonCode))
			return { ...result, retry: { failures, lastErrorCode, startedAt, lastFailureAt } };
		if (failures >= MODERATION_MAX_FAILURES)
			return {
				...result,
				decision: "BYPASS",
				reasonCode: MODERATION_BYPASS_REASON,
				retry: { failures, lastErrorCode, startedAt, lastFailureAt },
			};
		await wait(250 * 2 ** (failures - 1));
	}
}

export async function moderateQuoteInput<T>(
	input: Omit<CreateModeratedGenerationQuoteInput, "moderation">,
	dependencies: ModerateQuoteDependencies<T>,
): Promise<T> {
	const result = await moderateTextWithRetry(
		{
			text: (input.inputSnapshot as { prompt: string }).prompt,
			ruleVersion: TEXT_MODERATION_RULE_VERSION,
		},
		(value) => dependencies.moderateText(value),
		dependencies.retryWait,
	);
	const evidence: TextModerationEvidence = {
		...result,
		provider: dependencies.provider,
		inputFingerprint: fingerprintGenerationQuoteSecurityPayload(input),
	};
	if (result.decision !== "ALLOW" && result.decision !== "BYPASS") {
		await dependencies.recordDenied(evidence);
		throw new TextModerationError({ ...result, decision: result.decision });
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
				if (primary && (primary.decision === "REJECT" || primary.decision === "REVIEW"))
					return primary;
				if (!scanWaffo) return primary!;
				try {
					const secondary = await scanWaffo(input.text);
					if (primary?.decision === "ERROR" && secondary.decision === "ALLOW") return primary;
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
