import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "../../generated/client";
import { markMediaAssetDeletedTransaction } from "./assets";
import {
	claimGenerationDraftTransaction,
	createGenerationDraftTransaction,
	transferGuestGenerationDraftToRegisteredUserInTransaction,
} from "./drafts";

let client: PrismaClient;
const productKey = "image-nano-banana-2-lite" as const;

describe("draft ownership storage accounting", () => {
	beforeAll(async () => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString || connectionString === process.env.DATABASE_URL)
			throw new Error("UNSAFE_TEST_DATABASE");
		const url = new URL(connectionString);
		if (
			!["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
			!/(^|[_-])(test|testing)([_-]|$)/.test(url.pathname.slice(1))
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
		await client.$connect();
	});
	afterEach(() => vi.unstubAllEnvs());
	afterAll(async () => client?.$disconnect());

	it("rolls back ownership and verification dispatch when claiming would exceed aggregate quota", async () => {
		vi.stubEnv("MEDIA_MAX_STORAGE_BYTES", "100");
		const ownerId = randomUUID();
		await reserve(ownerId, 60n);
		const draft = await createDraft(41n);
		await expect(claim(draft.claimTokenHash, ownerId)).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
		await expect(
			client.generationDraft.findUniqueOrThrow({ where: { id: draft.id } }),
		).resolves.toMatchObject({ status: "ACTIVE" });
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: draft.assetId } }),
		).resolves.toMatchObject({ ownerId: `draft:${draft.id}` });
		await expect(client.outboxEvent.count({ where: { aggregateId: draft.assetId } })).resolves.toBe(
			0,
		);
		await expect(usage(ownerId)).resolves.toBe(60n);
	});

	it("accounts exact-limit claims once across replay and retains bytes until physical cleanup", async () => {
		vi.stubEnv("MEDIA_MAX_STORAGE_BYTES", "100");
		const owner = await client.user.create({
			data: {
				email: `${randomUUID()}@test.invalid`,
				name: "Draft owner",
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		await reserve(owner.id, 60n);
		const draft = await createDraft(40n);
		const results = await Promise.all([
			claim(draft.claimTokenHash, owner.id),
			claim(draft.claimTokenHash, owner.id),
		]);
		expect(results[0]).toEqual(results[1]);
		await expect(usage(owner.id)).resolves.toBe(100n);
		await expect(claim(draft.claimTokenHash, randomUUID())).rejects.toThrow("DRAFT_UNAVAILABLE");
		await markMediaAssetDeletedTransaction({ assetId: draft.assetId, ownerId: owner.id }, client);
		await expect(usage(owner.id)).resolves.toBe(100n);
		const cleanup = await client.outboxEvent.findUniqueOrThrow({
			where: { dedupeKey: `media-object-delete:${draft.assetId}` },
		});
		expect(cleanup.payload).toMatchObject({
			storageReservationReferenceKey: `media-draft:${draft.assetId}`,
		});
	});

	it("serializes different concurrent claims against the same remaining quota", async () => {
		vi.stubEnv("MEDIA_MAX_STORAGE_BYTES", "100");
		const ownerId = randomUUID();
		const drafts = await Promise.all([createDraft(60n), createDraft(60n)]);
		const results = await Promise.allSettled(
			drafts.map((draft) => claim(draft.claimTokenHash, ownerId)),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		await expect(usage(ownerId)).resolves.toBe(60n);
	});

	it("moves an existing guest upload reservation without duplicating or resetting its status", async () => {
		vi.stubEnv("MEDIA_MAX_STORAGE_BYTES", "100");
		const owner = await client.user.create({
			data: {
				email: `${randomUUID()}@test.invalid`,
				name: "Registered owner",
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		const draft = await createDraft(40n);
		const anonymousOwnerId = `draft:${draft.id}`;
		await client.generationDraft.update({ where: { id: draft.id }, data: { status: "SUBMITTED" } });
		const session = await client.mediaUploadSession.create({
			data: {
				assetId: draft.assetId,
				tokenHash: randomUUID(),
				stagingObjectKey: `users/${anonymousOwnerId}/staging/${randomUUID()}.png`,
				expectedBytes: 40n,
				status: "COMPLETED",
				expiresAt: new Date(),
				completedAt: new Date(),
			},
		});
		const reservation = await reserve(anonymousOwnerId, 40n, `media-upload:${session.id}`);
		await reserve(owner.id, 60n);
		await client.$transaction((tx) =>
			transferGuestGenerationDraftToRegisteredUserInTransaction(
				{
					draftId: draft.id,
					anonymousOwnerId,
					registeredUserId: owner.id,
					now: new Date(),
				},
				tx,
			),
		);
		await expect(usage(owner.id)).resolves.toBe(100n);
		await expect(usage(anonymousOwnerId)).resolves.toBe(0n);
		await expect(
			client.storageUsageReservation.findUniqueOrThrow({ where: { id: reservation.id } }),
		).resolves.toMatchObject({ ownerId: owner.id, bytes: 40n, status: "COMMITTED" });
		await expect(
			client.storageUsageReservation.count({
				where: { referenceKey: `media-draft:${draft.assetId}` },
			}),
		).resolves.toBe(0);
	});

	it("does not double charge an already reserved asset claimed by its current owner", async () => {
		vi.stubEnv("MEDIA_MAX_STORAGE_BYTES", "40");
		const draft = await createDraft(40n);
		const ownerId = `draft:${draft.id}`;
		await reserve(ownerId, 40n, `media-draft:${draft.assetId}`);
		await claim(draft.claimTokenHash, ownerId);
		await expect(usage(ownerId)).resolves.toBe(40n);
	});
});

function claim(claimTokenHash: string, userId: string) {
	return claimGenerationDraftTransaction(
		{ claimTokenHash, userId, allowedProductKeys: [productKey] },
		client,
	);
}

async function createDraft(bytes: bigint) {
	const assetId = randomUUID();
	const claimTokenHash = randomUUID();
	const draft = await createGenerationDraftTransaction(
		{
			claimTokenHash,
			productKey,
			input: {
				kind: "image-to-image",
				prompt: "Storage quota regression",
				skuKey: "nano-banana-2-lite-1k",
				aspectRatio: "auto",
			},
			expiresAt: new Date(Date.now() + 60_000),
			asset: {
				id: assetId,
				objectKey: `users/draft/assets/${assetId}/original.png`,
				byteSize: bytes,
				mimeType: "image/png",
				checksum: "a".repeat(64),
				finalizedAt: new Date(),
			},
		},
		client,
	);
	return { ...draft, assetId, claimTokenHash };
}

function reserve(ownerId: string, bytes: bigint, referenceKey: string = randomUUID()) {
	return client.storageUsageReservation.create({
		data: {
			ownerType: "USER",
			ownerId,
			bytes,
			referenceKey,
			status: "COMMITTED",
			expiresAt: new Date(),
		},
	});
}

async function usage(ownerId: string) {
	const result = await client.storageUsageReservation.aggregate({
		where: { ownerType: "USER", ownerId, status: { in: ["ACTIVE", "COMMITTED"] } },
		_sum: { bytes: true },
	});
	return result._sum.bytes ?? 0n;
}
