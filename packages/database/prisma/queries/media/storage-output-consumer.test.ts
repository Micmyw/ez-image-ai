import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("../../client", () => ({ getDatabaseClient: () => runtime.client }));
// These storage transactions must never settle or release credits.
vi.mock("./credits", () => ({
	settleCreditsInTransaction: () => {
		throw new Error("unexpected credit settlement");
	},
	releaseCreditsInTransaction: () => {
		throw new Error("unexpected credit release");
	},
}));

import {
	createMediaUploadSessionTransaction,
	reserveGenerationOutputStorageTransaction,
} from "./assets";
import { claimVideoOutputStorage } from "./video-v1-fulfillment";

const owner = { ownerType: "USER" as const, ownerId: "owner-a" };
const freeMaximumBytes = 100n;

describe.each(["image", "video"] as const)("%s output storage consumer compatibility", (kind) => {
	it.each([{}, { aggregateStoragePolicy: { schemaVersion: 1, maximumBytes: "10000" } }])(
		"keeps the configured free cap for historical or finite policy %j",
		async (snapshot) => {
			const f = fixture(snapshot);
			await expect(f.reserve(kind)).rejects.toThrow(/STORAGE_QUOTA_EXCEEDED/);
			expect(f.reservations).toEqual([]);
		},
	);
	it("honors the admitted unlimited snapshot after the subscription expires", async () => {
		const f = fixture({
			credits: "5",
			aggregateStoragePolicy: { schemaVersion: 1, maximumBytes: null },
		});
		const frozen = structuredClone(f.job.pricingSnapshot);
		await expect(f.reserve(kind)).resolves.toMatchObject(
			kind === "image" ? { outcome: "RESERVED" } : { status: "CLAIMED" },
		);
		expect(f.reservations).toEqual([expect.objectContaining({ ...owner, bytes: 60n })]);
		expect(f.job.pricingSnapshot).toEqual(frozen);
	});
	it("accepts an effective paid subscription for a historical output while still metering bytes", async () => {
		const f = fixture({}, true);
		await f.reserve(kind);
		expect(f.reservations).toEqual([expect.objectContaining({ ...owner, bytes: 60n })]);
	});
	it("rejects an invalid frozen policy before reservation writes", async () => {
		const f = fixture({ aggregateStoragePolicy: { schemaVersion: 1, maximumBytes: "unlimited" } });
		await expect(f.reserve(kind)).rejects.toThrow("AGGREGATE_STORAGE_POLICY_INVALID");
		expect(f.reservations).toEqual([]);
	});
	it("does not adopt another owner's unlimited job policy", async () => {
		const f = fixture(
			{ aggregateStoragePolicy: { schemaVersion: 1, maximumBytes: null } },
			false,
			"other-owner",
		);
		await expect(f.reserve(kind)).rejects.toThrow(/STORAGE_QUOTA_EXCEEDED/);
		expect(f.reservations).toEqual([]);
	});
});

describe("consumer-first preserves producer admission and transfer fences", () => {
	it("keeps the existing upload cap even for a paid owner", async () => {
		const f = fixture({}, true);
		await expect(
			createMediaUploadSessionTransaction(
				{
					...owner,
					assetId: "input-a",
					sessionId: "upload-a",
					kind: "INPUT",
					objectKey: "users/owner-a/final.png",
					stagingObjectKey: "users/owner-a/staging.png",
					mimeType: "image/png",
					expectedBytes: 60n,
					tokenHash: "hash",
					expiresAt: new Date(Date.now() + 60_000),
					multipartUploadId: null,
					limits: { maximumActiveSessions: 5, maximumReservedBytes: freeMaximumBytes },
				},
				f.client as never,
			),
		).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
		expect(f.reservations).toEqual([]);
	});
	it("does not reserve an image with a stale transfer token", async () => {
		const f = fixture({ aggregateStoragePolicy: { schemaVersion: 1, maximumBytes: null } });
		f.image.outputTransferToken = "different-token";
		await expect(f.reserve("image")).resolves.toEqual({ outcome: "STALE", bytes: 0n });
		expect(f.reservations).toEqual([]);
	});
	it("does not reserve a video without authenticated provider success", async () => {
		const f = fixture({ aggregateStoragePolicy: { schemaVersion: 1, maximumBytes: null } });
		f.job.attempts[0]!.transferEnvelope.payload.authority = "callback";
		await expect(f.reserve("video")).rejects.toThrow("VIDEO_AUTHORITY_RESULT_REQUIRED");
		expect(f.reservations).toEqual([]);
	});
});

function fixture(
	pricingSnapshot: Record<string, unknown>,
	paid = false,
	policyOwnerId = owner.ownerId,
) {
	const reservations: Record<string, unknown>[] = [];
	const job = {
		id: "job-a",
		...owner,
		executionEngine: "video-workflow-v1",
		status: "PROVIDER_RUNNING",
		inputSnapshot: { outputStoragePolicy: { schemaVersion: 1, maximumBytes: 60 } },
		pricingSnapshot,
		videoExecution: { stage: "PROVIDER_PENDING", stateVersion: 1, storageStartedAt: null },
		attempts: [
			{
				status: "SUCCEEDED",
				transferEnvelope: {
					payload: {
						authority: "authenticated-query",
						outputUrl: "https://provider.example.test/output.mp4",
					},
				},
			},
		],
		assets: [],
	};
	const image = {
		id: "output-a",
		...owner,
		status: "VERIFYING",
		outputTransferToken: "transfer-a",
		outputTransferLeaseExpiresAt: new Date(Date.now() + 60_000),
		outputStagingObjectKey: "private-staging",
	};
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
		generationJob: {
			findUnique: async () => job,
			findFirst: async ({ where }: { where: { id: string; ownerId?: string } }) =>
				where.id === job.id && (where.ownerId === undefined || where.ownerId === policyOwnerId)
					? job
					: null,
			update: async () => job,
		},
		generationJobAsset: {
			findMany: async () => [],
			findFirst: async ({
				where,
			}: {
				where: { assetId: string; role: string; job: typeof owner };
			}) =>
				where.assetId === image.id &&
				where.role === "OUTPUT" &&
				where.job.ownerId === policyOwnerId &&
				where.job.ownerType === owner.ownerType
					? { job }
					: null,
			create: async () => ({}),
		},
		mediaAsset: {
			findFirst: async () => image,
			create: async ({ data }: { data: Record<string, unknown> }) => data,
			update: async ({ data }: { data: Record<string, unknown> }) => data,
		},
		mediaUploadSession: { count: async () => 0 },
		storageUsageReservation: {
			aggregate: async () => ({ _sum: { bytes: 1000n } }),
			findUnique: async () => null,
			findMany: async () => [],
			create: async ({ data }: { data: Record<string, unknown> }) => {
				reservations.push(data);
				return data;
			},
			upsert: async ({ create }: { create: Record<string, unknown> }) => {
				reservations.push(create);
				return create;
			},
		},
		videoExecution: { update: async () => ({}) },
	};
	const client = {
		$transaction: async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx),
	};
	runtime.client = client;
	return {
		client,
		job,
		image,
		reservations,
		reserve: (kind: "image" | "video") =>
			kind === "video"
				? claimVideoOutputStorage(job.id, freeMaximumBytes)
				: reserveGenerationOutputStorageTransaction(
						{
							assetId: image.id,
							ownerId: owner.ownerId,
							transferToken: "transfer-a",
							bytes: 60n,
							maximumStorageBytes: freeMaximumBytes,
						},
						client as never,
					),
	};
}
