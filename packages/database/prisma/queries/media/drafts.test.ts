import { describe, expect, it, vi } from "vitest";

import {
	claimGenerationDraftTransaction,
	createGenerationDraftTransaction,
	expireGenerationDrafts,
	finalizeGuestDraftFromReadyUploadTransaction,
} from "./drafts";

const currentDraftSelections = [
	{
		productKey: "image-nano-banana-2-lite",
		skuKey: "nano-banana-2-lite-1k",
		aspectRatio: "auto",
		controls: {},
	},
	{
		productKey: "image-nano-banana",
		skuKey: "nano-banana-default",
		aspectRatio: "1:1",
		controls: { outputFormat: "jpeg" },
	},
	...(["nano-banana-2-1k", "nano-banana-2-2k", "nano-banana-2-4k"] as const).map((skuKey) => ({
		productKey: "image-nano-banana-2" as const,
		skuKey,
		aspectRatio: "5:4" as const,
		controls: { outputFormat: "png" as const },
	})),
	...(["nano-banana-pro-1k", "nano-banana-pro-2k", "nano-banana-pro-4k"] as const).map(
		(skuKey) => ({
			productKey: "image-nano-banana-pro" as const,
			skuKey,
			aspectRatio: "4:5" as const,
			controls: { outputFormat: "jpeg" as const },
		}),
	),
	...(["gpt-image-1-5-medium", "gpt-image-1-5-high"] as const).map((skuKey) => ({
		productKey: "image-gpt-image-1-5" as const,
		skuKey,
		aspectRatio: "2:3" as const,
		controls: {},
	})),
	{
		productKey: "image-gpt-image-2",
		skuKey: "gpt-image-2-1k",
		aspectRatio: "5:4",
		controls: { background: "transparent" },
	},
	{
		productKey: "image-gpt-image-2",
		skuKey: "gpt-image-2-2k",
		aspectRatio: "1:1",
		controls: {},
	},
	{
		productKey: "image-gpt-image-2",
		skuKey: "gpt-image-2-4k",
		aspectRatio: "5:4",
		controls: {},
	},
	...(["seedream-4-5-basic-2k", "seedream-4-5-high-4k"] as const).map((skuKey) => ({
		productKey: "image-seedream-4-5" as const,
		skuKey,
		aspectRatio: "16:9" as const,
		controls: {},
	})),
	...(
		["seedream-5-lite-basic-2k", "seedream-5-lite-high-3k", "seedream-5-lite-ultra-4k"] as const
	).map((skuKey) => ({
		productKey: "image-seedream-5-lite" as const,
		skuKey,
		aspectRatio: "21:9" as const,
		controls: { outputFormat: "jpeg" as const },
	})),
	...(["seedream-5-pro-basic-1k", "seedream-5-pro-high-2k"] as const).map((skuKey) => ({
		productKey: "image-seedream-5-pro" as const,
		skuKey,
		aspectRatio: "3:2" as const,
		controls: { outputFormat: "png" as const },
	})),
] as const;

describe("createGenerationDraftTransaction", () => {
	it.each(currentDraftSelections)(
		"accepts the current $productKey / $skuKey selection without exposing a Provider field",
		async ({ productKey, skuKey, aspectRatio, controls }) => {
			const tx = {
				generationDraft: {
					create: vi.fn(async ({ data }) => ({ id: "draft_1", expiresAt: data.expiresAt })),
				},
			};
			const client = { $transaction: vi.fn((operation) => operation(tx)) };

			await expect(
				createGenerationDraftTransaction(
					{
						claimTokenHash: "a".repeat(64),
						productKey,
						input: {
							kind: "image-to-image",
							prompt: "Preserve the subject",
							skuKey,
							aspectRatio,
							...controls,
						},
						expiresAt: new Date("2026-09-08T00:00:00.000Z"),
					},
					client as never,
				),
			).resolves.toMatchObject({ id: "draft_1" });
			expect(tx.generationDraft.create).toHaveBeenCalledWith({
				data: expect.objectContaining({
					productKey,
					inputSnapshot: {
						kind: "image-to-image",
						prompt: "Preserve the subject",
						skuKey,
						aspectRatio,
						...controls,
					},
				}),
			});
		},
	);

	it.each([
		["a legacy product", "image-fast", { skuKey: "nano-banana-2-lite-1k", aspectRatio: "auto" }],
		[
			"a SKU borrowed from another product",
			"image-nano-banana",
			{ skuKey: "gpt-image-2-1k", aspectRatio: "1:1" },
		],
		[
			"an aspect ratio outside the selected cell",
			"image-gpt-image-2",
			{ skuKey: "gpt-image-2-4k", aspectRatio: "1:1" },
		],
		[
			"a control unsupported by the selected cell",
			"image-gpt-image-2",
			{ skuKey: "gpt-image-2-2k", aspectRatio: "1:1", background: "transparent" },
		],
		[
			"an invalid control value",
			"image-nano-banana",
			{ skuKey: "nano-banana-default", aspectRatio: "1:1", outputFormat: "webp" },
		],
		[
			"a server-only field",
			"image-nano-banana",
			{
				skuKey: "nano-banana-default",
				aspectRatio: "1:1",
				providerModelId: "must-not-persist",
			},
		],
	] as const)("rejects %s before opening a transaction", async (_label, productKey, selection) => {
		const transaction = vi.fn();

		await expect(
			createGenerationDraftTransaction(
				{
					claimTokenHash: "a".repeat(64),
					productKey,
					input: {
						kind: "image-to-image",
						prompt: "Preserve the subject",
						...selection,
					},
					expiresAt: new Date("2026-09-08T00:00:00.000Z"),
				},
				{ $transaction: transaction } as never,
			),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
		expect(transaction).not.toHaveBeenCalled();
	});
});

describe("finalizeGuestDraftFromReadyUploadTransaction", () => {
	it("rejects a globally valid but model-matrix-invalid SKU and aspect combination", async () => {
		const transaction = vi.fn();
		const now = new Date("2026-08-31T00:00:00.000Z");

		await expect(
			finalizeGuestDraftFromReadyUploadTransaction(
				{
					sessionId: "session_1",
					completionTokenHash: "b".repeat(64),
					consumedTokenHash: "c".repeat(64),
					claimTokenHash: "d".repeat(64),
					capabilityVersion: "guest-v1",
					promotionPeriod: "launch",
					maximumOutstandingBootstraps: 25,
					productKey: "image-gpt-image-2",
					skuKey: "gpt-image-2-4k",
					prompt: "Preserve the product details",
					aspectRatio: "1:1",
					expiresAt: new Date("2026-09-01T00:00:00.000Z"),
					verification: {
						provider: "sightengine",
						ruleVersion: "rule-v1",
						policyVersion: "policy-v1",
						now,
					},
				},
				{ $transaction: transaction } as never,
			),
		).rejects.toThrow("GUEST_PRODUCT_UNAVAILABLE");
		expect(transaction).not.toHaveBeenCalled();
	});

	it("persists the server-validated product and SKU on the private draft", async () => {
		const now = new Date("2026-08-31T00:00:00.000Z");
		const validUntil = new Date("2026-09-01T00:00:00.000Z");
		const checksum = "a".repeat(64);
		const asset = {
			id: "asset_1",
			ownerId: "guest_owner",
			status: "READY",
			deletedAt: null,
			kind: "INPUT",
			checksum,
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "sightengine",
			verificationProviderTaskId: "task_1",
			verificationRuleVersion: "rule-v1",
			verificationPolicyVersion: "policy-v1",
			verificationValidUntil: validUntil,
			moderationResults: [
				{
					status: "APPROVED",
					assetChecksum: checksum,
					verificationGeneration: 1,
					attemptNumber: 1,
					evidenceKind: "INPUT",
					provider: "sightengine",
					providerTaskId: "task_1",
					ruleVersion: "rule-v1",
					policyVersion: "policy-v1",
					validUntil,
				},
			],
			jobBindings: [],
		};
		const tx = {
			$executeRaw: vi.fn(),
			mediaUploadSession: {
				findFirst: vi.fn().mockResolvedValue({ id: "session_1", assetId: asset.id, asset }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			generationDraft: {
				create: vi.fn(async ({ data }) => ({ id: "draft_1", expiresAt: data.expiresAt })),
			},
			guestSessionBootstrap: {
				count: vi.fn().mockResolvedValue(0),
				create: vi.fn().mockResolvedValue({ id: "bootstrap_1" }),
			},
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await finalizeGuestDraftFromReadyUploadTransaction(
			{
				sessionId: "session_1",
				completionTokenHash: "b".repeat(64),
				consumedTokenHash: "c".repeat(64),
				claimTokenHash: "d".repeat(64),
				capabilityVersion: "guest-v1",
				promotionPeriod: "launch",
				maximumOutstandingBootstraps: 25,
				productKey: "image-seedream-5-pro",
				skuKey: "seedream-5-pro-high-2k",
				prompt: "Preserve the product details",
				aspectRatio: "16:9",
				outputFormat: "jpeg",
				expiresAt: validUntil,
				verification: {
					provider: "sightengine",
					ruleVersion: "rule-v1",
					policyVersion: "policy-v1",
					now,
				},
			} as never,
			client as never,
		);

		expect(tx.generationDraft.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				productKey: "image-seedream-5-pro",
				inputSnapshot: {
					kind: "image-to-image",
					prompt: "Preserve the product details",
					skuKey: "seedream-5-pro-high-2k",
					aspectRatio: "16:9",
					outputFormat: "jpeg",
				},
			}),
		});
	});

	it("rejects a non-billing control that is unavailable on the selected cell", async () => {
		const transaction = vi.fn();

		await expect(
			finalizeGuestDraftFromReadyUploadTransaction(
				{
					sessionId: "session_1",
					completionTokenHash: "b".repeat(64),
					consumedTokenHash: "c".repeat(64),
					claimTokenHash: "d".repeat(64),
					capabilityVersion: "guest-v1",
					promotionPeriod: "launch",
					maximumOutstandingBootstraps: 25,
					productKey: "image-gpt-image-2",
					skuKey: "gpt-image-2-2k",
					prompt: "Preserve the product details",
					aspectRatio: "1:1",
					background: "transparent",
					expiresAt: new Date("2026-09-01T00:00:00.000Z"),
					verification: {
						provider: "sightengine",
						ruleVersion: "rule-v1",
						policyVersion: "policy-v1",
						now: new Date("2026-08-31T00:00:00.000Z"),
					},
				} as never,
				{ $transaction: transaction } as never,
			),
		).rejects.toThrow("GUEST_PRODUCT_UNAVAILABLE");
		expect(transaction).not.toHaveBeenCalled();
	});
});

describe("claimGenerationDraftTransaction", () => {
	it("atomically consumes one active token and transfers its temporary asset to the user", async () => {
		const tx = {
			generationDraft: {
				findFirst: vi.fn().mockResolvedValue({
					id: "draft_1",
					ownerType: "USER",
					ownerId: "draft:draft_1",
					submittedByUserId: "draft:draft_1",
					status: "ACTIVE",
					claimTokenHash: "hash",
					assetId: "asset_1",
					inputSnapshot: { kind: "image-to-image", prompt: "Soften the background" },
					productKey: "image-fast",
					expiresAt: new Date("2026-08-14T01:00:00Z"),
				}),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			mediaAsset: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
			outboxEvent: { create: vi.fn().mockResolvedValue({ id: "event_1" }) },
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		const claimed = await claimGenerationDraftTransaction(
			{
				claimTokenHash: "hash",
				userId: "user_1",
				now: new Date("2026-08-14T00:00:00Z"),
				allowedProductKeys: ["image-nano-banana-2-lite", "image-gpt-image-2"],
			},
			client as never,
		);

		expect(claimed).toEqual({
			id: "draft_1",
			productKey: "image-nano-banana-2-lite",
			input: {
				kind: "image-to-image",
				prompt: "Soften the background",
				skuKey: "nano-banana-2-lite-1k",
				aspectRatio: "auto",
				sourceAssetId: "asset_1",
			},
		});
		expect(tx.generationDraft.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "draft_1", status: "ACTIVE" }),
				data: expect.objectContaining({
					ownerType: "USER",
					ownerId: "user_1",
					submittedByUserId: "user_1",
					status: "SUBMITTED",
					productKey: "image-nano-banana-2-lite",
					inputSnapshot: expect.objectContaining({
						skuKey: "nano-banana-2-lite-1k",
					}),
				}),
			}),
		);
		expect(tx.mediaAsset.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "asset_1", ownerId: "draft:draft_1", status: "VERIFYING" },
				data: { ownerType: "USER", ownerId: "user_1" },
			}),
		);
		expect(tx.outboxEvent.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					eventType: "MEDIA_ASSET_VERIFY",
					dedupeKey: "media-asset-verify:asset_1",
				}),
			}),
		);
	});

	it("rejects a replay when the atomic state change loses", async () => {
		const activeDraft = {
			id: "draft_1",
			ownerType: "USER",
			ownerId: "draft:draft_1",
			submittedByUserId: "draft:draft_1",
			status: "ACTIVE",
			claimTokenHash: "hash",
			assetId: null,
			inputSnapshot: { kind: "image-to-image", prompt: "Soften the background" },
			productKey: "image-fast",
			expiresAt: new Date("2026-08-14T01:00:00Z"),
		};
		const tx = {
			generationDraft: {
				findFirst: vi.fn().mockResolvedValueOnce(activeDraft).mockResolvedValueOnce(null),
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await expect(
			claimGenerationDraftTransaction(
				{
					claimTokenHash: "hash",
					userId: "user_1",
					now: new Date("2026-08-14T00:00:00Z"),
					allowedProductKeys: ["image-nano-banana-2-lite", "image-gpt-image-2"],
				},
				client as never,
			),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
	});

	it("returns the claimed draft when the same user loses a concurrent claim race", async () => {
		const activeDraft = {
			id: "draft_1",
			ownerType: "USER",
			ownerId: "draft:draft_1",
			submittedByUserId: "draft:draft_1",
			status: "ACTIVE",
			assetId: "asset_1",
			claimTokenHash: "hash",
			inputSnapshot: { kind: "image-to-image", prompt: "Soften the background" },
			productKey: "image-fast",
			expiresAt: new Date("2026-08-14T01:00:00Z"),
		};
		const submittedDraft = {
			...activeDraft,
			ownerId: "user_1",
			submittedByUserId: "user_1",
			status: "SUBMITTED",
		};
		const tx = {
			generationDraft: {
				findFirst: vi.fn().mockResolvedValueOnce(activeDraft).mockResolvedValueOnce(submittedDraft),
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
			mediaAsset: { updateMany: vi.fn() },
			outboxEvent: { create: vi.fn() },
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await expect(
			claimGenerationDraftTransaction(
				{
					claimTokenHash: "hash",
					userId: "user_1",
					now: new Date("2026-08-14T00:00:00Z"),
					allowedProductKeys: ["image-nano-banana-2-lite", "image-gpt-image-2"],
				},
				client as never,
			),
		).resolves.toEqual({
			id: "draft_1",
			productKey: "image-nano-banana-2-lite",
			input: {
				kind: "image-to-image",
				prompt: "Soften the background",
				skuKey: "nano-banana-2-lite-1k",
				aspectRatio: "auto",
				sourceAssetId: "asset_1",
			},
		});
		expect(tx.mediaAsset.updateMany).not.toHaveBeenCalled();
		expect(tx.outboxEvent.create).not.toHaveBeenCalled();
	});

	it("normalizes a legacy Quality draft to the current GPT Image 2 1K default", async () => {
		const submittedDraft = {
			id: "draft_1",
			ownerType: "USER",
			ownerId: "user_1",
			submittedByUserId: "user_1",
			status: "SUBMITTED",
			assetId: "asset_1",
			claimTokenHash: "hash",
			inputSnapshot: {
				kind: "image-to-image",
				prompt: "Soften the background",
				aspectRatio: "auto",
			},
			productKey: "image-quality",
			expiresAt: new Date("2026-08-14T01:00:00Z"),
		};
		const tx = {
			generationDraft: {
				findFirst: vi.fn().mockResolvedValue(submittedDraft),
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
			mediaAsset: { updateMany: vi.fn() },
			outboxEvent: { create: vi.fn() },
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await expect(
			claimGenerationDraftTransaction(
				{
					claimTokenHash: "hash",
					userId: "user_1",
					now: new Date("2026-08-14T00:00:00Z"),
					allowedProductKeys: ["image-nano-banana-2-lite", "image-gpt-image-2"],
				},
				client as never,
			),
		).resolves.toEqual({
			id: "draft_1",
			productKey: "image-gpt-image-2",
			input: {
				kind: "image-to-image",
				prompt: "Soften the background",
				skuKey: "gpt-image-2-1k",
				aspectRatio: "auto",
				sourceAssetId: "asset_1",
			},
		});
		expect(tx.generationDraft.updateMany).not.toHaveBeenCalled();
		expect(tx.mediaAsset.updateMany).not.toHaveBeenCalled();
		expect(tx.outboxEvent.create).not.toHaveBeenCalled();
	});

	it("accepts a current GPT Image 2 4K draft with its model-specific 5:4 ratio", async () => {
		const submittedDraft = {
			id: "draft_1",
			ownerType: "USER",
			ownerId: "user_1",
			submittedByUserId: "user_1",
			status: "SUBMITTED",
			assetId: "asset_1",
			claimTokenHash: "hash",
			inputSnapshot: {
				kind: "image-to-image",
				prompt: "Preserve the product framing",
				skuKey: "gpt-image-2-4k",
				aspectRatio: "5:4",
			},
			productKey: "image-gpt-image-2",
			expiresAt: new Date("2026-08-14T01:00:00Z"),
		};
		const tx = {
			generationDraft: { findFirst: vi.fn().mockResolvedValue(submittedDraft) },
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await expect(
			claimGenerationDraftTransaction(
				{
					claimTokenHash: "hash",
					userId: "user_1",
					now: new Date("2026-08-14T00:00:00Z"),
					allowedProductKeys: ["image-gpt-image-2"],
				},
				client as never,
			),
		).resolves.toMatchObject({
			productKey: "image-gpt-image-2",
			input: { skuKey: "gpt-image-2-4k", aspectRatio: "5:4" },
		});
	});

	it.each(currentDraftSelections)(
		"returns a browser-safe current $productKey / $skuKey draft",
		async ({ productKey, skuKey, aspectRatio, controls }) => {
			const submittedDraft = {
				id: "draft_1",
				ownerType: "USER",
				ownerId: "user_1",
				submittedByUserId: "user_1",
				status: "SUBMITTED",
				assetId: "asset_1",
				claimTokenHash: "hash",
				inputSnapshot: {
					kind: "image-to-image",
					prompt: "Preserve the subject",
					skuKey,
					aspectRatio,
					...controls,
				},
				productKey,
				expiresAt: new Date("2026-09-08T01:00:00.000Z"),
			};
			const tx = { generationDraft: { findFirst: vi.fn().mockResolvedValue(submittedDraft) } };
			const client = { $transaction: vi.fn((operation) => operation(tx)) };

			await expect(
				claimGenerationDraftTransaction(
					{
						claimTokenHash: "hash",
						userId: "user_1",
						now: new Date("2026-09-08T00:00:00.000Z"),
						allowedProductKeys: [productKey],
					},
					client as never,
				),
			).resolves.toEqual({
				id: "draft_1",
				productKey,
				input: {
					kind: "image-to-image",
					prompt: "Preserve the subject",
					skuKey,
					aspectRatio,
					...controls,
					sourceAssetId: "asset_1",
				},
			});
		},
	);

	it("does not return provider, cost, credential, or unknown durable JSON fields", async () => {
		const tx = {
			generationDraft: {
				findFirst: vi.fn().mockResolvedValue({
					id: "draft_1",
					ownerType: "USER",
					ownerId: "user_1",
					submittedByUserId: "user_1",
					status: "SUBMITTED",
					assetId: "asset_1",
					claimTokenHash: "hash",
					inputSnapshot: {
						kind: "image-to-image",
						prompt: "Preserve the subject",
						skuKey: "nano-banana-default",
						aspectRatio: "1:1",
						outputFormat: "jpeg",
						providerModelId: "must-not-leak",
						providerCostMicros: 20_000,
						credentials: "must-not-leak",
						unknown: { private: true },
					},
					productKey: "image-nano-banana",
					expiresAt: new Date("2026-09-08T01:00:00.000Z"),
				}),
			},
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		const claimed = await claimGenerationDraftTransaction(
			{
				claimTokenHash: "hash",
				userId: "user_1",
				now: new Date("2026-09-08T00:00:00.000Z"),
				allowedProductKeys: ["image-nano-banana"],
			},
			client as never,
		);

		expect(claimed.input).toEqual({
			kind: "image-to-image",
			prompt: "Preserve the subject",
			skuKey: "nano-banana-default",
			aspectRatio: "1:1",
			outputFormat: "jpeg",
			sourceAssetId: "asset_1",
		});
		expect(JSON.stringify(claimed)).not.toMatch(/provider|cost|credential|unknown|private/i);
	});

	it("rejects a stored non-billing control that the selected cell does not support", async () => {
		const tx = {
			generationDraft: {
				findFirst: vi.fn().mockResolvedValue({
					id: "draft_1",
					ownerType: "USER",
					ownerId: "user_1",
					submittedByUserId: "user_1",
					status: "SUBMITTED",
					assetId: "asset_1",
					claimTokenHash: "hash",
					inputSnapshot: {
						kind: "image-to-image",
						prompt: "Preserve the subject",
						skuKey: "gpt-image-2-2k",
						aspectRatio: "1:1",
						background: "transparent",
					},
					productKey: "image-gpt-image-2",
					expiresAt: new Date("2026-09-08T01:00:00.000Z"),
				}),
			},
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await expect(
			claimGenerationDraftTransaction(
				{
					claimTokenHash: "hash",
					userId: "user_1",
					now: new Date("2026-09-08T00:00:00.000Z"),
					allowedProductKeys: ["image-gpt-image-2"],
				},
				client as never,
			),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
	});

	it("rejects a current GPT Image 2 draft whose ratio is outside its SKU matrix", async () => {
		const submittedDraft = {
			id: "draft_1",
			ownerType: "USER",
			ownerId: "user_1",
			submittedByUserId: "user_1",
			status: "SUBMITTED",
			assetId: "asset_1",
			claimTokenHash: "hash",
			inputSnapshot: {
				kind: "image-to-image",
				prompt: "Preserve the product framing",
				skuKey: "gpt-image-2-2k",
				aspectRatio: "3:1",
			},
			productKey: "image-gpt-image-2",
			expiresAt: new Date("2026-08-14T01:00:00Z"),
		};
		const tx = {
			generationDraft: { findFirst: vi.fn().mockResolvedValue(submittedDraft) },
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await expect(
			claimGenerationDraftTransaction(
				{
					claimTokenHash: "hash",
					userId: "user_1",
					now: new Date("2026-08-14T00:00:00Z"),
					allowedProductKeys: ["image-gpt-image-2"],
				},
				client as never,
			),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
	});

	it("rejects a repeated claim after another user submitted the draft", async () => {
		const tx = {
			generationDraft: {
				findFirst: vi.fn().mockResolvedValue(null),
				updateMany: vi.fn(),
			},
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await expect(
			claimGenerationDraftTransaction(
				{
					claimTokenHash: "hash",
					userId: "user_2",
					now: new Date("2026-08-14T00:00:00Z"),
					allowedProductKeys: ["image-nano-banana-2-lite", "image-gpt-image-2"],
				},
				client as never,
			),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
		expect(tx.generationDraft.updateMany).not.toHaveBeenCalled();
	});

	it("filters the atomic claim by currently allowed stable product keys", async () => {
		const tx = {
			generationDraft: {
				findFirst: vi.fn().mockResolvedValue(null),
				updateMany: vi.fn(),
			},
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await expect(
			claimGenerationDraftTransaction(
				{
					claimTokenHash: "hash",
					userId: "user_1",
					now: new Date("2026-08-14T00:00:00Z"),
					allowedProductKeys: ["image-nano-banana-2-lite", "image-gpt-image-2"],
				},
				client as never,
			),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
		expect(tx.generationDraft.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					productKey: {
						in: ["image-nano-banana-2-lite", "image-gpt-image-2", "image-fast", "image-quality"],
					},
				}),
			}),
		);
	});
});

describe("expireGenerationDrafts", () => {
	it("limits expiry to the requested draft candidates", async () => {
		const tx = {
			generationDraft: {
				findMany: vi.fn(async () => []),
			},
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };
		const now = new Date("2026-08-14T00:00:00Z");

		await expect(
			expireGenerationDrafts(now, client as never, ["draft_e2e_1", "draft_e2e_2"]),
		).resolves.toBe(0);
		expect(tx.generationDraft.findMany).toHaveBeenCalledWith({
			where: {
				id: { in: ["draft_e2e_1", "draft_e2e_2"] },
				status: "ACTIVE",
				expiresAt: { lte: now },
			},
			select: { id: true, assetId: true, ownerId: true },
		});
	});

	it("queues physical deletion for each expired anonymous draft asset", async () => {
		const tx = {
			generationDraft: {
				findMany: vi.fn(async () => [
					{ id: "draft_1", assetId: "asset_1", ownerId: "anonymous:subject" },
				]),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			mediaAsset: {
				findUnique: vi.fn(async () => ({
					objectKey: "users/anonymous/assets/asset_1/original.png",
				})),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			outboxEvent: { create: vi.fn(async ({ data }) => data) },
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };
		await expect(
			expireGenerationDrafts(new Date("2026-08-14T00:00:00Z"), client as never),
		).resolves.toBe(1);
		expect(tx.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: "MEDIA_OBJECT_DELETE",
				dedupeKey: "media-draft-expire-cleanup:draft_1",
			}),
		});
	});

	it("does not delete an asset when a concurrent claim already consumed the draft", async () => {
		const tx = {
			generationDraft: {
				findMany: vi.fn(async () => [
					{ id: "draft_1", assetId: "asset_1", ownerId: "anonymous:subject" },
				]),
				updateMany: vi.fn(async () => ({ count: 0 })),
			},
			mediaAsset: {
				findUnique: vi.fn(),
				updateMany: vi.fn(),
			},
			outboxEvent: { create: vi.fn() },
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await expect(
			expireGenerationDrafts(new Date("2026-08-14T00:00:00Z"), client as never),
		).resolves.toBe(0);
		expect(tx.mediaAsset.findUnique).not.toHaveBeenCalled();
		expect(tx.mediaAsset.updateMany).not.toHaveBeenCalled();
		expect(tx.outboxEvent.create).not.toHaveBeenCalled();
	});
});
