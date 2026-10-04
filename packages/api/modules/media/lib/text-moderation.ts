import {
	createMediaSafetyAdapter,
	type MediaSafetyAdapter,
	type ModerationDecision,
} from "@repo/ai";
import {
	moderationConfiguration,
	assertTestModerationConfiguration,
	isRetryableModerationError,
	MODERATION_MAX_FAILURES,
} from "@repo/config";
import {
	fingerprintGenerationQuoteSecurityPayload,
	type CreateModeratedGenerationQuoteInput,
} from "@repo/database/media-quotes";
import { createWaffoPromptScanner } from "@repo/payments/waffo-content-safety";

import { TextModerationError } from "./public-moderation-reason";

export const TEXT_MODERATION_RULE_VERSION = "text-safety-waffo-2026-10-04.1";

export interface TextModerationEvidence extends Omit<ModerationDecision, "decision"> {
	decision: ModerationDecision["decision"];
	retry?: { failures: number; lastErrorCode: string; startedAt: string; lastFailureAt: string };
	provider: "waffo" | "test";
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
	if (result.decision !== "ALLOW") {
		await dependencies.recordDenied(evidence);
		throw new TextModerationError({ ...result, decision: result.decision });
	}
	return dependencies.persistApproved(evidence);
}

export function createTextModerationAdapter(environment: Record<string, string | undefined>): {
	provider: TextModerationEvidence["provider"];
	adapter: Pick<MediaSafetyAdapter, "moderateText">;
} {
	if (environment.MEDIA_SAFETY_ADAPTER === "test") {
		assertTestModerationConfiguration(environment);
		return {
			provider: "test",
			adapter: createMediaSafetyAdapter({
				kind: "test",
				nodeEnv: environment.NODE_ENV as "development" | "test",
				allowTestAdapter: true,
			}),
		};
	}
	const provider = textModerationProviderForEnvironment(environment);
	const scanWaffo = createWaffoPromptScanner(environment);
	return {
		provider,
		adapter: {
			async moderateText(input) {
				try {
					const result = await scanWaffo(input.text);
					return {
						decision: result.decision,
						reasonCode: result.reasonCode,
						ruleVersion: input.ruleVersion,
						...(result.evidence
							? {
									evidence: {
										requestId: result.evidence.requestId,
										models: ["waffo-prompt-sift"],
										operations: 1,
										scores: {},
										waffo: result.evidence,
									},
								}
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
	if (environment.MEDIA_SAFETY_ADAPTER === "test") {
		assertTestModerationConfiguration(environment);
		return "test";
	}
	if (!moderationConfiguration(environment).textWaffo)
		throw new Error("TEXT_MODERATION_CONFIGURATION_ERROR");
	return "waffo";
}
