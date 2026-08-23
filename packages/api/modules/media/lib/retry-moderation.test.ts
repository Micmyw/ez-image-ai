import { describe, expect, it } from "vitest";

import { buildApprovedRetryQuote } from "./retry-moderation";

describe("approved retry quote", () => {
	it("reuses approved evidence without moderation and fingerprints the new immutable quote", () => {
		const result = buildApprovedRetryQuote({
			sourceQuote: {
				moderationDecision: "ALLOW",
				moderationProvider: "sightengine",
				moderationRuleVersion: "text-safety-v1",
				moderationReasonCode: "NO_POLICY_MATCH",
			},
			quote: {
				ownerType: "USER",
				ownerId: "user_1",
				submittedByUserId: "user_1",
				productKey: "image-fast",
				catalogVersion: "catalog-v1",
				pricingVersion: "pricing-v1",
				credits: 4n,
				costMicros: 100n,
				inputSnapshot: { kind: "text-to-image", prompt: "approved prompt" },
				pricingSnapshot: {},
				expiresAt: new Date("2026-08-14T01:00:00.000Z"),
			},
			expectedRuleVersion: "text-safety-v1",
		});
		expect(result.moderation).toEqual({
			decision: "ALLOW",
			provider: "sightengine",
			ruleVersion: "text-safety-v1",
			reasonCode: "NO_POLICY_MATCH",
			inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});

	it.each([
		["legacy", "LEGACY_UNREVIEWED", "text-safety-v1"],
		["stale", "ALLOW", "text-safety-old"],
	] as const)("rejects %s source evidence", (_case, decision, ruleVersion) => {
		expect(() =>
			buildApprovedRetryQuote({
				sourceQuote: {
					moderationDecision: decision,
					moderationProvider: "sightengine",
					moderationRuleVersion: ruleVersion,
					moderationReasonCode: "NO_POLICY_MATCH",
				},
				quote: {
					ownerType: "USER",
					ownerId: "user_1",
					submittedByUserId: "user_1",
					productKey: "image-fast",
					catalogVersion: "catalog-v1",
					pricingVersion: "pricing-v1",
					credits: 4n,
					costMicros: 100n,
					inputSnapshot: {},
					pricingSnapshot: {},
					expiresAt: new Date("2026-08-14T01:00:00.000Z"),
				},
				expectedRuleVersion: "text-safety-v1",
			}),
		).toThrow("TEXT_MODERATION_EVIDENCE_INVALID");
	});
});
