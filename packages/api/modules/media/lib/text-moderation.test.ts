import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/payments/waffo-content-safety", () => ({
	createWaffoPromptScanner: vi.fn(),
}));

import { createWaffoPromptScanner } from "@repo/payments/waffo-content-safety";

import { safeTextResponse } from "../../../../ai/media/moderation/sightengine.test-fixtures";
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
		"sends %s to Waffo when Sightengine is switched off",
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
				MODERATION_TEXT_SIGHTENGINE_ENABLED: "false",
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

	it("allows the test adapter only for a complete local production-build E2E identity", async () => {
		const { adapter, provider } = createTextModerationAdapter(localProductionE2EEnvironment());
		expect(provider).toBe("test");
		await expect(
			adapter.moderateText({ text: "local E2E prompt", ruleVersion: "test-rule" }),
		).resolves.toMatchObject({ decision: "ALLOW", ruleVersion: "test-rule" });
	});

	it.each([
		["production-build opt-in", { E2E_USE_PRODUCTION_BUILD: undefined }],
		["media adapter opt-in", { E2E_TEST_MEDIA_ADAPTERS: undefined }],
		["valid run id", { E2E_RUN_ID: "invalid_run_id" }],
		["declared test database", { TEST_DATABASE_URL: "postgresql://localhost/other_test" }],
		["loopback database", { DATABASE_URL: "postgresql://database.example/media_test" }],
		["test database name", { DATABASE_URL: "postgresql://localhost/media" }],
		["loopback SaaS origin", { NEXT_PUBLIC_SAAS_URL: "https://saas.example" }],
		["loopback SaaS origin", { NEXT_PUBLIC_SAAS_URL: "https://saas.example" }],
	] as const)("keeps production closed without a %s", (_boundary, overrides) => {
		expect(() =>
			createTextModerationAdapter({ ...localProductionE2EEnvironment(), ...overrides }),
		).toThrow(/production/i);
	});

	it("fails closed when production Sightengine credentials are missing", () => {
		expect(() =>
			createTextModerationAdapter({
				NODE_ENV: "production",
				MEDIA_SAFETY_ADAPTER: "sightengine",
			}),
		).toThrow("TEXT_MODERATION_CONFIGURATION_ERROR");
	});

	it.each(["REJECT", "REVIEW", "ERROR"] as const)(
		"requires the live Waffo scan before approving a quote: %s",
		async (decision) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => Response.json(safeTextResponse())),
			);
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
				expect.objectContaining({
					decision,
					provider: "sightengine+waffo",
				}),
			);
		},
	);

	it("retains both providers' redacted evidence only after both checks allow", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(safeTextResponse())),
		);
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
		expect(provider).toBe("sightengine+waffo");
		const result = await adapter.moderateText({
			text: "private prompt",
			ruleVersion: TEXT_MODERATION_RULE_VERSION,
		});
		expect(result).toMatchObject({
			decision: "ALLOW",
			ruleVersion: TEXT_MODERATION_RULE_VERSION,
			evidence: { requestId: "req_text_fixture", waffo: waffoEvidence },
		});
		expect(JSON.stringify(result)).not.toMatch(/private prompt|fixture-secret/);
	});

	it("does not send a prompt already denied by Sightengine to another provider", async () => {
		const rejected = safeTextResponse();
		rejected.moderation_classes.violent = 0.99;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(rejected)),
		);
		const scan = vi.fn();
		vi.mocked(createWaffoPromptScanner).mockReturnValue(scan);
		const { adapter } = createTextModerationAdapter(liveModerationEnvironment());
		expect(
			await adapter.moderateText({
				text: "private prompt",
				ruleVersion: TEXT_MODERATION_RULE_VERSION,
			}),
		).toMatchObject({ decision: "REJECT" });
		expect(scan).not.toHaveBeenCalled();
	});

	it("invalidates old quote moderation versions when enabling the new safety chain", () => {
		expect(TEXT_MODERATION_RULE_VERSION).not.toBe("text-safety-2026-09-08.1");
	});
});

function liveModerationEnvironment(): Record<string, string | undefined> {
	return {
		NODE_ENV: "production",
		MEDIA_SAFETY_ADAPTER: "sightengine",
		SIGHTENGINE_API_USER: "fixture-user",
		SIGHTENGINE_API_SECRET: "fixture-secret",
		WAFFO_ENVIRONMENT: "prod",
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
