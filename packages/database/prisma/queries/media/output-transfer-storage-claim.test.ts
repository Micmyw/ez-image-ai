import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("explicit client required");
	},
}));

import {
	claimGenerationOutputTransferTransaction,
	type ClaimGenerationOutputTransferInput,
} from "./assets";

const now = new Date("2026-10-22T00:00:00Z");
const input: ClaimGenerationOutputTransferInput = {
	jobId: "job-a",
	ownerId: "owner-a",
	assetId: "asset-a",
	objectKey: "users/owner-a/asset-a.png",
	mimeType: "image/png",
	sourceUrl: "provider-output:job-a:0",
	streamingTransfersOnly: true,
	storageReservation: { bytes: 6n, maximumStorageBytes: 10n },
	createStagingObjectKey: (token) => `users/owner-a/staging/${token}.png`,
	now,
};

function fixture() {
	const order: string[] = [];
	const tx = {
		$executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
			const sql = strings.join("?");
			if (sql.includes("media_owner_storage_fence")) order.push("owner-fence");
			else if (sql.includes('UPDATE "generation_job"')) order.push("job-fence");
			else if (String(values[0]).startsWith("media-owner-storage-usage:")) order.push("owner-lock");
			else order.push("binding-lock");
			return 1;
		}),
		$queryRaw: vi.fn(async () => []),
		generationJob: {
			findFirst: vi.fn(async () => ({ id: input.jobId, serviceClass: "STANDARD" })),
		},
		mediaAsset: {
			findUnique: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
			findFirst: vi.fn(),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		generationJobAsset: {
			upsert: vi.fn(async () => ({ id: "binding-a" })),
			findFirst: vi.fn(async () => ({ job: { pricingSnapshot: {} } })),
		},
		storageUsageReservation: {
			findUnique: vi.fn(async () => null),
			aggregate: vi.fn(async () => ({ _sum: { bytes: 0n } })),
			upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => create),
		},
		subscription: { findMany: vi.fn(async () => []) },
		billingPeriod: { fields: { paidAmount: "paidAmount" } },
	};
	return {
		tx,
		order,
		client: {
			$transaction: vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) =>
				operation(tx),
			),
		},
	};
}

describe("atomic ordinary output claim and storage reservation", () => {
	afterEach(() => vi.unstubAllEnvs());

	it.each([false, true])(
		"commits the lease and capacity in one transaction without a second asset read (fresh=%s)",
		async (freshRead) => {
			vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", String(freshRead));
			const f = fixture();
			const result = await claimGenerationOutputTransferTransaction(input, f.client as never);
			expect(result).toMatchObject({
				outcome: "CLAIMED",
				freshAsset: true,
				reservedStorageBytes: 6n,
			});
			if (result.outcome !== "CLAIMED") throw new Error("claim required");
			expect(f.client.$transaction).toHaveBeenCalledOnce();
			expect(f.client.$transaction).toHaveBeenCalledWith(
				expect.any(Function),
				expect.objectContaining({ isolationLevel: freshRead ? "ReadCommitted" : "Serializable" }),
			);
			expect(f.order).toEqual(["owner-lock", "owner-fence", "job-fence", "binding-lock"]);
			expect(f.tx.mediaAsset.findUnique).toHaveBeenCalledOnce();
			expect(f.tx.mediaAsset.findFirst).not.toHaveBeenCalled();
			expect(f.tx.mediaAsset.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ outputTransferToken: result.transferToken }),
				}),
			);
			expect(f.tx.storageUsageReservation.upsert).toHaveBeenCalledWith(
				expect.objectContaining({
					create: expect.objectContaining({
						ownerId: input.ownerId,
						referenceKey: `generation-output:${input.assetId}`,
						status: "ACTIVE",
						bytes: 6n,
						expiresAt: new Date(now.getTime() + 5 * 60_000),
					}),
				}),
			);
		},
	);

	it("keeps legacy zero-byte claims free of owner quota work", async () => {
		const f = fixture();
		const result = await claimGenerationOutputTransferTransaction(
			{ ...input, storageReservation: undefined },
			f.client as never,
		);
		expect(result).toMatchObject({ outcome: "CLAIMED" });
		expect(result).not.toHaveProperty("reservedStorageBytes");
		expect(f.order).toEqual(["job-fence", "binding-lock"]);
		expect(f.tx.storageUsageReservation.upsert).not.toHaveBeenCalled();
	});

	it.each([
		{ storageReservation: { bytes: 0n, maximumStorageBytes: 10n } },
		{ storageReservation: { bytes: 6n, maximumStorageBytes: 0n } },
		{ streamingTransfersOnly: false },
	])("rejects invalid combined requests before a transaction: case %#", async (override) => {
		const f = fixture();
		await expect(
			claimGenerationOutputTransferTransaction({ ...input, ...override }, f.client as never),
		).rejects.toThrow();
		expect(f.client.$transaction).not.toHaveBeenCalled();
	});

	it.each([
		{ guest: { deleteAfter: new Date(now.getTime() + 60_000) } },
		{ mimeType: "video/mp4" },
	])("reroutes excluded transfer types before allocation: %j", async (override) => {
		const f = fixture();
		await expect(
			claimGenerationOutputTransferTransaction({ ...input, ...override }, f.client as never),
		).resolves.toEqual({ outcome: "REQUIRES_HEAVY" });
		expect(f.client.$transaction).not.toHaveBeenCalled();
	});

	it("does not reserve capacity when the conditional job fence rejects the claim", async () => {
		const f = fixture();
		f.tx.$executeRaw.mockImplementation(async (strings) =>
			strings.join("?").includes('UPDATE "generation_job"') ? 0 : 1,
		);
		await expect(
			claimGenerationOutputTransferTransaction(input, f.client as never),
		).resolves.toEqual({
			outcome: "REQUIRES_HEAVY",
		});
		expect(f.tx.mediaAsset.create).not.toHaveBeenCalled();
		expect(f.tx.generationJobAsset.upsert).not.toHaveBeenCalled();
		expect(f.tx.storageUsageReservation.upsert).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"rejects a foreign verification engine before reserving (fresh=%s)",
		async (freshRead) => {
			vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", String(freshRead));
			const f = fixture();
			f.tx.mediaAsset.findUnique.mockResolvedValue({ verificationEngine: "video-workflow-v1" });
			await expect(
				claimGenerationOutputTransferTransaction(input, f.client as never),
			).rejects.toThrow("GENERATION_OUTPUT_ASSET_CONFLICT");
			expect(f.tx.storageUsageReservation.upsert).not.toHaveBeenCalled();
		},
	);
});
