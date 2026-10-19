import { describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("explicit client required");
	},
}));
vi.mock("./credits", () => ({
	reserveCreditsInTransaction: async () => ({
		id: "credit-reservation",
		amount: 5n,
		status: "ACTIVE",
	}),
}));
vi.mock("./moderation-operations", () => ({ assertQuoteModerationPermitted: async () => {} }));

import { createGenerationJobTransaction } from "./jobs";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";

describe("subscriber image job admission storage", () => {
	it.each([true, false])(
		"rechecks effective subscription inside admission (paid=%s)",
		async (paid) => {
			const f = fixture(paid);
			const result = createGenerationJobTransaction(f.input, f.client as never);
			if (!paid) {
				await expect(result).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
				expect(f.jobs).toEqual([]);
			} else {
				await result;
				expect(f.jobs).toEqual([
					expect.objectContaining({
						creditsReserved: 5n,
						pricingSnapshot: {
							credits: 5,
							costMicros: "123",
							aggregateStoragePolicy: { schemaVersion: 1, maximumBytes: null },
						},
					}),
				]);
				expect(f.quote.pricingSnapshot).toEqual({ credits: 5, costMicros: "123" });
				expect(f.quote.inputFingerprint).toBe(fingerprintGenerationQuoteSecurityPayload(f.quote));
			}
		},
	);
	it("free jobs below the quota freeze the finite cap instead of unlimited", async () => {
		const f = fixture(false, 0n);
		await createGenerationJobTransaction(f.input, f.client as never);
		expect(f.jobs[0]?.pricingSnapshot).toMatchObject({
			aggregateStoragePolicy: { schemaVersion: 1, maximumBytes: "100" },
		});
	});
});

function fixture(paid: boolean, usage = 1_000_000_000_000n) {
	const jobs: Record<string, unknown>[] = [];
	const quote = {
		id: "quote-a",
		ownerType: "USER" as const,
		ownerId: "owner-a",
		submittedByUserId: "owner-a",
		productKey: "image-nano-banana-2-lite",
		catalogVersion: "v1",
		pricingVersion: "v1",
		credits: 5n,
		costMicros: 123n,
		inputSnapshot: { kind: "text-to-image", prompt: "A vase" },
		pricingSnapshot: { credits: 5, costMicros: "123" },
		expiresAt: new Date(Date.now() + 60_000),
		moderationDecision: "ALLOW",
		moderationRuleVersion: "rule",
		moderationProvider: "mock",
		inputFingerprint: "",
	};
	quote.inputFingerprint = fingerprintGenerationQuoteSecurityPayload(quote);
	const tx = {
		$executeRaw: async () => 1,
		$queryRaw: async () => [{ now: new Date() }],
		subscription: {
			findMany: async () =>
				paid
					? [
							{
								id: "paid-a",
								provider: "paypal",
								status: "ACTIVE",
								periods: [{ paidAmount: 100n, refundedAmount: 0n }],
							},
						]
					: [],
		},
		billingPeriod: { fields: { paidAmount: "paidAmount" } },
		generationQuote: { findUnique: async () => quote },
		generationJob: {
			findUnique: async () => null,
			create: async ({ data }: { data: Record<string, unknown> }) => {
				jobs.push(data);
				return { ...data, id: "job-a", status: "QUEUED", version: 1 };
			},
		},
		generationJobAsset: { findMany: async () => [] },
		storageUsageReservation: { aggregate: async () => ({ _sum: { bytes: usage } }) },
		creditAccount: { findUnique: async () => ({ id: "account-a" }) },
		outboxEvent: { create: async () => ({}), findMany: async () => [{ id: "outbox-a" }] },
	};
	return {
		quote,
		jobs,
		input: {
			ownerType: "USER" as const,
			ownerId: "owner-a",
			submittedByUserId: "owner-a",
			quoteId: "quote-a",
			idempotencyKey: "create-a",
			inputAssetIds: [],
			expectedModerationRuleVersion: "rule",
			maximumStorageBytes: 100n,
		},
		client: {
			$transaction: async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx),
		},
	};
}
