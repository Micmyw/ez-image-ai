import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({
	getDatabaseClient: vi.fn(),
}));
vi.mock("./guest-bootstrap", () => ({
	bindGuestBootstrapToExistingOwner: vi.fn(async () => undefined),
	createGuestSessionBootstrapWithClaimFence: vi.fn(),
}));

import { accountInputRetentionPatch } from "./account-input-promotion";
import {
	claimGenerationDraftTransaction,
	claimGuestGenerationDraftTransaction,
	transferGuestGenerationDraftToRegisteredUserInTransaction,
} from "./drafts";

const now = new Date("2026-10-19T12:00:00Z");
function fixture(
	assetPatch: Record<string, unknown> = {},
	draftPatch: Record<string, unknown> = {},
) {
	const asset = {
		id: "asset",
		ownerId: "guest",
		kind: "INPUT",
		status: "READY",
		deletedAt: null,
		retentionClass: "GUEST_TRIAL",
		deleteAfter: new Date(now.getTime() + 60_000),
		objectKey: "final-key",
		byteSize: 10n,
		uploadSessions: [{ id: "session" }],
		...assetPatch,
	};
	const draft = {
		id: "draft",
		assetId: "asset",
		status: "SUBMITTED",
		ownerId: "guest",
		submittedByUserId: "guest",
		expiresAt: new Date(now.getTime() + 60_000),
		productKey: "image-nano-banana-2-lite",
		inputSnapshot: {
			kind: "image-to-image",
			prompt: "Keep the subject",
			skuKey: "nano-banana-2-lite-1k",
			aspectRatio: "auto",
		},
		...draftPatch,
	};
	const tx = {
		$executeRaw: vi.fn(async () => 1),
		$queryRaw: vi.fn(async () => [{ now }]),
		user: { findUnique: vi.fn(async () => ({ isAnonymous: false })) },
		subscription: { findMany: vi.fn(async () => []) },
		billingPeriod: { fields: { paidAmount: "paidAmount" } },
		generationDraft: {
			findFirst: vi.fn(async ({ where }) => {
				if (
					(where.assetId && typeof where.id !== "string") ||
					(where.expiresAt && draft.expiresAt <= where.expiresAt.gt) ||
					(where.ownerId && draft.ownerId !== where.ownerId)
				)
					return null;
				return { ...draft };
			}),
			updateMany: vi.fn(async ({ data }) => {
				Object.assign(draft, data);
				return { count: 1 };
			}),
		},
		mediaAsset: {
			findFirst: vi.fn(async () => asset),
			updateMany: vi.fn(async ({ where, data }) => {
				if (asset.status !== where.status || asset.deletedAt) return { count: 0 };
				Object.assign(asset, data);
				return { count: 1 };
			}),
		},
		guestMediaTrial: { findFirst: vi.fn(async () => null) },
		generationJobAsset: { findFirst: vi.fn(async () => null) },
		storageUsageReservation: {
			findUnique: vi.fn(async () => ({
				id: "reservation",
				ownerType: "USER",
				ownerId: "guest",
				status: "COMMITTED",
				bytes: 10n,
			})),
			aggregate: vi.fn(async () => ({ _sum: { bytes: 0n } })),
			update: vi.fn(async () => undefined),
		},
		outboxEvent: {
			create: vi.fn(async () => undefined),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
	};
	return { asset, tx };
}
const input = { draftId: "draft", anonymousOwnerId: "guest", registeredUserId: "account", now };
afterEach(() => vi.unstubAllEnvs());
describe("retired same-key guest input retention", () => {
	it.each(["true", "false", ""])(
		"never adopts the original key for legacy flag %j",
		async (flag) => {
			vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", flag);
			const { asset, tx } = fixture();
			expect(
				await accountInputRetentionPatch(
					{ draftId: "draft", nextOwnerId: "account", asset },
					tx as never,
				),
			).toEqual({});
			expect(tx.$queryRaw).not.toHaveBeenCalled();
			expect(tx.outboxEvent.updateMany).not.toHaveBeenCalled();
		},
	);
	it.each(["READY", "VERIFYING"])(
		"preserves the original %s guest deadline when the new copy protocol is off",
		async (status) => {
			vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
			vi.stubEnv("ACCOUNT_INPUT_COPY_ENABLED", "false");
			const { asset, tx } = fixture({ status });
			const deadline = asset.deleteAfter;
			await transferGuestGenerationDraftToRegisteredUserInTransaction(input, tx as never);
			expect(asset).toMatchObject({
				ownerId: "account",
				retentionClass: "GUEST_TRIAL",
				deleteAfter: deadline,
				status,
			});
			expect(tx.outboxEvent.updateMany).not.toHaveBeenCalled();
		},
	);
	it("cannot transfer a cleanup tombstone", async () => {
		vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
		const { tx } = fixture({ status: "DELETED", deletedAt: now });
		await expect(
			transferGuestGenerationDraftToRegisteredUserInTransaction(input, tx as never),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
		expect(tx.storageUsageReservation.update).not.toHaveBeenCalled();
	});
	it("keeps the ordinary registered claim in guest retention when the fresh copy protocol is off", async () => {
		vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
		vi.stubEnv("ACCOUNT_INPUT_COPY_ENABLED", "false");
		const { asset, tx } = fixture({}, { status: "ACTIVE" });
		await claimGenerationDraftTransaction(
			{
				claimTokenHash: "claim",
				userId: "account",
				now,
				allowedProductKeys: ["image-nano-banana-2-lite"],
			},
			{ $transaction: <T>(fn: (transaction: typeof tx) => Promise<T>) => fn(tx) } as never,
		);
		expect(asset).toMatchObject({
			retentionClass: "GUEST_TRIAL",
			deleteAfter: expect.any(Date),
			ownerId: "account",
		});
	});
	it("keeps anonymous bootstrap claims in guest retention", async () => {
		vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
		const { asset, tx } = fixture({}, { status: "ACTIVE" });
		tx.user.findUnique.mockResolvedValue({ isAnonymous: true });
		await claimGuestGenerationDraftTransaction(
			{
				claimTokenHash: "claim",
				userId: "guest",
				now,
				allowedProductKeys: ["image-nano-banana-2-lite"],
			},
			{ $transaction: <T>(fn: (transaction: typeof tx) => Promise<T>) => fn(tx) } as never,
		);
		expect(asset).toMatchObject({
			retentionClass: "GUEST_TRIAL",
			deleteAfter: expect.any(Date),
			ownerId: "guest",
		});
	});
	it("checks the actual registered owner even when called directly", async () => {
		const { asset, tx } = fixture();
		tx.user.findUnique.mockResolvedValue({ isAnonymous: true });
		await expect(
			transferGuestGenerationDraftToRegisteredUserInTransaction(input, tx as never),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
		expect(asset.retentionClass).toBe("GUEST_TRIAL");
	});
});
