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
