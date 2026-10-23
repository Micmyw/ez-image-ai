import { PrismaPg } from "@prisma/adapter-pg";
import { TestMediaSafetyAdapter } from "@repo/ai";
import { claimOutboxBatch, completeOutboxEvent } from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { runWithRequestDefer } from "@repo/utils/request-lifecycle";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { runWithMediaJobEvents } from "../realtime/context";
import { createDatabaseVerifyUploadDependencies } from "../runtime";
import { deliverOutboxEvent } from "./deliver-outbox-event";

let client: PrismaClient;
const aggregateIds: string[] = [];

beforeAll(() => {
	const connectionString = process.env.TEST_DATABASE_URL;
	if (!connectionString) throw new Error("EXPLICIT_LOCAL_TEST_DATABASE_REQUIRED");
	const url = new URL(connectionString);
	if (
		!["postgres:", "postgresql:"].includes(url.protocol) ||
		url.hostname !== "127.0.0.1" ||
		url.port !== "55432" ||
		(url.pathname !== "/ai_media_foundation_test" &&
			!/^\/ezpic_[a-z0-9_]+_test$/.test(url.pathname)) ||
		url.search ||
		url.hash
	)
		throw new Error("EXPLICIT_LOCAL_TEST_DATABASE_REQUIRED");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 4 }) });
});
beforeEach(() => {
	vi.stubEnv("MEDIA_JOB_EVENTS_ENABLED", "true");
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
afterAll(async () => {
	if (!client) return;
	try {
		await client.outboxEvent.deleteMany({ where: { aggregateId: { in: aggregateIds } } });
		// Keep immutable evidence and its linked fixture rows in this disposable database.
	} finally {
		await client.$disconnect();
	}
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const namespace = (send: (request: Request) => Promise<Response>) => ({
	idFromName: (name: string) => name,
	get: () => ({ fetch: send }),
});

async function fixture(database = client) {
	const assetId = crypto.randomUUID();
	const asset = await client.mediaAsset.create({
		data: {
			id: assetId,
			ownerType: "USER",
			ownerId: assetId,
			kind: "OUTPUT",
			status: "VERIFYING",
			objectKey: `users/${assetId}/assets/${assetId}/original.png`,
			mimeType: "image/png",
			byteSize: 16n,
			checksum: "c".repeat(64),
			finalizedAt: new Date(),
		},
	});
	const identity = {
		ownerType: "USER" as const,
		ownerId: assetId,
		submittedByUserId: assetId,
		productKey: "image-nano-banana-2-lite",
		catalogVersion: "notification-test",
		pricingVersion: "test",
		inputSnapshot: {},
		pricingSnapshot: {},
	};
	const job = await client.generationJob.create({
		data: {
			...identity,
			idempotencyKey: assetId,
			creditsReserved: 5n,
			status: "FINALIZING",
			quote: { create: { ...identity, credits: 5n, costMicros: 10n, expiresAt: new Date() } },
			assets: { create: { assetId, role: "OUTPUT", assetChecksum: asset.checksum! } },
		},
	});
	aggregateIds.push(assetId, job.id);
	const safety = new TestMediaSafetyAdapter("ALLOW");
	const moderate = vi.spyOn(safety, "moderateImage");
	const deps = createDatabaseVerifyUploadDependencies(database, {
		environment: {},
		safety,
		moderationProvider: "seeapi",
		headObject: async () => ({
			contentLength: 16,
			contentType: "image/png",
			etag: "fixture",
			metadata: {},
		}),
		readMediaHeader: async () => Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
		createSignedReadUrl: async () => "https://private.example/fixture.png",
	});
	const notification = () =>
		client.outboxEvent.findFirstOrThrow({
			where: {
				eventType: "MEDIA_JOB_UPDATED",
				aggregateId: job.id,
			},
		});
	return { assetId, job, moderate, verify: () => deps.verify(assetId), notification };
}

describe("committed review notifications in PostgreSQL", () => {
	it("returns committed continuation while delivery is blocked and ACKs only a confirmed receipt", async () => {
		const f = await fixture();
		const receipt = deferred<Response>();
		const retained: Promise<unknown>[] = [];
		let sent: Request | undefined;
		let received: { eventId: string; jobId: string; version: string } | undefined;
		const send = vi.fn(async (request: Request) => {
			sent = request;
			received = await request.json();
			return receipt.promise;
		});
		try {
			const result = await runWithRequestDefer(
				(work) => {
					retained.push(work);
				},
				() => runWithMediaJobEvents(namespace(send), f.verify),
			);
			expect(result.verificationCommit).toMatchObject({ assetId: f.assetId, status: "READY" });
			expect(result.verificationCommit!.eventIds.length).toBeGreaterThan(0);
			expect(send).toHaveBeenCalledOnce();
			expect(sent!.signal.aborted).toBe(false);
			expect(retained).toHaveLength(1);
			const [asset, evidence, intent, continuations] = await Promise.all([
				client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } }),
				client.assetModerationResult.findMany({ where: { assetId: f.assetId } }),
				f.notification(),
				client.outboxEvent.findMany({ where: { id: { in: result.verificationCommit!.eventIds } } }),
			]);
			expect(asset.status).toBe("READY");
			expect(evidence).toEqual([expect.objectContaining({ status: "APPROVED" })]);
			expect(intent).toMatchObject({ status: "PENDING", leaseToken: null, payload: received });
			expect(continuations).toHaveLength(result.verificationCommit!.eventIds.length);
			receipt.resolve(Response.json({ persisted: true, eventId: intent.id }));
			await Promise.all(retained);
			expect(await f.notification()).toMatchObject({ status: "PROCESSED" });
			expect(f.moderate).toHaveBeenCalledOnce();
		} finally {
			receipt.resolve(new Response("test cleanup", { status: 503 }));
			await Promise.allSettled(retained);
		}
	});

	it("recovers a failed notification through the durable consumer without repeating review or dispatch", async () => {
		const f = await fixture();
		const retained: Promise<unknown>[] = [];
		await runWithRequestDefer(
			(work) => {
				retained.push(work);
			},
			() =>
				runWithMediaJobEvents(
					namespace(async () => new Response("unavailable", { status: 503 })),
					f.verify,
				),
		);
		await Promise.all(retained);
		const intent = await f.notification();
		expect(intent.status).toBe("PENDING");
		// Isolate the legacy recovery scan from every other suite's present-time events.
		const scanAt = new Date("1901-01-01T00:00:00.000Z");
		await client.outboxEvent.update({ where: { id: intent.id }, data: { availableAt: scanAt } });
		const workerId = `notification-recovery-${f.assetId}`;
		const [claimed] = await claimOutboxBatch(
			{ workerId, limit: 1, leaseSeconds: 60, now: scanAt },
			client,
		);
		expect(claimed?.id).toBe(intent.id);
		const delivery = { trigger: vi.fn(), triggerAndWait: vi.fn(), resolveDispatchRoute: vi.fn() };
		await runWithMediaJobEvents(
			namespace(async () => Response.json({ persisted: true, eventId: intent.id })),
			() => deliverOutboxEvent(claimed!, delivery),
		);
		await completeOutboxEvent(intent.id, workerId, claimed!.leaseToken, client);
		expect(await f.notification()).toMatchObject({ status: "PROCESSED", leaseToken: null });
		await f.verify();
		expect(f.moderate).toHaveBeenCalledOnce();
		expect(delivery.trigger).not.toHaveBeenCalled();
		expect(delivery.triggerAndWait).not.toHaveBeenCalled();
		expect(delivery.resolveDispatchRoute).not.toHaveBeenCalled();
		expect(await client.assetModerationResult.count({ where: { assetId: f.assetId } })).toBe(1);
		expect(
			await client.outboxEvent.count({
				where: { eventType: "MEDIA_JOB_UPDATED", aggregateId: f.job.id },
			}),
		).toBe(1);
	});

	it("rolls back READY, evidence and continuation when durable notification intent fails", async () => {
		const failed = client.$extends({
			query: {
				outboxEvent: {
					createMany({ args, query }) {
						const rows = Array.isArray(args.data) ? args.data : [args.data];
						if (rows.some((row) => row.eventType === "MEDIA_JOB_UPDATED"))
							throw new Error("NOTIFICATION_INTENT_FAILED");
						return query(args);
					},
				},
			},
		});
		const f = await fixture(failed as unknown as PrismaClient);
		const send = vi.fn();
		const defer = vi.fn();
		await expect(
			runWithRequestDefer(defer, () => runWithMediaJobEvents(namespace(send), f.verify)),
		).rejects.toThrow("NOTIFICATION_INTENT_FAILED");
		expect((await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } })).status).toBe(
			"VERIFYING",
		);
		expect(await client.assetModerationResult.count({ where: { assetId: f.assetId } })).toBe(0);
		expect(await client.outboxEvent.count({ where: { aggregateId: f.job.id } })).toBe(0);
		expect(send).not.toHaveBeenCalled();
		expect(defer).not.toHaveBeenCalled();
	});
});
