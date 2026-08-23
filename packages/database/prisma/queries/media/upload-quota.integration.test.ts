import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { createMediaUploadSessionTransaction } from "./assets";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function safeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	const parsed = new URL(TEST_DATABASE_URL);
	if (
		!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(parsed.pathname.slice(1).toLowerCase())
	) {
		throw new Error("UNSAFE_TEST_DATABASE");
	}
	return TEST_DATABASE_URL;
}

describe("media upload quota PostgreSQL transaction", () => {
	let client: PrismaClient;

	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl() }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("serializes concurrent session creation so aggregate bytes never exceed quota", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `upload-quota-${suffix}`;
		const attempts = await Promise.allSettled(
			[1, 2].map((index) =>
				createMediaUploadSessionTransaction(
					{
						assetId: `asset_${index}_${suffix}`,
						sessionId: `session_${index}_${suffix}`,
						ownerType: "USER",
						ownerId,
						kind: "INPUT",
						objectKey: `users/${ownerId}/assets/asset_${index}_${suffix}/original.png`,
						mimeType: "image/png",
						expectedBytes: 60n,
						tokenHash: `token_${index}_${suffix}`,
						expiresAt: new Date(Date.now() + 60_000),
						multipartUploadId: null,
						limits: { maximumActiveSessions: 5, maximumReservedBytes: 100n },
					},
					client,
				),
			),
		);
		expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
		expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
		const aggregate = await client.storageUsageReservation.aggregate({
			where: { ownerType: "USER", ownerId, status: "ACTIVE" },
			_sum: { bytes: true },
		});
		expect(aggregate._sum.bytes).toBe(60n);
	});
});
