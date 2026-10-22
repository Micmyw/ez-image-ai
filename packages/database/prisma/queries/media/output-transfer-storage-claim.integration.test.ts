import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient, type Prisma } from "../../generated/client";
import { localSqlMetricsEnabled } from "../../query-metrics";
import {
	claimGenerationOutputTransferTransaction,
	GenerationOutputStorageError,
	reserveGenerationOutputStorageTransaction,
	type ClaimGenerationOutputTransferInput,
} from "./assets";
import { isDatabaseSerializationConflict } from "./types";

let client: PrismaClient;
const owners = new Set<string>();
const jobs: string[] = [];
const quotes: string[] = [];

beforeAll(() => {
	const connectionString = process.env.TEST_DATABASE_URL;
	if (
		!connectionString ||
		connectionString === process.env.DATABASE_URL ||
		!localSqlMetricsEnabled(connectionString, "true")
	)
		throw new Error("ISOLATED_LOCAL_TEST_DATABASE_REQUIRED");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 8 }) });
});
beforeEach(() => vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
	if (!client) return;
	try {
		const ownerIds = [...owners];
		const assets = await client.mediaAsset.findMany({
			where: { ownerId: { in: ownerIds } },
			select: { id: true },
		});
		await client.outboxEvent.deleteMany({
			where: { aggregateId: { in: [...jobs, ...assets.map((asset) => asset.id)] } },
		});
		await client.generationJobAsset.deleteMany({ where: { jobId: { in: jobs } } });
		await client.storageUsageReservation.deleteMany({ where: { ownerId: { in: ownerIds } } });
		await client.mediaAsset.deleteMany({ where: { ownerId: { in: ownerIds } } });
		await client.generationJob.deleteMany({ where: { id: { in: jobs } } });
		await client.generationQuote.deleteMany({ where: { id: { in: quotes } } });
		await client.mediaOwnerStorageFence.deleteMany({ where: { ownerId: { in: ownerIds } } });
		await client.user.deleteMany({ where: { id: { in: ownerIds } } });
	} finally {
		await client.$disconnect();
	}
});

async function fixture(
	ownerId = `combined-transfer-${crypto.randomUUID()}`,
): Promise<ClaimGenerationOutputTransferInput> {
	const jobId = crypto.randomUUID();
	const quoteId = crypto.randomUUID();
	const assetId = crypto.randomUUID();
	const now = new Date();
	if (!owners.has(ownerId)) {
		owners.add(ownerId);
		await client.user.create({
			data: {
				id: ownerId,
				name: "Combined output fixture",
				email: `${ownerId}@example.test`,
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			},
		});
	}
	quotes.push(quoteId);
	jobs.push(jobId);
	const identity = {
		ownerType: "USER" as const,
		ownerId,
		submittedByUserId: ownerId,
		productKey: "nano-banana-2-lite",
		catalogVersion: "test",
		pricingVersion: "test",
		inputSnapshot: {},
		pricingSnapshot: {},
	};
	await client.generationQuote.create({
		data: {
			...identity,
			id: quoteId,
			credits: 1n,
			costMicros: 1n,
			expiresAt: new Date(now.getTime() + 60_000),
		},
	});
	await client.generationJob.create({
		data: {
			...identity,
			id: jobId,
			quoteId,
			idempotencyKey: jobId,
			creditsReserved: 1n,
			status: "FINALIZING",
			executionEngine: "legacy",
		},
	});
	return {
		jobId,
		ownerId,
		assetId,
		objectKey: `users/${ownerId}/${assetId}.png`,
		mimeType: "image/png",
		sourceUrl: `provider-output:${jobId}:0`,
		streamingTransfersOnly: true,
		storageReservation: { bytes: 6n, maximumStorageBytes: 10n },
		createStagingObjectKey: (token) => `users/${ownerId}/staging/${token}.png`,
	};
}

async function placeholder(
	input: ClaimGenerationOutputTransferInput,
	overrides: Partial<Prisma.MediaAssetUncheckedCreateInput> = {},
) {
	return client.mediaAsset.create({
		data: {
			id: input.assetId,
			ownerType: "USER",
			ownerId: input.ownerId,
			verificationEngine: "legacy",
			kind: "OUTPUT",
			status: "VERIFYING",
			objectKey: input.objectKey,
			mimeType: input.mimeType,
			byteSize: 0n,
			sourceUrl: input.sourceUrl,
			...overrides,
		},
	});
}

async function assertNoClaim(input: ClaimGenerationOutputTransferInput) {
	expect(await client.mediaAsset.findUnique({ where: { id: input.assetId } })).toBeNull();
	expect(await client.generationJobAsset.count({ where: { jobId: input.jobId } })).toBe(0);
	expect(
		await client.storageUsageReservation.findUnique({
			where: { referenceKey: `generation-output:${input.assetId}` },
		}),
	).toBeNull();
	expect(await client.outboxEvent.count({ where: { aggregateId: input.assetId } })).toBe(0);
}

describe.each([false, true])(
	"combined output transfer storage transaction (fresh=%s)",
	(freshRead) => {
		beforeEach(() => vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", String(freshRead)));

		it("commits one claimed asset, its binding and matching lease-bound reservation", async () => {
			const input = await fixture();
			const result = await claimGenerationOutputTransferTransaction(input, client);
			expect(result).toMatchObject({
				outcome: "CLAIMED",
				freshAsset: true,
				reservedStorageBytes: 6n,
			});
			if (result.outcome !== "CLAIMED") throw new Error("claim required");
			const asset = await client.mediaAsset.findUniqueOrThrow({ where: { id: input.assetId } });
			expect(asset).toMatchObject({
				status: "VERIFYING",
				byteSize: 0n,
				outputTransferToken: result.transferToken,
				outputStagingObjectKey: result.stagingObjectKey,
			});
			expect(
				await client.generationJobAsset.count({ where: { jobId: input.jobId, assetId: asset.id } }),
			).toBe(1);
			expect(
				await client.storageUsageReservation.findUniqueOrThrow({
					where: { referenceKey: `generation-output:${asset.id}` },
				}),
			).toMatchObject({
				ownerId: input.ownerId,
				bytes: 6n,
				status: "ACTIVE",
				expiresAt: asset.outputTransferLeaseExpiresAt,
			});
		});

		it("rolls back the new lease and binding when existing usage exhausts capacity", async () => {
			const input = await fixture();
			await client.storageUsageReservation.create({
				data: {
					ownerType: "USER",
					ownerId: input.ownerId,
					bytes: 5n,
					status: "COMMITTED",
					referenceKey: `existing:${input.jobId}`,
					expiresAt: new Date(),
				},
			});
			await expect(claimGenerationOutputTransferTransaction(input, client)).rejects.toBeInstanceOf(
				GenerationOutputStorageError,
			);
			await assertNoClaim(input);
			expect(await client.mediaOwnerStorageFence.count({ where: { ownerId: input.ownerId } })).toBe(
				0,
			);
		});

		it("admits exactly one of two concurrent same-owner transfers that would exceed the cap together", async () => {
			const first = await fixture();
			const second = await fixture(first.ownerId);
			const results = await Promise.allSettled([
				claimGenerationOutputTransferTransaction(first, client),
				claimGenerationOutputTransferTransaction(second, client),
			]);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			const rejected = results.find((result) => result.status === "rejected");
			expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(
				GenerationOutputStorageError,
			);
			expect(await client.mediaAsset.count({ where: { ownerId: first.ownerId } })).toBe(1);
			expect(
				await client.storageUsageReservation.aggregate({
					where: { ownerId: first.ownerId },
					_sum: { bytes: true },
				}),
			).toMatchObject({ _sum: { bytes: 6n } });
		});

		it("does not allocate a transfer or reservation after the job has left FINALIZING", async () => {
			const input = await fixture();
			await client.generationJob.update({ where: { id: input.jobId }, data: { status: "FAILED" } });
			await expect(claimGenerationOutputTransferTransaction(input, client)).resolves.toEqual({
				outcome: "REQUIRES_HEAVY",
			});
			await assertNoClaim(input);
		});

		it("reuses the exact existing reservation without double-counting it against quota", async () => {
			const input = await fixture();
			await placeholder(input);
			const referenceKey = `generation-output:${input.assetId}`;
			await client.storageUsageReservation.create({
				data: {
					ownerType: "USER",
					ownerId: input.ownerId,
					bytes: 6n,
					status: "ACTIVE",
					referenceKey,
					expiresAt: new Date(Date.now() - 60_000),
				},
			});
			const result = await claimGenerationOutputTransferTransaction(
				{ ...input, storageReservation: { bytes: 6n, maximumStorageBytes: 6n } },
				client,
			);
			expect(result).toMatchObject({
				outcome: "CLAIMED",
				freshAsset: false,
				reservedStorageBytes: 6n,
			});
			expect(
				await client.storageUsageReservation.count({ where: { ownerId: input.ownerId } }),
			).toBe(1);
			expect(
				await client.storageUsageReservation.findUniqueOrThrow({ where: { referenceKey } }),
			).toMatchObject({ bytes: 6n, status: "ACTIVE" });
		});

		it("preserves finalized output awaiting review without reserving or claiming it again", async () => {
			const input = await fixture();
			await placeholder(input, {
				status: "VERIFYING",
				byteSize: 6n,
				checksum: "a".repeat(64),
				finalizedAt: new Date(),
			});
			await expect(claimGenerationOutputTransferTransaction(input, client)).resolves.toMatchObject({
				outcome: "COMPLETED",
			});
			expect(
				await client.storageUsageReservation.count({ where: { ownerId: input.ownerId } }),
			).toBe(0);
			expect(
				await client.mediaAsset.findUniqueOrThrow({ where: { id: input.assetId } }),
			).toMatchObject({ outputTransferToken: null, status: "VERIFYING" });
		});

		it("keeps live and expired legacy transfer recovery on its original reservation protocol", async () => {
			const input = await fixture();
			const legacy = { ...input, streamingTransfersOnly: false, storageReservation: undefined };
			const original = await claimGenerationOutputTransferTransaction(legacy, client);
			if (original.outcome !== "CLAIMED") throw new Error("claim required");
			const reserve = {
				assetId: input.assetId,
				ownerId: input.ownerId,
				transferToken: original.transferToken,
				bytes: 6n,
				maximumStorageBytes: 10n,
			};
			await reserveGenerationOutputStorageTransaction(reserve, client);
			await expect(claimGenerationOutputTransferTransaction(input, client)).resolves.toEqual({
				outcome: "REQUIRES_HEAVY",
			});
			await expect(claimGenerationOutputTransferTransaction(legacy, client)).resolves.toMatchObject(
				{ outcome: "IN_PROGRESS" },
			);
			expect(
				await client.mediaAsset.findUniqueOrThrow({ where: { id: input.assetId } }),
			).toMatchObject({ outputTransferToken: original.transferToken });
			await client.mediaAsset.update({
				where: { id: input.assetId },
				data: { outputTransferLeaseExpiresAt: new Date(Date.now() - 1_000) },
			});
			await expect(claimGenerationOutputTransferTransaction(input, client)).resolves.toEqual({
				outcome: "REQUIRES_HEAVY",
			});
			const recovered = await claimGenerationOutputTransferTransaction(legacy, client);
			if (recovered.outcome !== "CLAIMED") throw new Error("recovery claim required");
			expect(recovered.transferToken).not.toBe(original.transferToken);
			expect(recovered).not.toHaveProperty("reservedStorageBytes");
			await reserveGenerationOutputStorageTransaction(
				{ ...reserve, transferToken: recovered.transferToken },
				client,
			);
			expect(
				await client.storageUsageReservation.count({ where: { ownerId: input.ownerId } }),
			).toBe(1);
			expect(
				await client.storageUsageReservation.aggregate({
					where: { ownerId: input.ownerId },
					_sum: { bytes: true },
				}),
			).toMatchObject({ _sum: { bytes: 6n } });
		});

		it("rolls back even when an error occurs after writing the reservation", async () => {
			const input = await fixture();
			const failingClient = client.$extends({
				query: {
					storageUsageReservation: {
						async upsert({ args, query }) {
							await query(args);
							throw new Error("INTENTIONAL_AFTER_RESERVATION_WRITE");
						},
					},
				},
			});
			await expect(
				claimGenerationOutputTransferTransaction(input, failingClient as unknown as PrismaClient),
			).rejects.toThrow("INTENTIONAL_AFTER_RESERVATION_WRITE");
			await assertNoClaim(input);
			expect(await client.mediaOwnerStorageFence.count({ where: { ownerId: input.ownerId } })).toBe(
				0,
			);
		});

		it("preserves the admitted unlimited storage policy while continuing to meter bytes", async () => {
			const input = await fixture();
			await client.generationJob.update({
				where: { id: input.jobId },
				data: {
					pricingSnapshot: { aggregateStoragePolicy: { schemaVersion: 1, maximumBytes: null } },
				},
			});
			await expect(
				claimGenerationOutputTransferTransaction(
					{ ...input, storageReservation: { bytes: 6n, maximumStorageBytes: 1n } },
					client,
				),
			).resolves.toMatchObject({ outcome: "CLAIMED", reservedStorageBytes: 6n });
			expect(
				await client.storageUsageReservation.aggregate({
					where: { ownerId: input.ownerId },
					_sum: { bytes: true },
				}),
			).toMatchObject({ _sum: { bytes: 6n } });
		});
	},
);

it("a combined claim fences a preexisting Serializable asset snapshot", async () => {
	const input = await fixture();
	await placeholder(input);
	let read!: () => void;
	let release!: () => void;
	const snapshotReady = new Promise<void>((resolve) => {
		read = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const staleWriter = client.$transaction(
		async (tx) => {
			const asset = await tx.mediaAsset.findUniqueOrThrow({ where: { id: input.assetId } });
			expect(asset.outputTransferToken).toBeNull();
			read();
			await released;
			await tx.mediaAsset.update({
				where: { id: asset.id },
				data: { status: "DELETED", deletedAt: new Date() },
			});
		},
		{ isolationLevel: "Serializable", timeout: 10_000 },
	);
	const staleOutcome = staleWriter.then(
		() => undefined,
		(error: unknown) => error,
	);
	try {
		await Promise.race([snapshotReady, staleWriter]);
		await expect(claimGenerationOutputTransferTransaction(input, client)).resolves.toMatchObject({
			outcome: "CLAIMED",
			freshAsset: false,
			reservedStorageBytes: 6n,
		});
		release();
		expect(isDatabaseSerializationConflict(await staleOutcome)).toBe(true);
		expect(
			await client.mediaAsset.findUniqueOrThrow({ where: { id: input.assetId } }),
		).toMatchObject({ status: "VERIFYING", deletedAt: null });
	} finally {
		release();
		await staleOutcome;
	}
});
