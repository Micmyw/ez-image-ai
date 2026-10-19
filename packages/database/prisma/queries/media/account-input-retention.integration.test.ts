import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient, type Prisma } from "../../generated/client";
import { transferGuestGenerationDraftToRegisteredUserInTransaction } from "./drafts";
import { lockGuestOwnerPromotion } from "./guest-admission";
import { claimMediaStorageCleanupTransaction } from "./storage-cleanup";

let db: PrismaClient;
beforeAll(async () => {
	const value = process.env.TEST_DATABASE_URL;
	if (!value || value === process.env.DATABASE_URL) throw new Error("UNSAFE_TEST_DATABASE");
	const url = new URL(value);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname))
		throw new Error("UNSAFE_TEST_DATABASE");
	db = new PrismaClient({ adapter: new PrismaPg({ connectionString: value }) });
	await db.$connect();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => db?.$disconnect());

async function fixture() {
	const id = randomUUID();
	const guest = `retention-guest-${id}`,
		account = `retention-account-${id}`;
	const expiresAt = new Date(Date.now() + 60_000);
	await db.user.createMany({
		data: [guest, account].map((ownerId) => ({
			id: ownerId,
			name: "Retention test",
			email: `${ownerId}@test.invalid`,
			isAnonymous: ownerId === guest,
			emailVerified: ownerId === account,
			createdAt: new Date(),
			updatedAt: new Date(),
		})),
	});
	const asset = await db.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId: guest,
			kind: "INPUT",
			status: "READY",
			retentionClass: "GUEST_TRIAL",
			deleteAfter: expiresAt,
			objectKey: `users/${guest}/assets/${id}/input.png`,
			mimeType: "image/png",
			byteSize: 10n,
			checksum: "a".repeat(64),
			finalizedAt: new Date(),
		},
	});
	const draft = await db.generationDraft.create({
		data: {
			ownerType: "USER",
			ownerId: guest,
			submittedByUserId: guest,
			status: "SUBMITTED",
			claimTokenHash: randomUUID(),
			assetId: asset.id,
			productKey: "image-nano-banana-2-lite",
			inputSnapshot: {
				kind: "image-to-image",
				prompt: "Keep subject",
				skuKey: "nano-banana-2-lite-1k",
				aspectRatio: "auto",
			},
			expiresAt,
		},
	});
	await db.storageUsageReservation.create({
		data: {
			ownerType: "USER",
			ownerId: guest,
			referenceKey: `media-draft:${asset.id}`,
			bytes: 10n,
			status: "COMMITTED",
			expiresAt,
		},
	});
	return {
		asset,
		input: {
			draftId: draft.id,
			anonymousOwnerId: guest,
			registeredUserId: account,
			now: new Date(),
		},
	};
}

describe("account input retention and physical cleanup serialization", () => {
	it("lets the account transaction win against an already-dispatched deletion waiting on the asset lock", async () => {
		vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
		const { asset, input } = await fixture();
		let unlock!: () => void, adopted!: () => void;
		const release = new Promise<void>((resolve) => {
			unlock = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			adopted = resolve;
		});
		const promotion = db.$transaction(
			async (tx) => {
				await lockGuestOwnerPromotion(tx, input.anonymousOwnerId, "retention-test");
				await transferGuestGenerationDraftToRegisteredUserInTransaction(input, tx);
				adopted();
				await release;
			},
			{ timeout: 10_000 },
		);
		// Surface an early promotion failure instead of leaving the barrier pending.
		await Promise.race([
			ready,
			promotion.then(() => {
				throw new Error("PROMOTION_DID_NOT_REACH_BARRIER");
			}),
		]);
		let connected!: (pid: number) => void;
		const connection = new Promise<number>((resolve) => {
			connected = resolve;
		});
		const observed = {
			$transaction: (
				action: (tx: Prisma.TransactionClient) => Promise<unknown>,
				options: {
					isolationLevel?: Prisma.TransactionIsolationLevel;
					maxWait?: number;
					timeout?: number;
				},
			) =>
				db.$transaction(async (tx) => {
					const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
					connected(row!.pid);
					return action(tx);
				}, options),
		};
		const deletion = claimMediaStorageCleanupTransaction(
			{ assetId: asset.id, objectKeys: ["old-stage", asset.objectKey], releasesReservation: true },
			observed as never,
		);
		try {
			const pid = await connection;
			let waiting = false;
			for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
				const [row] = await db.$queryRaw<
					Array<{ waiting: boolean }>
				>`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${pid} AND locktype = 'advisory' AND NOT granted) AS waiting`;
				waiting = row!.waiting;
				if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(waiting).toBe(true);
		} finally {
			unlock();
		}
		await promotion;
		await expect(deletion).resolves.toBe("SKIP");
		await expect(
			db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }),
		).resolves.toMatchObject({
			ownerId: input.registeredUserId,
			retentionClass: "ACCOUNT",
			deleteAfter: null,
			status: "READY",
			deletedAt: null,
		});
		await expect(
			db.storageUsageReservation.findUniqueOrThrow({
				where: { referenceKey: `media-draft:${asset.id}` },
			}),
		).resolves.toMatchObject({ ownerId: input.registeredUserId, status: "COMMITTED", bytes: 10n });
	});

	it("rejects adoption after deletion authorization commits, even while physical deletion is still outstanding", async () => {
		vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
		const { asset, input } = await fixture();
		await db.mediaAsset.update({
			where: { id: asset.id },
			data: { deleteAfter: new Date(Date.now() - 1) },
		});
		await expect(
			claimMediaStorageCleanupTransaction({ assetId: asset.id, objectKeys: [asset.objectKey] }, db),
		).resolves.toBe("DELETE");
		await expect(
			db.$transaction(async (tx) => {
				await lockGuestOwnerPromotion(tx, input.anonymousOwnerId, "retention-test");
				return transferGuestGenerationDraftToRegisteredUserInTransaction(input, tx);
			}),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
		await expect(
			db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }),
		).resolves.toMatchObject({
			status: "DELETED",
			deletedAt: expect.any(Date),
			ownerId: input.anonymousOwnerId,
		});
	});
});
