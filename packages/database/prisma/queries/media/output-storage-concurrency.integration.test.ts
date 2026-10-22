import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "../../generated/client";
import { localSqlMetricsEnabled } from "../../query-metrics";
import {
	completeGenerationOutputTransferTransaction,
	markMediaAssetDeletedTransaction,
	reserveGenerationOutputStorageTransaction,
} from "./assets";
import { expireGuestMediaTransaction } from "./guest-retention";

let client: PrismaClient;
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
afterAll(() => client?.$disconnect());
beforeEach(() => vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

function deferred() {
	let resolve!: () => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<void>((done, failed) => {
		resolve = done;
		reject = failed;
	});
	return { promise, resolve, reject };
}
async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(label)), 2_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
async function fixture(ownerId = `output-rc-${crypto.randomUUID()}`) {
	const token = crypto.randomUUID();
	const asset = await client.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind: "OUTPUT",
			status: "VERIFYING",
			objectKey: `users/${ownerId}/${token}.png`,
			mimeType: "image/png",
			byteSize: 0n,
			outputTransferToken: token,
			outputTransferLeaseExpiresAt: new Date(Date.now() + 60_000),
			outputStagingObjectKey: `users/${ownerId}/staging/${token}.png`,
		},
	});
	return { assetId: asset.id, ownerId, transferToken: token, bytes: 6n, maximumStorageBytes: 10n };
}
const completion = (f: Awaited<ReturnType<typeof fixture>>) => ({
	...f,
	checksum: "a".repeat(64),
	storageEtag: "rc-etag",
	storageVersionId: null,
	deferOutputReview: true,
});

describe("owner-fenced output storage with fresh reads", () => {
	it.each(
		(["lease", "guest retention"] as const).flatMap((expiry) =>
			(["owner", "binding", "row"] as const).flatMap((lock) =>
				(["reserve", "complete"] as const).map((operation) => ({ expiry, lock, operation })),
			),
		),
	)(
		"rejects $operation when $expiry expires while waiting for the $lock lock",
		async ({ expiry, lock, operation }) => {
			const f = await fixture();
			if (operation === "complete") await reserveGenerationOutputStorageTransaction(f, client);
			const [clock] = await client.$queryRaw<
				Array<{ now: Date }>
			>`SELECT clock_timestamp() AS "now"`;
			const due = new Date(clock!.now.getTime() + 1_000);
			await client.mediaAsset.update({
				where: { id: f.assetId },
				data:
					expiry === "lease"
						? { outputTransferLeaseExpiresAt: due }
						: { retentionClass: "GUEST_TRIAL", deleteAfter: due },
			});
			const ready = deferred();
			const release = deferred();
			let blockerPid = 0;
			const blocker = client.$transaction(
				async (tx) => {
					const [backend] = await tx.$queryRaw<
						Array<{ pid: number }>
					>`SELECT pg_backend_pid() AS pid`;
					blockerPid = backend!.pid;
					if (lock === "owner")
						await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-owner-storage-usage:USER:${f.ownerId}`}, 0))`;
					else if (lock === "binding")
						await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-asset-generation-binding:${f.assetId}`}, 0))`;
					else await tx.$queryRaw`SELECT id FROM media_asset WHERE id = ${f.assetId} FOR UPDATE`;
					ready.resolve();
					await release.promise;
				},
				{ timeout: 10_000 },
			);
			void blocker.catch(ready.reject);
			let pending: Promise<unknown> | undefined;
			try {
				await bounded(ready.promise, "EXPIRY_BLOCKER_NOT_READY");
				pending =
					operation === "reserve"
						? reserveGenerationOutputStorageTransaction(f, client)
						: completeGenerationOutputTransferTransaction(
								{
									...completion(f),
									...(expiry === "guest retention"
										? {
												guestWatermark: {
													version: "test-watermark",
													deleteAfter: due,
													watermarkedAt: clock!.now,
													cleanStagingDeletedAt: clock!.now,
												},
											}
										: {}),
								},
								client,
							);
				const outcome = pending.then(
					(value) => ({ value, error: undefined }),
					(error: unknown) => ({ value: undefined, error }),
				);
				await (async () => {
					const waitDeadline = Date.now() + 2_000;
					while (Date.now() < waitDeadline) {
						const [waiting] = await client.$queryRaw<Array<{ found: boolean }>>`
						SELECT EXISTS (
							SELECT 1 FROM pg_stat_activity
							WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
							  AND xact_start < ${due}
						) AS found
					`;
						if (waiting?.found) return;
						await new Promise((resolve) => setTimeout(resolve, 5));
					}
					throw new Error("EXPECTED_LIVE_TRANSACTION_WAITING_BEFORE_EXPIRY");
				})();
				// Wait on the PostgreSQL clock, not a mocked JS timer or a fabricated
				// input.now. The production call must detect the real lock-wait expiry.
				await client.$queryRaw`SELECT pg_sleep(GREATEST(EXTRACT(EPOCH FROM (${due}::timestamptz - clock_timestamp())), 0) + 0.02)::text`;
				release.resolve();
				await blocker;
				const result = await outcome;
				if (expiry === "lease") {
					expect(result.error).toBeUndefined();
					expect(result.value).toMatchObject({ outcome: "STALE" });
				} else
					expect(result.error).toMatchObject({
						message: "GENERATION_OUTPUT_GUEST_RETENTION_EXPIRED",
					});
				expect(
					await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } }),
				).toMatchObject({
					status: "VERIFYING",
					outputTransferToken: f.transferToken,
					finalizedAt: null,
					checksum: null,
					byteSize: 0n,
				});
				const reservation = await client.storageUsageReservation.findUnique({
					where: { referenceKey: `generation-output:${f.assetId}` },
				});
				if (operation === "reserve") expect(reservation).toBeNull();
				else expect(reservation).toMatchObject({ status: "ACTIVE", bytes: f.bytes });
				expect(await client.outboxEvent.count({ where: { aggregateId: f.assetId } })).toBe(0);
			} finally {
				release.resolve();
				await Promise.allSettled([blocker, ...(pending ? [pending] : [])]);
			}
		},
	);

	it.each([
		["retention", "reserve"],
		["delete", "reserve"],
		["retention", "complete"],
		["delete", "complete"],
	] as const)(
		"does not revive storage after a concurrent %s tombstone while trying to %s",
		async (writer, operation) => {
			const f = await fixture();
			if (operation === "complete") await reserveGenerationOutputStorageTransaction(f, client);
			const retentionNow = new Date("2000-01-01T00:00:01.000Z");
			if (writer === "retention")
				await client.mediaAsset.update({
					where: { id: f.assetId },
					data: {
						retentionClass: "GUEST_TRIAL",
						deleteAfter: new Date(retentionNow.getTime() - 1_000),
					},
				});
			const ready = deferred();
			const release = deferred();
			const deletingClient = client.$extends({
				query: {
					mediaAsset: {
						async update({ args, query }) {
							const result = await query(args);
							if (args.where.id === f.assetId && args.data.status === "DELETED") {
								ready.resolve();
								await release.promise;
							}
							return result;
						},
						async updateMany({ args, query }) {
							const result = await query(args);
							if (args.where?.id === f.assetId && args.data.status === "DELETED") {
								ready.resolve();
								await release.promise;
							}
							return result;
						},
					},
				},
			}) as unknown as PrismaClient;
			const deletion =
				writer === "retention"
					? expireGuestMediaTransaction({ now: retentionNow, limit: 1 }, deletingClient)
					: markMediaAssetDeletedTransaction(f, deletingClient);
			void deletion.catch(ready.reject);
			let pending: Promise<unknown> | undefined;
			try {
				await bounded(ready.promise, "TOMBSTONE_NOT_HELD");
				pending =
					operation === "reserve"
						? reserveGenerationOutputStorageTransaction(f, client)
						: completeGenerationOutputTransferTransaction(
								{
									...completion(f),
									// The transfer started before expiry; retention commits while
									// its earlier completion timestamp is still in flight.
									...(writer === "retention"
										? {
												now: new Date(retentionNow.getTime() - 2_000),
												guestWatermark: {
													version: "test-watermark",
													watermarkedAt: new Date(retentionNow.getTime() - 2_000),
													cleanStagingDeletedAt: new Date(retentionNow.getTime() - 2_000),
													deleteAfter: new Date(retentionNow.getTime() - 1_000),
												},
											}
										: {}),
								},
								client,
							);
				expect(
					await Promise.race([
						pending.then(() => "completed"),
						new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
					]),
				).toBe("waiting");
				release.resolve();
				await deletion;
				expect(await pending).toMatchObject({ outcome: "STALE" });
				expect(
					await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } }),
				).toMatchObject({ status: "DELETED", checksum: null, byteSize: 0n });
				const reservation = await client.storageUsageReservation.findUnique({
					where: { referenceKey: `generation-output:${f.assetId}` },
				});
				if (operation === "reserve") expect(reservation).toBeNull();
				else expect(reservation).toMatchObject({ status: "ACTIVE", bytes: f.bytes });
				expect(
					await client.outboxEvent.count({
						where: { aggregateId: f.assetId, eventType: "MEDIA_ASSET_VERIFY" },
					}),
				).toBe(0);
			} finally {
				release.resolve();
				await Promise.allSettled([deletion, ...(pending ? [pending] : [])]);
			}
		},
	);

	it("serializes two output reservations at the same owner cap", async () => {
		const first = await fixture();
		const second = await fixture(first.ownerId);
		const results = await Promise.allSettled([
			reserveGenerationOutputStorageTransaction(first, client),
			reserveGenerationOutputStorageTransaction(second, client),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toMatchObject([
			{ reason: { code: "STORAGE_QUOTA_EXCEEDED" } },
		]);
		expect(
			await client.storageUsageReservation.aggregate({
				where: { ownerId: first.ownerId, status: "ACTIVE" },
				_sum: { bytes: true },
			}),
		).toMatchObject({ _sum: { bytes: 6n } });
	});

	it("rejects a stale transfer token and rolls completion back before exposing a review identity", async () => {
		const f = await fixture();
		await reserveGenerationOutputStorageTransaction(f, client);
		const replacementToken = crypto.randomUUID();
		await client.mediaAsset.update({
			where: { id: f.assetId },
			data: { outputTransferToken: replacementToken },
		});
		expect(await reserveGenerationOutputStorageTransaction(f, client)).toMatchObject({
			outcome: "STALE",
		});
		expect(await completeGenerationOutputTransferTransaction(completion(f), client)).toMatchObject({
			outcome: "STALE",
		});
		const failing = client.$extends({
			query: {
				outboxEvent: {
					async createMany({ args, query }) {
						const data = Array.isArray(args.data) ? args.data : [args.data];
						if (data.some((row) => row.eventType === "MEDIA_ASSET_VERIFY"))
							throw new Error("REVIEW_INSERT_FAILED");
						return query(args);
					},
				},
			},
		}) as unknown as PrismaClient;
		await expect(
			completeGenerationOutputTransferTransaction(
				completion({ ...f, transferToken: replacementToken }),
				failing,
			),
		).rejects.toThrow("REVIEW_INSERT_FAILED");
		expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } })).toMatchObject({
			outputTransferToken: replacementToken,
			finalizedAt: null,
			checksum: null,
			byteSize: 0n,
		});
		expect(
			await client.storageUsageReservation.findUniqueOrThrow({
				where: { referenceKey: `generation-output:${f.assetId}` },
			}),
		).toMatchObject({ status: "ACTIVE" });
		expect(await client.outboxEvent.count({ where: { aggregateId: f.assetId } })).toBe(0);
	});
});
