import { describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("Unexpected implicit database");
	},
}));
vi.mock("./credits", () => ({ reserveCreditsInTransaction: vi.fn() }));
import { createGenerationJobTransaction } from "./jobs";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";

const reached = new Error("STORAGE_CHECK_REACHED");

describe("admission isolation preserves existing asset binding protocol", () => {
	it("retains Serializable eligibility for an image pass even without input assets or a global-budget flag", async () => {
		const quote = {
			id: "pass-quote",
			ownerType: "USER",
			ownerId: "owner",
			submittedByUserId: "owner",
			productKey: "image-nano-banana-pro",
			catalogVersion: "test",
			pricingVersion: "test",
			credits: 25n,
			costMicros: 120000n,
			inputSnapshot: { kind: "text-to-image", prompt: "reviewed", skuKey: "nano-banana-pro-4k" },
			pricingSnapshot: {
				fundingSource: "IMAGE_PASS",
				imagePassUnits: 1,
				skuKey: "nano-banana-pro-4k",
			},
			expiresAt: new Date("2099-01-01"),
			moderationDecision: "ALLOW",
			moderationProvider: "test",
			moderationRuleVersion: "rule",
		};
		const tx = {
			$queryRaw: vi.fn(async () => [{ now: new Date() }]),
			$executeRaw: vi.fn(),
			generationQuote: {
				findUnique: vi.fn(async () => ({
					...quote,
					inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quote as never),
				})),
			},
			generationJob: {
				findUnique: vi.fn(async () => {
					throw reached;
				}),
			},
		};
		const isolation: string[] = [];
		const client = {
			$transaction: async (
				operation: (value: typeof tx) => Promise<unknown>,
				options: { isolationLevel: string },
			) => {
				isolation.push(options.isolationLevel);
				try {
					return await operation(tx);
				} finally {
					if (options.isolationLevel === "ReadCommitted")
						expect(tx.$executeRaw).not.toHaveBeenCalled();
				}
			},
		};
		await expect(
			createGenerationJobTransaction(
				{
					ownerType: "USER",
					ownerId: "owner",
					submittedByUserId: "owner",
					quoteId: "pass-quote",
					idempotencyKey: "pass-request",
					inputAssetIds: [],
					expectedModerationRuleVersion: "rule",
				},
				client as never,
			),
		).rejects.toBe(reached);
		expect(isolation).toEqual(["ReadCommitted", "Serializable"]);
		expect(tx.generationJob.findUnique).toHaveBeenCalledOnce();
	});
	it.each([
		[{ kind: "text-to-image", prompt: "reviewed" }, [], ["ReadCommitted"]],
		[{ kind: "text-to-image", prompt: "reviewed" }, ["asset"], ["Serializable"]],
		[
			{ kind: "image-to-image", prompt: "reviewed", sourceAssetId: "asset" },
			["asset"],
			["Serializable"],
		],
		[
			{ kind: "image-to-image", prompt: "reviewed", sourceAssetId: "asset" },
			[],
			["ReadCommitted", "Serializable"],
		],
		[{ kind: "text-to-image", sourceAssetId: "asset" }, [], ["ReadCommitted", "Serializable"]],
		[{ kind: "text-to-image", temporaryReference: {} }, [], ["ReadCommitted", "Serializable"]],
		[{ kind: "text-to-image", editContext: {} }, [], ["ReadCommitted", "Serializable"]],
		[
			{ kind: "text-to-image", referenceAssetIds: ["asset"] },
			[],
			["ReadCommitted", "Serializable"],
		],
		[{ kind: "text-to-image", futureReference: {} }, [], ["ReadCommitted", "Serializable"]],
		[{ kind: "unknown" }, [], ["ReadCommitted", "Serializable"]],
	] as const)(
		"uses authoritative quote shape, including when asset IDs are omitted: %j",
		async (inputSnapshot, inputAssetIds, expected) => {
			const quote = {
				ownerType: "USER",
				ownerId: "owner",
				submittedByUserId: "owner",
				productKey: "image-fast",
				catalogVersion: "test",
				pricingVersion: "test",
				credits: 5n,
				costMicros: 1n,
				inputSnapshot,
				pricingSnapshot: {},
				expiresAt: new Date("2099-01-01"),
				moderationDecision: "ALLOW",
				moderationProvider: "test",
				moderationRuleVersion: "rule",
			};
			const tx = {
				$queryRaw: vi.fn(async () => [{ now: new Date() }]),
				$executeRaw: vi.fn(),
				generationQuote: {
					findUnique: vi.fn(async () => ({
						...quote,
						inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quote as never),
					})),
				},
				generationJob: { findUnique: vi.fn(async () => null) },
				subscription: { findMany: vi.fn(async () => []) },
				billingPeriod: { fields: { paidAmount: "paidAmount" } },
				storageUsageReservation: {
					aggregate: vi.fn(async () => {
						throw reached;
					}),
				},
			};
			const isolation: string[] = [];
			const client = {
				$transaction: async (
					operation: (value: typeof tx) => Promise<unknown>,
					options: { isolationLevel: string },
				) => {
					isolation.push(options.isolationLevel);
					return operation(tx);
				},
			};
			await expect(
				createGenerationJobTransaction(
					{
						ownerType: "USER",
						ownerId: "owner",
						submittedByUserId: "owner",
						quoteId: "quote",
						idempotencyKey: "request",
						inputAssetIds: [...inputAssetIds],
						expectedModerationRuleVersion: "rule",
						maximumStorageBytes: 100n,
					},
					client as never,
				),
			).rejects.toBe(reached);
			expect(isolation).toEqual(expected);
		},
	);
});
