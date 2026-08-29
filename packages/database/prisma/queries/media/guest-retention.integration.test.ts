import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { expireGuestMediaTransaction } from "./guest-retention";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;
let client: PrismaClient;

describe("guest absolute media retention", () => {
	beforeAll(async () => {
		assertSafeTestDatabaseUrl(TEST_DATABASE_URL, DATABASE_URL);
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }),
		});
		await client.$connect();
	});

	beforeEach(async () => {
		await client.$executeRawUnsafe(
			'TRUNCATE TABLE "user", "guest_abuse_bucket", "guest_risk_budget_bucket", "outbox_event", "generation_quote" CASCADE',
		);
	});

	afterAll(async () => client?.$disconnect());

	it("denies expired guest asset authorization before scheduling every physical object deletion", async () => {
		const now = new Date("2026-08-28T12:00:00.000Z");
		const ownerId = await createAnonymousOwner("due");
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "VERIFYING",
				retentionClass: "GUEST_TRIAL",
				deleteAfter: new Date(now.getTime() - 1),
				objectKey: `users/${ownerId}/assets/input/original.png`,
				mimeType: "image/png",
				byteSize: 128n,
				checksum: "a".repeat(64),
				finalizedAt: new Date(now.getTime() - 60_000),
			},
		});
		await client.mediaUploadSession.create({
			data: {
				assetId: asset.id,
				tokenHash: randomUUID(),
				stagingObjectKey: `users/${ownerId}/staging/input/upload.png`,
				multipartUploadId: "multipart-input",
				status: "COMPLETED",
				expectedBytes: 128n,
				expiresAt: new Date(now.getTime() - 1),
				completedAt: new Date(now.getTime() - 60_000),
			},
		});

		await expireGuestMediaTransaction({ now, limit: 25 }, client);

		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }),
		).resolves.toMatchObject({
			status: "DELETED",
			deletedAt: now,
		});
		const events = await client.outboxEvent.findMany({
			where: { aggregateId: asset.id },
			orderBy: { dedupeKey: "asc" },
		});
		expect(
			events.map((event) => [event.eventType, (event.payload as { objectKey: string }).objectKey]),
		).toEqual([
			["MEDIA_OBJECT_DELETE", asset.objectKey],
			["MEDIA_MULTIPART_ABORT", `users/${ownerId}/staging/input/upload.png`],
		]);
		expect(events.every((event) => event.status === "PENDING" && event.processedAt === null)).toBe(
			true,
		);
	});

	it("emits one idempotent cleanup event per object across repeated sweeps", async () => {
		const now = new Date("2026-08-28T12:00:00.000Z");
		const ownerId = await createAnonymousOwner("idempotent");
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId,
				kind: "OUTPUT",
				status: "VERIFYING",
				retentionClass: "GUEST_TRIAL",
				deleteAfter: now,
				objectKey: `users/${ownerId}/assets/output/original.png`,
				outputStagingObjectKey: `users/${ownerId}/staging/output/clean.png`,
				outputPromotionMultipartUploadId: "multipart-output",
				mimeType: "image/png",
				byteSize: 128n,
			},
		});

		const first = await expireGuestMediaTransaction({ now, limit: 25 }, client);
		const replay = await expireGuestMediaTransaction(
			{ now: new Date(now.getTime() + 1_000), limit: 25 },
			client,
		);

		expect(first.cleanupEvents).toBe(3);
		expect(replay.cleanupEvents).toBe(0);
		expect(await client.outboxEvent.count({ where: { aggregateId: asset.id } })).toBe(3);
		expect(
			await client.outboxEvent.groupBy({
				by: ["dedupeKey"],
				where: { aggregateId: asset.id },
				_count: { _all: true },
			}),
		).toEqual(expect.arrayContaining([expect.objectContaining({ _count: { _all: 1 } })]));
	});

	it("removes an expired bootstrap-only anonymous principal and prunes expired abuse evidence", async () => {
		const now = new Date("2026-08-28T12:00:00.000Z");
		const ownerId = await createAnonymousOwner("bootstrap-only");
		await client.session.create({
			data: {
				id: randomUUID(),
				token: randomUUID(),
				userId: ownerId,
				expiresAt: new Date(now.getTime() - 1),
				createdAt: new Date(now.getTime() - 60_000),
				updatedAt: new Date(now.getTime() - 60_000),
			},
		});
		await client.guestSessionBootstrap.create({
			data: {
				ownerId,
				promotionPeriod: "launch-cleanup",
				claimHash: "b".repeat(64),
				idempotencyKey: randomUUID(),
				createdAt: new Date(now.getTime() - 60_000),
				expiresAt: new Date(now.getTime() - 1),
				completedAt: new Date(now.getTime() - 30_000),
			},
		});
		await client.guestAbuseBucket.create({
			data: {
				scope: "guest-bootstrap-ip-minute",
				subjectHash: "c".repeat(64),
				windowStart: new Date(now.getTime() - 120_000),
				windowEnd: new Date(now.getTime() - 60_000),
				expiresAt: new Date(now.getTime() - 1),
			},
		});

		const result = await expireGuestMediaTransaction({ now, limit: 25 }, client);

		expect(result.removedAnonymousUsers).toBe(1);
		await expect(client.user.count({ where: { id: ownerId } })).resolves.toBe(0);
		await expect(client.session.count({ where: { userId: ownerId } })).resolves.toBe(0);
		await expect(client.guestAbuseBucket.count()).resolves.toBe(0);
	});

	it("never deletes registered or not-yet-expired principals", async () => {
		const now = new Date("2026-08-28T12:00:00.000Z");
		const anonymousOwnerId = await createAnonymousOwner("not-due");
		const registered = await client.user.create({
			data: {
				name: "Registered",
				email: `${randomUUID()}@example.test`,
				emailVerified: true,
				isAnonymous: false,
				createdAt: now,
				updatedAt: now,
			},
		});
		for (const ownerId of [anonymousOwnerId, registered.id]) {
			await client.guestSessionBootstrap.create({
				data: {
					ownerId,
					promotionPeriod: `period-${ownerId}`,
					claimHash: createHashValue(ownerId),
					idempotencyKey: randomUUID(),
					createdAt: now,
					expiresAt: new Date(now.getTime() + 60_000),
					completedAt: now,
				},
			});
		}

		await expireGuestMediaTransaction({ now, limit: 25 }, client);

		await expect(
			client.user.count({ where: { id: { in: [anonymousOwnerId, registered.id] } } }),
		).resolves.toBe(2);
	});

	it("is idempotent under concurrent cleanup of one expired bootstrap-only principal", async () => {
		const now = new Date("2026-08-28T12:00:00.000Z");
		const ownerId = await createAnonymousOwner("concurrent");
		await client.guestSessionBootstrap.create({
			data: {
				ownerId,
				promotionPeriod: "concurrent-cleanup",
				claimHash: "d".repeat(64),
				idempotencyKey: randomUUID(),
				createdAt: new Date(now.getTime() - 60_000),
				expiresAt: new Date(now.getTime() - 1),
				completedAt: new Date(now.getTime() - 30_000),
			},
		});

		const results = await Promise.all([
			expireGuestMediaTransaction({ now, limit: 25 }, client),
			expireGuestMediaTransaction({ now, limit: 25 }, client),
		]);

		expect(results.reduce((sum, result) => sum + result.removedAnonymousUsers, 0)).toBe(1);
		await expect(client.user.count({ where: { id: ownerId } })).resolves.toBe(0);
	});
});

function createHashValue(value: string): string {
	return Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
}

async function createAnonymousOwner(label: string): Promise<string> {
	const suffix = randomUUID();
	const owner = await client.user.create({
		data: {
			name: `Guest ${label}`,
			email: `${label}-${suffix}@anonymous.invalid`,
			emailVerified: false,
			isAnonymous: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	return owner.id;
}

function assertSafeTestDatabaseUrl(
	value: string | undefined,
	databaseUrl: string | undefined,
): void {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	if (value === databaseUrl) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL");
	const parsed = new URL(value);
	const pathname = parsed.pathname.toLowerCase();
	const databaseName = pathname.slice(1);
	if (
		parsed.hostname !== "127.0.0.1" ||
		pathname === "/ezpic" ||
		pathname === "/ezpic_testing" ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(databaseName)
	) {
		throw new Error("TEST_DATABASE_URL must target a dedicated loopback testing database");
	}
}
