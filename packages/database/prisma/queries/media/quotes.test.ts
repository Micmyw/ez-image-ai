import { describe, expect, it, vi } from "vitest";

import {
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "./quotes";

const BASE_QUOTE = {
	ownerType: "USER" as const,
	ownerId: "user_1",
	submittedByUserId: "user_1",
	productKey: "image-fast",
	catalogVersion: "catalog-v1",
	pricingVersion: "pricing-v1",
	credits: 4n,
	costMicros: 100n,
	inputSnapshot: { kind: "text-to-image", prompt: "never audit this" },
	pricingSnapshot: {},
	expiresAt: new Date("2026-08-14T01:00:00.000Z"),
};

describe("moderated generation quotes", () => {
	it("atomically stores ALLOW evidence and a prompt-free audit record", async () => {
		const tx = {
			generationQuote: { create: vi.fn(async ({ data }) => ({ id: "quote_1", ...data })) },
			auditLog: { create: vi.fn(async ({ data }) => data) },
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };
		await createModeratedGenerationQuoteTransaction(
			{
				...BASE_QUOTE,
				moderation: {
					decision: "ALLOW",
					provider: "sightengine",
					ruleVersion: "text-safety-v1",
					reasonCode: "NO_POLICY_MATCH",
					inputFingerprint: fingerprintGenerationQuoteSecurityPayload(BASE_QUOTE),
				},
			},
			client as never,
		);
		expect(tx.generationQuote.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				moderationDecision: "ALLOW",
				moderationProvider: "sightengine",
				moderationRuleVersion: "text-safety-v1",
				moderationReasonCode: "NO_POLICY_MATCH",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(BASE_QUOTE),
			}),
		});
		expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain("never audit this");
	});

	it("rejects evidence whose fingerprint does not cover the exact quote security payload", async () => {
		await expect(
			createModeratedGenerationQuoteTransaction(
				{
					...BASE_QUOTE,
					productKey: "video-fast",
					moderation: {
						decision: "ALLOW",
						provider: "sightengine",
						ruleVersion: "text-safety-v1",
						reasonCode: "NO_POLICY_MATCH",
						inputFingerprint: fingerprintGenerationQuoteSecurityPayload(BASE_QUOTE),
					},
				},
				{ $transaction: vi.fn() } as never,
			),
		).rejects.toThrow("TEXT_MODERATION_EVIDENCE_INVALID");
	});

	it("changes the fingerprint when prompt, model parameters, pricing, or expiry changes", () => {
		const original = fingerprintGenerationQuoteSecurityPayload(BASE_QUOTE);
		const mutations = [
			{ ...BASE_QUOTE, inputSnapshot: { kind: "text-to-image", prompt: "changed" } },
			{ ...BASE_QUOTE, inputSnapshot: { ...BASE_QUOTE.inputSnapshot, width: 1024 } },
			{ ...BASE_QUOTE, pricingVersion: "pricing-v2" },
			{ ...BASE_QUOTE, expiresAt: new Date("2026-08-14T02:00:00.000Z") },
		];
		for (const mutation of mutations) {
			expect(fingerprintGenerationQuoteSecurityPayload(mutation)).not.toBe(original);
		}
	});

	it("refuses non-ALLOW evidence at the database boundary", async () => {
		await expect(
			createModeratedGenerationQuoteTransaction(
				{
					ownerType: "USER",
					ownerId: "user_1",
					submittedByUserId: "user_1",
					productKey: "image-fast",
					catalogVersion: "catalog-v1",
					pricingVersion: "pricing-v1",
					credits: 4n,
					inputSnapshot: {},
					expiresAt: new Date(Date.now() + 60_000),
					moderation: {
						decision: "REJECT",
						provider: "sightengine",
						ruleVersion: "text-safety-v1",
						reasonCode: "POLICY_MATCH",
						inputFingerprint: "a".repeat(64),
					},
				},
				{ $transaction: vi.fn() } as never,
			),
		).rejects.toThrow("TEXT_MODERATION_REJECT");
	});
});
