import { describe, expect, it, vi } from "vitest";

// Only isolate process-global client construction; exercise real transactions,
// subscription eligibility, quota resolution, metering and reservation writes.
vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("explicit client required");
	},
}));

import {
	createMediaUploadSessionTransaction,
	reserveGenerationOutputStorageTransaction,
} from "./assets";
import { reserveTemporaryReference } from "./temporary-references";

const upload = {
	assetId: "asset-a",
	sessionId: "session-a",
	ownerType: "USER" as const,
	ownerId: "owner-a",
	kind: "INPUT" as const,
	objectKey: "users/owner-a/final.png",
	stagingObjectKey: "users/owner-a/staging.png",
	mimeType: "image/png",
	expectedBytes: 60n,
	tokenHash: "hash-a",
	expiresAt: new Date(Date.now() + 60_000),
	multipartUploadId: null,
	limits: { maximumActiveSessions: 5, maximumReservedBytes: 100n },
};

describe("subscriber storage transaction boundaries", () => {
	it("meters uploads above the free quota for a paid owner", async () => {
		const f = fixture(true);
		await createMediaUploadSessionTransaction(upload, f.client as never);
		expect(f.reservations).toEqual([
			expect.objectContaining({
				ownerId: "owner-a",
				bytes: 60n,
				referenceKey: "media-upload:session-a",
			}),
		]);
	});
	it("keeps the free upload aggregate quota", async () => {
		const f = fixture(false);
		await expect(createMediaUploadSessionTransaction(upload, f.client as never)).rejects.toThrow(
			"STORAGE_QUOTA_EXCEEDED",
		);
		expect(f.reservations).toEqual([]);
	});
	it("still refuses excess pending uploads for subscribers", async () => {
		const f = fixture(true, 5);
		await expect(createMediaUploadSessionTransaction(upload, f.client as never)).rejects.toThrow(
			"ACTIVE_UPLOAD_SESSION_LIMIT_EXCEEDED",
		);
		expect(f.reservations).toEqual([]);
	});
	it("still refuses zero-byte uploads and non-USER owners", async () => {
		const f = fixture(true);
		await expect(
			createMediaUploadSessionTransaction({ ...upload, expectedBytes: 0n }, f.client as never),
		).rejects.toThrow("Expected upload bytes must be positive");
		await expect(
			createMediaUploadSessionTransaction(
				{ ...upload, ownerType: "ORGANIZATION" } as never,
				f.client as never,
			),
		).rejects.toThrow("USER owners only");
	});
	it.each([true, false])("temporary references keep byte accounting (paid=%s)", async (paid) => {
		const f = fixture(paid);
		const request = reserveTemporaryReference(
			{
				ownerId: "owner-a",
				assetId: "asset-a",
				bytes: 60,
				expiresAt: upload.expiresAt,
				maximumBytes: 100n,
			},
			f.client as never,
		);
		if (paid) {
			await request;
			expect(f.reservations).toEqual([expect.objectContaining({ bytes: 60n, ownerId: "owner-a" })]);
		} else await expect(request).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
	});
	it("temporary references keep their pending limit for subscribers", async () => {
		const f = fixture(true, 5);
		await expect(
			reserveTemporaryReference(
				{
					ownerId: "owner-a",
					assetId: "asset-a",
					bytes: 60,
					expiresAt: upload.expiresAt,
					maximumBytes: 100n,
				},
				f.client as never,
			),
		).rejects.toThrow("ACTIVE_UPLOAD_SESSION_LIMIT_EXCEEDED");
	});
	it("finishes metered output admitted while subscribed after subscription expiry", async () => {
		const f = fixture(false);
		await expect(
			reserveGenerationOutputStorageTransaction(
				{
					assetId: "asset-a",
					ownerId: "owner-a",
					transferToken: "transfer",
					bytes: 60n,
					maximumStorageBytes: 100n,
				},
				f.client as never,
			),
		).resolves.toMatchObject({ outcome: "RESERVED", bytes: 60n });
		expect(f.reservations).toEqual([
			expect.objectContaining({ ownerId: "owner-a", bytes: 60n, status: "ACTIVE" }),
		]);
	});
});

function fixture(paid: boolean, pending = 0) {
	const reservations: Record<string, unknown>[] = [];
	const tx = {
		$executeRaw: async () => 1,
		$queryRaw: async () => [{ now: new Date() }],
		subscription: {
			findMany: async () =>
				paid
					? [
							{
								id: "subscription-a",
								provider: "paypal",
								status: "ACTIVE",
								periods: [{ paidAmount: 100n, refundedAmount: 0n }],
							},
						]
					: [],
		},
		billingPeriod: { fields: { paidAmount: "paidAmount" } },
		mediaUploadSession: {
			count: async () => pending,
			create: async ({ data }: { data: Record<string, unknown> }) => data,
		},
		mediaAsset: {
			create: async ({ data }: { data: Record<string, unknown> }) => data,
			findFirst: async () => ({
				id: "asset-a",
				ownerType: "USER",
				ownerId: "owner-a",
				status: "VERIFYING",
				outputTransferToken: "transfer",
				outputTransferLeaseExpiresAt: new Date(Date.now() + 60_000),
				outputStagingObjectKey: "staging-output",
			}),
		},
		generationJobAsset: {
			findFirst: async () => ({
				job: {
					pricingSnapshot: { aggregateStoragePolicy: { schemaVersion: 1, maximumBytes: null } },
				},
			}),
		},
		storageUsageReservation: {
			aggregate: async () => ({ _sum: { bytes: 1_000_000_000_000n } }),
			count: async () => pending,
			findUnique: async () => null,
			create: async ({ data }: { data: Record<string, unknown> }) => {
				reservations.push(data);
				return data;
			},
			upsert: async ({ create }: { create: Record<string, unknown> }) => {
				reservations.push(create);
				return create;
			},
		},
		auditLog: { create: async () => ({}) },
	};
	return {
		reservations,
		client: {
			$transaction: async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx),
		},
	};
}
