import { describe, expect, it, vi } from "vitest";

import { createGenerationJobTransaction } from "./jobs";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";

const BASE_QUOTE = {
	id: "quote_1",
	ownerType: "USER" as const,
	ownerId: "user_1",
	submittedByUserId: "user_1",
	productKey: "image-fast",
	catalogVersion: "catalog-v1",
	pricingVersion: "pricing-v1",
	credits: 4n,
	costMicros: 100n,
	inputSnapshot: { kind: "text-to-image", prompt: "approved prompt" },
	pricingSnapshot: {},
	createdAt: new Date("2026-08-14T00:00:00.000Z"),
	expiresAt: new Date("2099-08-14T01:00:00.000Z"),
	moderationDecision: "ALLOW",
	moderationProvider: "sightengine",
	moderationRuleVersion: "text-safety-v1",
	moderationReasonCode: "NO_POLICY_MATCH",
	inputFingerprint: "",
};

function clientWithQuote(quote: typeof BASE_QUOTE, existingJob: unknown = null) {
	const tx = {
		generationJob: { findUnique: vi.fn(async () => existingJob) },
		generationQuote: { findUnique: vi.fn(async () => quote) },
	};
	return {
		$transaction: vi.fn(async (operation) => operation(tx)),
	};
}

describe("generation job moderation boundary", () => {
	it.each([
		["legacy decision", { moderationDecision: "LEGACY_UNREVIEWED" }],
		["stale rule", { moderationRuleVersion: "text-safety-old" }],
		["tampered input", { inputSnapshot: { kind: "text-to-image", prompt: "changed" } }],
	] as const)("rejects a quote with %s before reserving credits", async (_case, override) => {
		const approved = {
			...BASE_QUOTE,
			inputFingerprint: fingerprintGenerationQuoteSecurityPayload(BASE_QUOTE),
		};
		const client = clientWithQuote({ ...approved, ...override } as typeof BASE_QUOTE);
		await expect(
			createGenerationJobTransaction(
				{
					ownerType: "USER",
					ownerId: "user_1",
					submittedByUserId: "user_1",
					quoteId: "quote_1",
					idempotencyKey: "request_123",
					inputAssetIds: [],
					expectedModerationRuleVersion: "text-safety-v1",
				},
				client as never,
			),
		).rejects.toThrow("TEXT_MODERATION_EVIDENCE_INVALID");
	});

	it("validates moderation evidence before returning an idempotent replay", async () => {
		const approved = {
			...BASE_QUOTE,
			inputFingerprint: fingerprintGenerationQuoteSecurityPayload(BASE_QUOTE),
		};
		const client = clientWithQuote(
			{ ...approved, moderationDecision: "LEGACY_UNREVIEWED" },
			{
				id: "job_1",
				status: "RESERVED",
				version: 0,
				creditsReserved: 4n,
				reservation: { id: "reservation_1", amount: 4n, status: "ACTIVE" },
			},
		);
		await expect(
			createGenerationJobTransaction(
				{
					ownerType: "USER",
					ownerId: "user_1",
					submittedByUserId: "user_1",
					quoteId: "quote_1",
					idempotencyKey: "request_123",
					inputAssetIds: [],
					expectedModerationRuleVersion: "text-safety-v1",
				},
				client as never,
			),
		).rejects.toThrow("TEXT_MODERATION_EVIDENCE_INVALID");
	});
});
