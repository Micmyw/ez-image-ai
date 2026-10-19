import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({
	getDatabaseClient: vi.fn(),
}));
vi.mock("./guest-bootstrap", () => ({
	bindGuestBootstrapToExistingOwner: vi.fn(async () => undefined),
	createGuestSessionBootstrapWithClaimFence: vi.fn(),
}));

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
		subscription: { findMany: vi.fn(async () => []) },
		billingPeriod: { fields: { paidAmount: "paidAmount" } },
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
describe("unaccepted guest input account retention", () => {
	it("defaults the producer upgrade off until receiver rollout and drain are confirmed", async () => {
		vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "false");
		const { asset, tx } = fixture();
		await transferGuestGenerationDraftToRegisteredUserInTransaction(input, tx as never);
		expect(asset).toMatchObject({
			ownerId: "account",
			retentionClass: "GUEST_TRIAL",
			deleteAfter: expect.any(Date),
		});
	});
	it.each(["READY", "VERIFYING"])(
		"adopts a live exclusive %s input with account retention when enabled",
		async (status) => {
			vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
			const { asset, tx } = fixture({ status });
			await transferGuestGenerationDraftToRegisteredUserInTransaction(input, tx as never);
			expect(asset).toMatchObject({
				ownerId: "account",
				retentionClass: "ACCOUNT",
				deleteAfter: null,
				status,
			});
		},
	);
	it("cannot adopt a cleanup tombstone even when the link request started before its deadline", async () => {
		vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
		const { tx } = fixture({ status: "DELETED", deletedAt: now });
		await expect(
			transferGuestGenerationDraftToRegisteredUserInTransaction(input, tx as never),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
		expect(tx.storageUsageReservation.update).not.toHaveBeenCalled();
	});
	it("uses the current database time after locking rather than the original request time", async () => {
		vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
		const { tx } = fixture();
		tx.$queryRaw.mockResolvedValue([{ now: new Date(now.getTime() + 120_000) }]);
		await expect(
			transferGuestGenerationDraftToRegisteredUserInTransaction(input, tx as never),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
		expect(tx.storageUsageReservation.update).not.toHaveBeenCalled();
	});
	it.each(["trial", "binding"])(
		"does not upgrade an input already used by a guest %s",
		async (kind) => {
			vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
			const { tx } = fixture();
			if (kind === "trial")
				tx.guestMediaTrial.findFirst.mockResolvedValue({ id: "trial" } as never);
			else tx.generationJobAsset.findFirst.mockResolvedValue({ jobId: "accepted" } as never);
			await expect(
				transferGuestGenerationDraftToRegisteredUserInTransaction(input, tx as never),
			).rejects.toThrow("DRAFT_UNAVAILABLE");
			expect(tx.storageUsageReservation.update).not.toHaveBeenCalled();
		},
	);
	it("requires an exclusive input rather than extending another live draft's retention", async () => {
		vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
		const { tx } = fixture();
		tx.generationDraft.findFirst.mockImplementation(async ({ where }) =>
			where.assetId && typeof where.id !== "string"
				? ({ id: "other-draft" } as never)
				: fixture().tx.generationDraft.findFirst({ where }),
		);
		await expect(
			transferGuestGenerationDraftToRegisteredUserInTransaction(input, tx as never),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
		expect(tx.storageUsageReservation.update).not.toHaveBeenCalled();
	});
	it("also upgrades the ordinary registered ACTIVE-draft claim entry", async () => {
		vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
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
			retentionClass: "ACCOUNT",
			deleteAfter: null,
			ownerId: "account",
		});
	});
	it("keeps anonymous bootstrap claims in guest retention even with the producer enabled", async () => {
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
	it("checks the actual next owner even if the registered claim helper is called directly", async () => {
		vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
		const { asset, tx } = fixture({}, { status: "ACTIVE" });
		tx.user.findUnique.mockResolvedValue({ isAnonymous: true });
		await expect(
			claimGenerationDraftTransaction(
				{
					claimTokenHash: "claim",
					userId: "account",
					now,
					allowedProductKeys: ["image-nano-banana-2-lite"],
				},
				{ $transaction: <T>(fn: (transaction: typeof tx) => Promise<T>) => fn(tx) } as never,
			),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
		expect(asset.retentionClass).toBe("GUEST_TRIAL");
	});
	it("checks the claimed draft deadline after lock waiting as well as the asset deadline", async () => {
		vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
		const { tx } = fixture({ deleteAfter: new Date(now.getTime() + 300_000) });
		tx.$queryRaw.mockResolvedValue([{ now: new Date(now.getTime() + 120_000) }]);
		await expect(
			transferGuestGenerationDraftToRegisteredUserInTransaction(input, tx as never),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
	});
	it("retires only the exact still-pending guest deadline event without a physical cleanup receipt", async () => {
		vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
		const { tx } = fixture();
		await transferGuestGenerationDraftToRegisteredUserInTransaction(input, tx as never);
		expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				dedupeKey: "guest-media-deadline-cleanup:asset",
				status: "PENDING",
				eventType: "MEDIA_OBJECT_DELETE",
				aggregateType: "MEDIA_ASSET",
				aggregateId: "asset",
				availableAt: new Date(now.getTime() + 60_000),
				payload: { path: ["objectKey"], equals: "final-key" },
				AND: [{ payload: { path: ["assetId"], equals: "asset" } }],
			}),
			data: expect.objectContaining({
				status: "PROCESSED",
				processedAt: now,
				lastError: "SUPERSEDED_BY_ACCOUNT_INPUT_PROMOTION",
			}),
		});
	});
});
