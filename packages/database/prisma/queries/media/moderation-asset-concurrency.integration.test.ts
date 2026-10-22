import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { localSqlMetricsEnabled } from "../../query-metrics";
import {
	recordLockedAssetModerationOutcome,
	recordModerationOutcome,
} from "./moderation-operations";
import type { MediaDatabaseClient } from "./types";

let client: PrismaClient;
beforeAll(() => {
	const connectionString = process.env.TEST_DATABASE_URL;
	if (
		!connectionString ||
		connectionString === process.env.DATABASE_URL ||
		!localSqlMetricsEnabled(connectionString, "true")
	)
		throw new Error("ISOLATED_LOCAL_TEST_DATABASE_REQUIRED");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 12 }) });
});
afterAll(() => client?.$disconnect());

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}
async function bounded<T>(operation: Promise<T>, label: string) {
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
async function assetFixture(
	provider = `seeapi-test-${crypto.randomUUID()}`,
	kind: "INPUT" | "OUTPUT" = "INPUT",
) {
	const ownerId = crypto.randomUUID();
	const asset = await client.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind,
			status: "VERIFYING",
			verificationEngine: "legacy",
			objectKey: `users/${ownerId}/incident-test.png`,
			mimeType: "image/png",
			byteSize: 1_000n,
			checksum: "a".repeat(64),
			finalizedAt: new Date(),
		},
	});
	return { assetId: asset.id, provider, ownerId };
}
function outcome(f: Awaited<ReturnType<typeof assetFixture>>, startedAt = new Date()) {
	return {
		targetType: "ASSET" as const,
		targetId: f.assetId,
		provider: f.provider,
		stage: "IMAGE" as const,
		epoch: "1",
		failures: 0,
		lastErrorCode: "",
		startedAt,
		lastFailureAt: startedAt,
		status: "APPROVED" as const,
		serviceResponded: true,
		detectorCompleted: true,
	};
}
async function success(
	tx: MediaDatabaseClient,
	f: Awaited<ReturnType<typeof assetFixture>>,
	startedAt = new Date(),
) {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${f.assetId}`}, 0))`;
	const previous = await tx.moderationReview.findUnique({
		where: { targetType_targetId: { targetType: "ASSET", targetId: f.assetId } },
	});
	await recordLockedAssetModerationOutcome(outcome(f, startedAt), previous, tx);
}
async function failure(
	tx: MediaDatabaseClient,
	f: Awaited<ReturnType<typeof assetFixture>>,
	at = new Date(),
) {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${f.assetId}`}, 0))`;
	await recordModerationOutcome(
		{
			...outcome(f, at),
			failures: 4,
			lastErrorCode: "MODERATION_TIMEOUT",
			status: "BLOCKED",
			serviceResponded: false,
		},
		tx,
	);
}
function heldSuccess(f: Awaited<ReturnType<typeof assetFixture>>, at = new Date()) {
	const ready = deferred<void>();
	const release = deferred<void>();
	const completed = client.$transaction(
		async (tx) => {
			await success(tx, f, at);
			ready.resolve();
			await release.promise;
		},
		{ timeout: 10_000 },
	);
	void completed.catch(ready.reject);
	return { ready: ready.promise, release: release.resolve, completed };
}
async function waitForExclusiveWaiter(pid: number) {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const [row] = await client.$queryRaw<
			Array<{ waiting: boolean }>
		>`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${pid} AND locktype = 'advisory' AND mode = 'ExclusiveLock' AND NOT granted) AS waiting`;
		if (row?.waiting) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("EXPECTED_EXCLUSIVE_INCIDENT_WAITER");
}
async function recoveredNotices(incidentId: string) {
	return client.outboxEvent.count({
		where: { dedupeKey: `moderation-incident:${incidentId}:RECOVERED` },
	});
}

describe("locked first asset approval incident concurrency", () => {
	it("allows an independent OUTPUT approval while an INPUT owner's successful transaction stays open", async () => {
		const first = await assetFixture();
		const second = await assetFixture(first.provider, "OUTPUT");
		const held = heldSuccess(first);
		let other: Promise<unknown> | undefined;
		try {
			await bounded(held.ready, "FIRST_ASSET_NOT_READY");
			other = client.$transaction((tx) => success(tx, second));
			await bounded(other, "INDEPENDENT_ASSET_APPROVAL_WAS_SERIALIZED");
			expect(await client.moderationReview.count({ where: { provider: first.provider } })).toBe(0);
		} finally {
			held.release();
			await Promise.allSettled([held.completed, ...(other ? [other] : [])]);
		}
	});

	it("still fences a technical failure exclusively while independent successful evidence is uncommitted", async () => {
		const first = await assetFixture();
		const failed = await assetFixture(first.provider, "OUTPUT");
		const held = heldSuccess(first);
		let writer: Promise<unknown> | undefined;
		try {
			await bounded(held.ready, "FIRST_ASSET_NOT_READY");
			const backend = deferred<number>();
			writer = client.$transaction(
				async (tx) => {
					const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
					backend.resolve(row!.pid);
					await failure(tx, failed);
				},
				{ timeout: 10_000 },
			);
			void writer.catch(backend.reject);
			await waitForExclusiveWaiter(await backend.promise);
			held.release();
			await writer;
			expect(
				await client.moderationIncident.findUnique({
					where: { activeKey: `${first.provider}:IMAGE` },
				}),
			).toMatchObject({ status: "OPEN", failureCount: 4 });
		} finally {
			held.release();
			await Promise.allSettled([held.completed, ...(writer ? [writer] : [])]);
		}
	});

	it("claims one recovery notice across concurrent first approvals on distinct assets", async () => {
		const failed = await assetFixture();
		await client.$transaction((tx) => failure(tx, failed, new Date(Date.now() - 1_000)));
		const incident = await client.moderationIncident.findUniqueOrThrow({
			where: { activeKey: `${failed.provider}:IMAGE` },
		});
		const assets = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				assetFixture(failed.provider, i % 2 ? "OUTPUT" : "INPUT"),
			),
		);
		await Promise.all(assets.map((f) => client.$transaction((tx) => success(tx, f))));
		expect(
			await client.moderationIncident.findUnique({ where: { id: incident.id } }),
		).toMatchObject({ status: "RECOVERED", activeKey: null });
		expect(await recoveredNotices(incident.id)).toBe(1);
		expect(await client.moderationReview.count({ where: { provider: failed.provider } })).toBe(1);
	});

	it("retains an administrator rejection when the asset already has review history", async () => {
		const f = await assetFixture();
		await client.$transaction((tx) => failure(tx, f));
		const review = await client.moderationReview.findUniqueOrThrow({
			where: { targetType_targetId: { targetType: "ASSET", targetId: f.assetId } },
		});
		await client.moderationReview.update({
			where: { id: review.id },
			data: {
				status: "REJECTED",
				resolvedBy: "fixture-admin",
				resolvedAt: new Date(),
				version: { increment: 1 },
			},
		});
		const before = await client.moderationReview.findUniqueOrThrow({ where: { id: review.id } });
		await client.$transaction((tx) => success(tx, f));
		expect(await client.moderationReview.findUnique({ where: { id: review.id } })).toEqual(before);
		expect(await recoveredNotices(review.incidentId!)).toBe(0);
	});

	it("does not close a newer failure with an older asset success", async () => {
		const failed = await assetFixture();
		const approved = await assetFixture(failed.provider, "OUTPUT");
		const at = new Date();
		await client.$transaction((tx) => failure(tx, failed, at));
		await client.$transaction((tx) => success(tx, approved, new Date(at.getTime() - 1)));
		expect(
			await client.moderationIncident.findUnique({
				where: { activeKey: `${failed.provider}:IMAGE` },
			}),
		).toMatchObject({ status: "OPEN" });
	});

	it("rolls back shared incident recovery and its notice with the asset evidence transaction", async () => {
		const failed = await assetFixture();
		const approved = await assetFixture(failed.provider, "OUTPUT");
		await client.$transaction((tx) => failure(tx, failed, new Date(Date.now() - 1_000)));
		const incident = await client.moderationIncident.findUniqueOrThrow({
			where: { activeKey: `${failed.provider}:IMAGE` },
		});
		await expect(
			client.$transaction(async (tx) => {
				await success(tx, approved);
				throw new Error("ROLLBACK_ASSET_FIXTURE");
			}),
		).rejects.toThrow("ROLLBACK_ASSET_FIXTURE");
		expect(
			await client.moderationIncident.findUnique({ where: { id: incident.id } }),
		).toMatchObject({ status: "OPEN", activeKey: `${failed.provider}:IMAGE` });
		expect(await recoveredNotices(incident.id)).toBe(0);
	});
});
