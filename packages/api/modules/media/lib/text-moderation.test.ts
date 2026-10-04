import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/payments/waffo-content-safety", () => ({
	createWaffoPromptScanner: vi.fn(),
}));

import { createWaffoPromptScanner } from "@repo/payments/waffo-content-safety";

import { toMediaOrpcError } from "./errors";
import {
	createTextModerationAdapter,
	moderateQuoteInput,
	TEXT_MODERATION_RULE_VERSION,
} from "./text-moderation";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("generation text moderation", () => {
	it.each(["A mountain landscape", "画一只坐在窗边的猫"])(
		"sends %s only to the configured Waffo scanner",
		async (prompt) => {
			const scan = vi.fn(async () => ({
				decision: "ALLOW" as const,
				reasonCode: "WAFFO_PROMPT_ALLOWED",
				evidence: {
					requestId: "request-1",
					action: "allow" as const,
					semanticStatus: "scored",
					matchedCategories: [],
				},
			}));
			vi.mocked(createWaffoPromptScanner).mockReturnValue(scan);
			const fetcher = vi.fn<typeof fetch>();
			vi.stubGlobal("fetch", fetcher);
			const selected = createTextModerationAdapter({
				NODE_ENV: "test",
				MEDIA_SAFETY_ADAPTER: "configured",
				MODERATION_TEXT_WAFFO_ENABLED: "true",
			});
			expect(selected.provider).toBe("waffo");
			expect(
				await selected.adapter.moderateText({
					text: prompt,
					ruleVersion: TEXT_MODERATION_RULE_VERSION,
				}),
			).toMatchObject({ decision: "ALLOW", evidence: { waffo: { requestId: "request-1" } } });
			expect(scan).toHaveBeenCalledOnce();
			expect(scan).toHaveBeenCalledWith(prompt);
			expect(fetcher).not.toHaveBeenCalled();
		},
	);
	const quote = {
		ownerType: "USER" as const,
		ownerId: "user_1",
		submittedByUserId: "user_1",
		productKey: "image-fast",
		catalogVersion: "catalog-v1",
		pricingVersion: "pricing-v1",
		credits: 4n,
		costMicros: 100n,
		inputSnapshot: { kind: "text-to-image", prompt: "private prompt" },
		pricingSnapshot: {},
		expiresAt: new Date("2026-08-14T01:00:00.000Z"),
	};
	it.each([
		["adult_nsfw", "sexualContent"],
		["csam_minor", "minorSafety"],
		["sexual_violence_nonconsensual", "sexualExploitation"],
		["undress_transform", "sexualExploitation"],
		["face_swap_identity", "identityMisuse"],
		["bestiality_restricted", "sexualExploitation"],
		["unknown-private-label", "restrictedContent"],
	])("shows a safe reason for Waffo %s without exposing its evidence", async (category, reason) => {
		const persistApproved = vi.fn();
		const error = await moderateQuoteInput(quote, {
			provider: "waffo",
			moderateText: async () => ({
				decision: "REJECT",
				reasonCode: "WAFFO_RESTRICTED_CONTENT",
				ruleVersion: TEXT_MODERATION_RULE_VERSION,
				evidence: {
					requestId: "private-request",
					models: [],
					operations: 1,
					scores: {},
					waffo: {
						requestId: "private-request",
						action: "block",
						semanticStatus: "scored",
						matchedCategories: [category],
					},
				},
			}),
			persistApproved,
			recordDenied: vi.fn(),
		}).catch((denied: unknown) => denied);
		const response = toMediaOrpcError(error);
		expect(response.data).toEqual({ code: "CONTENT_NOT_ALLOWED", moderationReason: reason });
		expect(JSON.stringify(response.data)).not.toMatch(
			/waffo|private|requestId|matchedCategories|scores/i,
		);
		expect(persistApproved).not.toHaveBeenCalled();
	});

	it.each(["REJECT", "REVIEW", "ERROR"] as const)(
		"fails closed for a %s decision without persisting an approved quote",
		async (decision) => {
			const persistApproved = vi.fn();
			const recordDenied = vi.fn(async () => undefined);
			await expect(
				moderateQuoteInput(quote, {
					provider: "test",
					moderateText: vi.fn(async () => ({
						decision,
						reasonCode: `TEST_${decision}`,
						ruleVersion: TEXT_MODERATION_RULE_VERSION,
					})),
					persistApproved,
					recordDenied,
				}),
			).rejects.toThrow(`TEXT_MODERATION_${decision}`);
			expect(persistApproved).not.toHaveBeenCalled();
			expect(recordDenied).toHaveBeenCalledWith(
				expect.objectContaining({ decision, provider: "test" }),
			);
			expect(JSON.stringify(recordDenied.mock.calls)).not.toContain("private prompt");
		},
	);

	it("persists one approved evidence snapshot after exactly one adapter call", async () => {
		const moderateText = vi.fn(async () => ({
			decision: "ALLOW" as const,
			reasonCode: "NO_POLICY_MATCH",
			ruleVersion: TEXT_MODERATION_RULE_VERSION,
		}));
		const persistApproved = vi.fn(async (evidence) => ({ id: "quote_1", evidence }));
		const recordDenied = vi.fn();
		await expect(
			moderateQuoteInput(
				{ ...quote, inputSnapshot: { kind: "text-to-image", prompt: "approved prompt" } },
				{ provider: "test", moderateText, persistApproved, recordDenied },
			),
		).resolves.toMatchObject({ id: "quote_1" });
		expect(moderateText).toHaveBeenCalledOnce();
		expect(persistApproved).toHaveBeenCalledWith(
			expect.objectContaining({
				decision: "ALLOW",
				provider: "test",
				inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
			}),
		);
		expect(recordDenied).not.toHaveBeenCalled();
	});

	it("requires an explicit test-adapter switch and forbids it in production", () => {
		expect(() =>
			createTextModerationAdapter({ NODE_ENV: "test", MEDIA_SAFETY_ADAPTER: "test" }),
		).toThrow("TEST_SAFETY_ADAPTER_DISABLED");
		expect(() =>
			createTextModerationAdapter({
				NODE_ENV: "production",
				MEDIA_SAFETY_ADAPTER: "test",
				MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
			}),
		).toThrow(/production/i);
	});

	it("forbids a test adapter even with a local production-build E2E identity", () => {
		expect(() => createTextModerationAdapter(localProductionE2EEnvironment())).toThrow(
			/production/i,
		);
	});

	it.each(["test", "development"])(
		"accepts an explicitly enabled test adapter in %s",
		async (nodeEnv) => {
			const selected = createTextModerationAdapter({
				NODE_ENV: nodeEnv,
				MEDIA_SAFETY_ADAPTER: "test",
				MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
			});
			expect(selected.provider).toBe("test");
			await expect(
				selected.adapter.moderateText({
					text: "fixture",
					ruleVersion: TEXT_MODERATION_RULE_VERSION,
				}),
			).resolves.toMatchObject({ decision: "ALLOW" });
		},
	);

	it.each([undefined, "", "sightengine", "unknown"])(
		"rejects absent or retired selector %s without calling Waffo",
		(selector) => {
			expect(() =>
				createTextModerationAdapter({
					NODE_ENV: "production",
					MEDIA_SAFETY_ADAPTER: selector,
					MODERATION_TEXT_WAFFO_ENABLED: "true",
				}),
			).toThrow();
			expect(createWaffoPromptScanner).not.toHaveBeenCalled();
		},
	);

	it("requires explicit NODE_ENV before using a test adapter", () => {
		expect(() =>
			createTextModerationAdapter({
				MEDIA_SAFETY_ADAPTER: "test",
				MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
			}),
		).toThrow();
	});

	it.each(["REJECT", "REVIEW", "ERROR"] as const)(
		"requires the Waffo verdict before approving a quote: %s",
		async (decision) => {
			const scan = vi.fn(async () => ({ decision, reasonCode: "WAFFO_PROMPT_SCAN_DENIED" }));
			vi.mocked(createWaffoPromptScanner).mockReturnValue(scan);
			const selection = createTextModerationAdapter(liveModerationEnvironment());
			const persistApproved = vi.fn();
			const recordDenied = vi.fn();
			await expect(
				moderateQuoteInput(quote, {
					provider: selection.provider,
					moderateText: (input) => selection.adapter.moderateText(input),
					persistApproved,
					recordDenied,
				}),
			).rejects.toThrow(`TEXT_MODERATION_${decision}`);
			expect(scan).toHaveBeenCalledExactlyOnceWith("private prompt");
			expect(persistApproved).not.toHaveBeenCalled();
			expect(recordDenied).toHaveBeenCalledWith(
				expect.objectContaining({ decision, provider: "waffo" }),
			);
		},
	);

	it("retains only redacted Waffo evidence from its real scanner contract", async () => {
		const waffoEvidence = {
			requestId: "waffo-request-1",
			action: "allow" as const,
			semanticStatus: "scored",
			matchedCategories: [],
		};
		const scan = vi.fn(async () => ({
			decision: "ALLOW" as const,
			reasonCode: "WAFFO_PROMPT_ALLOWED",
			evidence: waffoEvidence,
		}));
		vi.mocked(createWaffoPromptScanner).mockReturnValue(scan);
		const { adapter, provider } = createTextModerationAdapter(liveModerationEnvironment());
		expect(provider).toBe("waffo");
		const result = await adapter.moderateText({
			text: "private prompt",
			ruleVersion: TEXT_MODERATION_RULE_VERSION,
		});
		expect(result).toMatchObject({
			decision: "ALLOW",
			ruleVersion: TEXT_MODERATION_RULE_VERSION,
			evidence: {
				requestId: "waffo-request-1",
				models: ["waffo-prompt-sift"],
				operations: 1,
				scores: {},
				waffo: waffoEvidence,
			},
		});
		expect(JSON.stringify(result)).not.toMatch(/private prompt|fixture-secret|sightengine/i);
	});

	it("keeps unexpected scanner failures as errors without leaking details", async () => {
		vi.mocked(createWaffoPromptScanner).mockReturnValue(
			vi.fn(async () => {
				throw new Error("private error");
			}),
		);
		const { adapter } = createTextModerationAdapter(liveModerationEnvironment());
		await expect(
			adapter.moderateText({ text: "private prompt", ruleVersion: TEXT_MODERATION_RULE_VERSION }),
		).resolves.toEqual({
			decision: "ERROR",
			reasonCode: "MODERATION_UNAVAILABLE",
			ruleVersion: TEXT_MODERATION_RULE_VERSION,
		});
	});

	it("invalidates old quote moderation versions when retiring the old safety chain", () => {
		expect(TEXT_MODERATION_RULE_VERSION).not.toBe("text-safety-2026-09-16.3");
	});
});

function liveModerationEnvironment(): Record<string, string | undefined> {
	return {
		NODE_ENV: "production",
		MEDIA_SAFETY_ADAPTER: "configured",
		MODERATION_TEXT_WAFFO_ENABLED: "true",
	};
}

function localProductionE2EEnvironment(): Record<string, string | undefined> {
	const databaseUrl = "postgresql://media:media@127.0.0.1:55432/media_e2e_test";
	return {
		NODE_ENV: "production",
		E2E_USE_PRODUCTION_BUILD: "true",
		E2E_TEST_MEDIA_ADAPTERS: "true",
		E2E_RUN_ID: "media-e2e-123",
		DATABASE_URL: databaseUrl,
		TEST_DATABASE_URL: databaseUrl,
		NEXT_PUBLIC_SAAS_URL: "http://localhost:3000",
		MEDIA_SAFETY_ADAPTER: "test",
		MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
	};
}
