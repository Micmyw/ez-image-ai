import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("Unexpected implicit database");
	},
}));
vi.mock("./credits", () => ({ reserveCreditsInTransaction: vi.fn() }));
import { createGenerationJobTransaction } from "./jobs";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";
import type { CreateGenerationJobInput } from "./types";

const reached = new Error("STORAGE_CHECK_REACHED");

afterEach(() => vi.unstubAllEnvs());

function preparedTemporaryInput(): CreateGenerationJobInput {
	const reference = {
		v: 1,
		ownerId: "owner",
		assetId: "3e989b0b-5dfe-4f97-a93e-e3b689ab48c8",
		contentType: "image/png",
		bytes: 1000,
		checksum: "b".repeat(64),
		createdAt: "2098-12-30T00:00:00.000Z",
		expiresAt: "2098-12-31T00:00:00.000Z",
	};
	const quote = {
		quoteId: "temporary-quote",
		ownerType: "USER" as const,
		ownerId: "owner",
		submittedByUserId: "owner",
		productKey: "image-nano-banana-2-lite",
		catalogVersion: "test",
		pricingVersion: "test",
		credits: 5n,
		costMicros: 100n,
		inputSnapshot: {
			kind: "image-to-image",
			prompt: "reviewed",
			sourceAssetId: reference.assetId,
			editContext: { kind: "ROOT", rootAssetId: reference.assetId },
			temporaryReference: reference,
			submissionFingerprint: "a".repeat(64),
		},
		pricingSnapshot: {},
		expiresAt: new Date("2099-01-01"),
	};
	return {
		ownerType: "USER",
		ownerId: "owner",
		submittedByUserId: "owner",
		quoteId: quote.quoteId,
		idempotencyKey: "temporary-request",
		preparedQuote: {
			...quote,
			moderation: {
				decision: "ALLOW",
				provider: "test",
				ruleVersion: "rule",
				reasonCode: "NO_POLICY_MATCH",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quote),
			},
		},
		inputAssetIds: [reference.assetId],
		edit: { kind: "ROOT", rootAssetId: reference.assetId },
		expectedModerationRuleVersion: "rule",
		validateCurrentEligibility: true,
	};
}

describe("admission isolation preserves existing asset binding protocol", () => {
	it.each([
		["enabled initial temporary credits", "true", "ReadCommitted"],
		["disabled initial temporary credits", "false", "Serializable"],
		["unset rollout flag", undefined, "Serializable"],
		["noncanonical rollout flag", "1", "Serializable"],
		["image pass", "true", "Serializable"],
		["global daily budget", "true", "Serializable"],
		["without current eligibility", "true", "Serializable"],
		["root retry", "true", "Serializable"],
		["child edit", "true", "Serializable"],
		["unknown input field", "true", "Serializable"],
		["mismatched source", "true", "Serializable"],
		["mismatched temporary owner", "true", "Serializable"],
		["nested model property", "true", "Serializable"],
		["unknown root context field", "true", "Serializable"],
	] as const)("keeps %s inside its proven isolation boundary", async (name, flag, expected) => {
		vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", flag);
		const input = preparedTemporaryInput();
		const prepared = input.preparedQuote!;
		const snapshot = prepared.inputSnapshot as Record<string, any>;
		if (name === "image pass") prepared.pricingSnapshot = { fundingSource: "IMAGE_PASS" };
		if (name === "global daily budget") input.maximumGlobalDailyCostMicros = 1000n;
		if (name === "without current eligibility") input.validateCurrentEligibility = false;
		if (name === "root retry")
			input.edit = {
				kind: "ROOT_RETRY",
				rootAssetId: input.inputAssetIds[0]!,
				editSessionId: "edit",
			};
		if (name === "child edit")
			input.edit = {
				kind: "CHILD",
				sourceAssetId: input.inputAssetIds[0]!,
				editSessionId: "edit",
				parentJobId: "parent",
			};
		if (name === "unknown input field") snapshot.futureReference = {};
		if (name === "mismatched source") snapshot.sourceAssetId = "different";
		if (name === "mismatched temporary owner") snapshot.temporaryReference.ownerId = "different";
		if (name === "nested model property") snapshot.skuKey = { sourceAssetId: "different" };
		if (name === "unknown root context field") snapshot.editContext.futureReference = "different";
		prepared.moderation.inputFingerprint = fingerprintGenerationQuoteSecurityPayload(prepared);
		const tx = {
			$queryRaw: vi.fn(async () => [{ now: new Date() }]),
			$executeRaw: vi.fn(),
			generationQuote: { create: vi.fn(async ({ data }) => data) },
			auditLog: { create: vi.fn() },
			generationJob: {
				findUnique: vi.fn(async () => {
					throw reached;
				}),
			},
		};
		const client = { $transaction: vi.fn(async (operation, _options) => operation(tx)) };
		await expect(createGenerationJobTransaction(input, client as never)).rejects.toBe(reached);
		expect(client.$transaction).toHaveBeenCalledOnce();
		expect(client.$transaction.mock.calls[0]![1]).toMatchObject({ isolationLevel: expected });
	});
	it.each([
		["CREDITS", "ReadCommitted"],
		["IMAGE_PASS", "Serializable"],
	] as const)(
		"inserts a prepared %s quote once in %s admission without rereading it",
		async (fundingSource, isolationLevel) => {
			const prepared = {
				quoteId: "merged-quote",
				ownerType: "USER" as const,
				ownerId: "owner",
				submittedByUserId: "owner",
				productKey: "image-nano-banana-pro",
				catalogVersion: "test",
				pricingVersion: "test",
				credits: 5n,
				costMicros: 100n,
				inputSnapshot: {
					kind: "text-to-image",
					prompt: "reviewed",
					submissionFingerprint: "a".repeat(64),
				},
				pricingSnapshot: { fundingSource, imagePassUnits: fundingSource === "IMAGE_PASS" ? 1 : 0 },
				expiresAt: new Date("2099-01-01"),
			};
			const tx = {
				$queryRaw: vi.fn(async () => [{ now: new Date() }]),
				$executeRaw: vi.fn(),
				generationQuote: {
					create: vi.fn(async ({ data }) => data),
					findUnique: vi.fn(),
				},
				auditLog: { create: vi.fn() },
				generationJob: {
					findUnique: vi.fn(async () => {
						throw reached;
					}),
				},
			};
			const client = { $transaction: vi.fn(async (operation, _options) => operation(tx)) };
			await expect(
				createGenerationJobTransaction(
					{
						ownerType: "USER",
						ownerId: "owner",
						submittedByUserId: "owner",
						quoteId: prepared.quoteId,
						idempotencyKey: "merged-request",
						preparedQuote: {
							...prepared,
							moderation: {
								decision: "ALLOW",
								provider: "test",
								ruleVersion: "rule",
								reasonCode: "NO_POLICY_MATCH",
								inputFingerprint: fingerprintGenerationQuoteSecurityPayload(prepared),
							},
						},
						inputAssetIds: [],
						expectedModerationRuleVersion: "rule",
					},
					client as never,
				),
			).rejects.toBe(reached);
			expect(client.$transaction).toHaveBeenCalledOnce();
			expect(client.$transaction.mock.calls[0]![1]).toMatchObject({ isolationLevel });
			expect(tx.generationQuote.create).toHaveBeenCalledOnce();
			expect(tx.generationQuote.findUnique).not.toHaveBeenCalled();
			expect(tx.auditLog.create).toHaveBeenCalledOnce();
		},
	);
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
		[
			{ kind: "text-to-image", prompt: "reviewed", submissionFingerprint: "a".repeat(64) },
			[],
			["ReadCommitted"],
		],
		[
			{ kind: "text-to-image", submissionFingerprint: { sourceAssetId: "asset" } },
			[],
			["ReadCommitted", "Serializable"],
		],
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
