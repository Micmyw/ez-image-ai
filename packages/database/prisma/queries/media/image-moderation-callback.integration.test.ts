import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient, type Prisma } from "../../generated/client";
import { imageModerationRetryAt, wakeImageModeration } from "./image-moderation-callback";

describe("image moderation callback isolated PostgreSQL", () => {
	let client: PrismaClient;
	const assetIds: string[] = [];
	beforeAll(() => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("EXPLICIT_TEST_DATABASE_REQUIRED");
		const url = new URL(connectionString);
		const safeDatabase =
			url.pathname === "/ai_media_foundation_test" ||
			/^\/ezpic_[a-z0-9_]+_test$/.test(url.pathname);
		if (url.hostname !== "127.0.0.1" || url.port !== "55432" || !safeDatabase)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 4 }) });
	});
	afterAll(async () => {
		if (!client) return;
		await client.mediaAsset.deleteMany({ where: { id: { in: assetIds } } });
		await client.$disconnect();
	});

	async function fixture(patch: Partial<Prisma.MediaAssetCreateInput> = {}) {
		const assetId = crypto.randomUUID();
		const submissionToken = crypto.randomUUID();
		const asset = await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId: `image-callback-${assetId}`,
				kind: "OUTPUT",
				status: "VERIFYING",
				objectKey: `users/image-callback/assets/${assetId}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum: "c".repeat(64),
				finalizedAt: new Date(),
				verificationEngine: "legacy",
				verificationProvider: "seeapi",
				verificationGeneration: 2,
				verificationSubmissionToken: submissionToken,
				verificationProviderTaskId: `review_${assetId}`,
				verificationSubmissionUncertain: false,
				verificationNextAttemptAt: new Date(Date.now() + 60_000),
				...patch,
			},
		});
		assetIds.push(assetId);
		return {
			asset,
			identity: { assetId, generation: 2, submissionToken },
			read: () => client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		};
	}

	it("preserves an early callback until the original submission is bound", async () => {
		const f = await fixture({
			verificationProviderTaskId: null,
			verificationSubmissionUncertain: true,
			verificationLeaseToken: crypto.randomUUID(),
			verificationLeasedUntil: new Date(Date.now() + 60_000),
		});
		await expect(wakeImageModeration(f.identity, client)).resolves.toBe("recorded");
		const signaled = await f.read();
		expect(signaled.verificationCallbackReceivedAt).toBeInstanceOf(Date);
		expect({
			...signaled,
			verificationCallbackReceivedAt: f.asset.verificationCallbackReceivedAt,
			updatedAt: f.asset.updatedAt,
		}).toEqual(f.asset);
		await expect(wakeImageModeration(f.identity, client)).resolves.toBe("recorded");
		expect(await f.read()).toEqual(signaled);
		await expect(
			client.assetModerationResult.count({ where: { assetId: f.asset.id } }),
		).resolves.toBe(0);
	});

	it("records an active-query callback, then keeps that PENDING commit immediately due", async () => {
		const f = await fixture();
		const leaseToken = crypto.randomUUID();
		const leasedUntil = new Date(Date.now() + 60_000);
		let releaseQuery!: () => void;
		const release = new Promise<void>((resolve) => {
			releaseQuery = resolve;
		});
		let queryHasLock!: () => void;
		const locked = new Promise<void>((resolve) => {
			queryHasLock = resolve;
		});
		const query = client.$transaction(async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${f.asset.id}`}, 0))`;
			await tx.mediaAsset.update({
				where: { id: f.asset.id },
				data: { verificationLeaseToken: leaseToken, verificationLeasedUntil: leasedUntil },
			});
			queryHasLock();
			await release;
		});
		await locked;
		const callback = wakeImageModeration(f.identity, client);
		releaseQuery();
		await query;
		await expect(callback).resolves.toBe("recorded");
		const leased = await f.read();
		expect(leased).toMatchObject({
			verificationLeaseToken: leaseToken,
			verificationLeasedUntil: leasedUntil,
			verificationNextAttemptAt: f.asset.verificationNextAttemptAt,
		});
		expect(leased.verificationCallbackReceivedAt).toBeInstanceOf(Date);
		const earliest = Date.now();
		const pending = await client.$transaction(async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${f.asset.id}`}, 0))`;
			const current = await tx.mediaAsset.findUniqueOrThrow({ where: { id: f.asset.id } });
			expect(current.verificationLeaseToken).toBe(leaseToken);
			const now = new Date();
			return tx.mediaAsset.update({
				where: { id: current.id },
				data: {
					verificationLeaseToken: null,
					verificationLeasedUntil: null,
					verificationNextAttemptAt: imageModerationRetryAt({
						retryAt: new Date(now.getTime() + 30_000),
						now,
						callbackReceivedAt: current.verificationCallbackReceivedAt,
						claimedCallbackReceivedAt: f.asset.verificationCallbackReceivedAt,
						providerTaskId: current.verificationProviderTaskId,
						submissionUncertain: current.verificationSubmissionUncertain,
						pending: true,
					}),
				},
			});
		});
		expect(pending.verificationNextAttemptAt!.getTime()).toBeGreaterThanOrEqual(earliest);
		expect(pending.verificationNextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now());
		expect(pending.verificationNextAttemptAt!.getTime()).toBeLessThan(
			f.asset.verificationNextAttemptAt!.getTime(),
		);
		expect({
			...pending,
			updatedAt: f.asset.updatedAt,
			verificationNextAttemptAt: f.asset.verificationNextAttemptAt,
			verificationCallbackReceivedAt: f.asset.verificationCallbackReceivedAt,
		}).toEqual(f.asset);
		// A duplicate can retry a lost execution wake but creates no new signal.
		await expect(wakeImageModeration(f.identity, client)).resolves.toBe("ready");
		expect(await f.read()).toEqual(pending);
		await expect(
			client.assetModerationResult.count({ where: { assetId: f.asset.id } }),
		).resolves.toBe(0);
		await expect(client.outboxEvent.count({ where: { aggregateId: f.asset.id } })).resolves.toBe(0);
	});

	it("cannot overwrite a callback that arrives immediately after a PENDING commit", async () => {
		const f = await fixture();
		let releaseCommit!: () => void;
		const release = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		let acquired!: () => void;
		const locked = new Promise<void>((resolve) => {
			acquired = resolve;
		});
		const waiting = client.$transaction(async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${f.asset.id}`}, 0))`;
			await tx.mediaAsset.update({
				where: { id: f.asset.id },
				data: { verificationNextAttemptAt: new Date(Date.now() + 30_000) },
			});
			acquired();
			await release;
		});
		await locked;
		const callback = wakeImageModeration(f.identity, client);
		releaseCommit();
		await waiting;
		await expect(callback).resolves.toBe("ready");
		const signaled = await f.read();
		expect(signaled.verificationNextAttemptAt).toEqual(signaled.verificationCallbackReceivedAt);
		expect(signaled.verificationNextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now());
	});

	it("coalesces concurrent duplicate callbacks and preserves a consumed signal's backoff", async () => {
		const f = await fixture();
		await Promise.all(Array.from({ length: 8 }, () => wakeImageModeration(f.identity, client)));
		const signaled = await f.read();
		expect(signaled.verificationCallbackReceivedAt).toBeInstanceOf(Date);
		const pending = await client.mediaAsset.update({
			where: { id: f.asset.id },
			data: { verificationNextAttemptAt: new Date(Date.now() + 30_000) },
		});
		await expect(wakeImageModeration(f.identity, client)).resolves.toBe("recorded");
		expect(await f.read()).toEqual(pending);
	});

	it.each(["asset", "generation", "submission"] as const)(
		"cannot wake another %s after the original attempt changes",
		async (field) => {
			const f = await fixture();
			const identity = { ...f.identity };
			if (field === "asset") identity.assetId = crypto.randomUUID();
			else if (field === "generation") identity.generation += 1;
			else identity.submissionToken = crypto.randomUUID();
			await expect(wakeImageModeration(identity, client)).resolves.toBe("invalid");
			expect(await f.read()).toEqual(f.asset);
		},
	);
});
