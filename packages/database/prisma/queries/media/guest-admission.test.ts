import { describe, expect, it, vi } from "vitest";

import { createGuestGenerationTransaction } from "./guest-admission";

describe("guest admission credit contract", () => {
	it("accepts the current five-credit sponsor value at the database boundary", async () => {
		const transactionReached = new Error("TRANSACTION_REACHED");
		const transaction = vi.fn(async () => {
			throw transactionReached;
		});

		await expect(
			createGuestGenerationTransaction(guestInput(5n), clientWith(transaction), vi.fn() as never),
		).rejects.toBe(transactionReached);
		expect(transaction).toHaveBeenCalledOnce();
	});

	it("rejects the retired four-credit sponsor value before opening a transaction", async () => {
		const transaction = vi.fn();

		await expect(
			createGuestGenerationTransaction(guestInput(4n), clientWith(transaction), vi.fn() as never),
		).rejects.toThrow("GUEST_PRICE_CHANGED");
		expect(transaction).not.toHaveBeenCalled();
	});
});

function clientWith(transaction: ReturnType<typeof vi.fn>) {
	return {
		$transaction: transaction,
		guestAbuseBucket: { upsert: vi.fn(async () => ({})) },
	} as never;
}

function guestInput(sponsorCredits: bigint) {
	const now = new Date("2026-09-05T00:00:00.000Z");
	const ownerId = "guest-owner";
	const hash = "a".repeat(64);
	return {
		ownerId,
		promotionPeriod: "pricing-v1",
		capabilityVersion: "capability-v1",
		sourceSessionHash: hash,
		deviceHash: hash,
		ipHash: hash,
		subnetHash: hash,
		idempotencyKey: "guest-test-1",
		idempotencyFingerprint: hash,
		turnstile: {
			tokenHash: hash,
			challengeTimestamp: now,
			expiresAt: new Date(now.getTime() + 60_000),
		},
		sourceDraftId: "draft-1",
		sourceBootstrapId: "bootstrap-1",
		sourceAssetId: "asset-1",
		sourceAssetChecksum: hash,
		now,
		retentionMs: 60_000,
		queueTtlMs: 60_000,
		serviceTimeMs: 1_000,
		maximumBytes: 10 * 1024 * 1024,
		maximumGlobalQueueDepth: 25,
		maximumActiveJobsPerGuest: 1,
		maximumRequestsPerMinute: 10,
		maximumRequestsPerIpPerHour: 10,
		abuseEvidenceTtlMs: 60_000,
		riskBudgetMicros: 230_000n,
		sponsorCredits,
		assetModeration: {
			provider: "test",
			ruleVersion: "rule-v1",
			policyVersion: "policy-v1",
		},
		quote: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-fast",
			catalogVersion: "catalog-v1",
			pricingVersion: "pricing-v1",
			credits: sponsorCredits,
			costMicros: 23_000n,
			inputSnapshot: {},
			pricingSnapshot: {},
			expiresAt: new Date(now.getTime() + 60_000),
			moderation: {
				decision: "ALLOW",
				provider: "test",
				ruleVersion: "rule-v1",
				reasonCode: "TEST_ALLOW",
				inputFingerprint: hash,
			},
		},
	} satisfies Parameters<typeof createGuestGenerationTransaction>[0];
}
