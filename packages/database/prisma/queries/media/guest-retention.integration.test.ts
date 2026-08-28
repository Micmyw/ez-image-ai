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
				status: "READY",
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

		await expireGuestMediaTransaction({ now, limit: 25 }, client);
		await expireGuestMediaTransaction({ now: new Date(now.getTime() + 1_000), limit: 25 }, client);

		expect(await client.outboxEvent.count({ where: { aggregateId: asset.id } })).toBe(3);
		expect(
			await client.outboxEvent.groupBy({
				by: ["dedupeKey"],
				where: { aggregateId: asset.id },
				_count: { _all: true },
			}),
		).toEqual(expect.arrayContaining([expect.objectContaining({ _count: { _all: 1 } })]));
	});
});

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
	if (
		parsed.hostname !== "127.0.0.1" ||
		!parsed.pathname.toLowerCase().includes("testing") ||
		parsed.pathname === "/ezpic_testing"
	) {
		throw new Error("TEST_DATABASE_URL must target a dedicated loopback testing database");
	}
}
