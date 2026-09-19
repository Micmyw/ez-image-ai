import { describe, expect, it, vi } from "vitest";

import { createGuestGenerationTransaction, getGuestJobSnapshot } from "./guest-admission";

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

	it("rejects a legacy OpenRouter guest quote before opening a transaction", async () => {
		const transaction = vi.fn();
		const input = guestInput(5n);

		await expect(
			createGuestGenerationTransaction(
				{ ...input, quote: { ...input.quote, productKey: "image-fast" } },
				clientWith(transaction),
				vi.fn() as never,
			),
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
		denialSubjectHash: hash,
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
			productKey: "image-nano-banana-2-lite",
			catalogVersion: "catalog-v1",
			pricingVersion: "pricing-v1",
			credits: sponsorCredits,
			costMicros: 23_000n,
			inputSnapshot: {
				kind: "image-to-image",
				prompt: "Make the sky violet",
				sourceAssetId: "asset-1",
				skuKey: "nano-banana-2-lite-1k",
				aspectRatio: "16:9",
			},
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

describe("guest safety feedback ownership", () => {
	it.each([true, false])(
		"shows a finalizing guest output only after approval (approved=%s)",
		async (approved) => {
			const now = new Date("2026-09-19T00:00:00Z");
			const expiresAt = new Date(now.getTime() + 60_000);
			const checksum = "a".repeat(64);
			const asset = {
				id: "output",
				ownerType: "USER",
				ownerId: "guest-1",
				kind: "OUTPUT",
				status: approved ? "READY" : "VERIFYING",
				deletedAt: null,
				checksum,
				retentionClass: "GUEST_TRIAL",
				deleteAfter: expiresAt,
				watermarkVersion: "v1",
				watermarkedAt: now,
				cleanStagingDeletedAt: now,
				verificationValidUntil: expiresAt,
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: "test",
				verificationProviderTaskId: "check",
				verificationRuleVersion: "test",
				verificationPolicyVersion: "test",
				moderationResults: [
					{
						status: "APPROVED",
						assetChecksum: checksum,
						verificationGeneration: 1,
						attemptNumber: 1,
						evidenceKind: "OUTPUT",
						provider: "test",
						providerTaskId: "check",
						ruleVersion: "test",
						policyVersion: "test",
						validUntil: expiresAt,
					},
				],
			};
			const findFirst = vi.fn().mockResolvedValue({
				id: "job-1",
				status: "FINALIZING",
				guestTrial: {
					ownerId: "guest-1",
					currentJobId: "job-1",
					consumedJobId: "job-1",
					eligibility: "CONSUMED",
					linkIntents: [],
					expiresAt,
					projectedDispatchAt: now,
					estimateExpiresAt: expiresAt,
				},
				assets: [{ role: "OUTPUT", assetChecksum: checksum, asset }],
			});
			const result = await getGuestJobSnapshot(
				{
					ownerId: "guest-1",
					jobId: "job-1",
					now,
					verification: { provider: "test", ruleVersion: "test", policyVersion: "test" },
				},
				{ generationJob: { findFirst } } as never,
			);
			expect(result).toMatchObject({
				stage: approved ? "READY" : "FINISHING",
				resultAssetId: approved ? "output" : null,
			});
		},
	);

	it.each(["guest-1", "foreign-owner"])(
		"only includes rejection evidence belonging to %s",
		async (assetOwner) => {
			const findFirst = vi.fn().mockResolvedValue({
				id: "job-1",
				status: "FAILED",
				guestTrial: {
					ownerId: "guest-1",
					currentJobId: "job-1",
					consumedJobId: "job-1",
					eligibility: "CONSUMED",
					linkIntents: [],
					expiresAt: new Date("2026-09-17T00:00:00Z"),
					projectedDispatchAt: new Date("2026-09-16T00:00:00Z"),
					estimateExpiresAt: new Date("2026-09-16T00:01:00Z"),
				},
				assets: [
					{
						role: "OUTPUT",
						asset: {
							ownerType: "USER",
							ownerId: assetOwner,
							status: "QUARANTINED",
							deletedAt: null,
							moderationResults: [
								{
									status: "REJECTED",
									reasonCode: "SEEAPI_CONTENT_NOT_ALLOWED",
									rawEnvelope: { private: true },
								},
							],
						},
					},
				],
			});
			const result = await getGuestJobSnapshot(
				{
					ownerId: "guest-1",
					jobId: "job-1",
					now: new Date("2026-09-16T01:00:00Z"),
					verification: { provider: "test", ruleVersion: "test", policyVersion: "test" },
				},
				{ generationJob: { findFirst } } as never,
			);
			expect(result?.resultAssetId).toBeNull();
			expect(result?.outputSafety).toEqual(
				assetOwner === "guest-1"
					? { status: "REJECTED", reasonCode: "SEEAPI_CONTENT_NOT_ALLOWED" }
					: undefined,
			);
			expect(JSON.stringify(result)).not.toMatch(/private|rawEnvelope/);
			expect(findFirst).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({ id: "job-1", ownerId: "guest-1", ownerType: "USER" }),
				}),
			);
		},
	);
});
