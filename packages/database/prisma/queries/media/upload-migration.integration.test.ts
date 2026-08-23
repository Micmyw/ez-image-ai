import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "pg";
import { describe, expect, it } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function safeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	const parsed = new URL(TEST_DATABASE_URL);
	const databaseName = parsed.pathname.slice(1).toLowerCase();
	if (
		!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(databaseName)
	) {
		throw new Error("UNSAFE_TEST_DATABASE");
	}
	return TEST_DATABASE_URL;
}

async function migrationSql(name: string): Promise<string> {
	return readFile(resolve(process.cwd(), "prisma", "migrations", name, "migration.sql"), "utf8");
}

describe("immutable upload migration", () => {
	it("fences old direct-final writers, quarantines legacy assets, and durably queues safe cleanup", async () => {
		const client = new Client({ connectionString: safeTestDatabaseUrl() });
		const schema = `upload_migration_${randomUUID().replaceAll("-", "")}`;
		try {
			await client.connect();
			await client.query(`CREATE SCHEMA "${schema}"`);
			await client.query(`SET search_path TO "${schema}", public`);
			await client.query(`
				CREATE TYPE "UploadSessionStatus" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED', 'ABORTED');
				CREATE TYPE "MediaAssetStatus" AS ENUM ('UPLOADING', 'VERIFYING', 'READY', 'QUARANTINED', 'DELETED');
				CREATE TYPE "StorageReservationStatus" AS ENUM ('ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED');
				CREATE TYPE "ModerationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVIEW', 'ERROR');
				CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING', 'LEASED', 'PROCESSED', 'DEAD_LETTER');
				CREATE TABLE "media_asset" (
					"id" TEXT PRIMARY KEY,
					"status" "MediaAssetStatus" NOT NULL,
					"objectKey" TEXT NOT NULL,
					"checksum" TEXT,
					"deletedAt" TIMESTAMPTZ(3)
				);
				CREATE TABLE "media_upload_session" (
					"id" TEXT PRIMARY KEY,
					"assetId" TEXT NOT NULL,
					"tokenHash" TEXT NOT NULL,
					"multipartUploadId" TEXT,
					"status" "UploadSessionStatus" NOT NULL,
					"expectedBytes" BIGINT NOT NULL,
					"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
					"expiresAt" TIMESTAMPTZ(3) NOT NULL,
					"completedAt" TIMESTAMPTZ(3)
				);
				CREATE TABLE "storage_usage_reservation" (
					"id" TEXT PRIMARY KEY,
					"status" "StorageReservationStatus" NOT NULL,
					"referenceKey" TEXT NOT NULL,
					"releasedAt" TIMESTAMPTZ(3)
				);
				CREATE TABLE "asset_moderation_result" (
					"id" TEXT PRIMARY KEY,
					"assetId" TEXT NOT NULL,
					"status" "ModerationStatus" NOT NULL
				);
				CREATE TABLE "outbox_event" (
					"id" TEXT PRIMARY KEY,
					"eventType" TEXT NOT NULL,
					"aggregateType" TEXT NOT NULL,
					"aggregateId" TEXT NOT NULL,
					"dedupeKey" TEXT NOT NULL UNIQUE,
					"payload" JSONB NOT NULL,
					"status" "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
					"availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
					"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
				);
			`);
			await client.query(
				`INSERT INTO "media_asset" ("id", "status", "objectKey", "checksum") VALUES
					('asset-pending', 'UPLOADING', 'users/u/assets/pending/original.png', 'pending-sha256'),
					('asset-multipart', 'UPLOADING', 'users/u/assets/multipart/original.mp4', 'multipart-sha256'),
					('asset-completed', 'READY', 'users/u/assets/completed/original.png', 'legacy-etag'),
					('asset-rejected', 'QUARANTINED', 'users/u/assets/rejected/original.png', 'rejected-sha256'),
					('asset-aborted', 'DELETED', 'users/u/assets/aborted/original.png', NULL),
					('asset-expired', 'UPLOADING', 'users/u/assets/expired/original.png', NULL)`,
			);
			const expiresAt = new Date("2026-08-13T01:00:00.000Z");
			const legacyCompletedExpiresAt = new Date(Date.now() + 30 * 60 * 1_000);
			await client.query(
				`INSERT INTO "media_upload_session" ("id", "assetId", "tokenHash", "status", "expectedBytes", "expiresAt") VALUES
					('session-pending', 'asset-pending', 'pending-token', 'PENDING', 16, $1),
					-- The backing multipart upload can already be complete even though its old pod never
					-- committed the session transition, so migration cleanup must abort and delete this key.
					('session-multipart', 'asset-multipart', 'multipart-token', 'PENDING', 16, $1),
					('session-completed', 'asset-completed', 'completed-token', 'COMPLETED', 16, $2),
					('session-rejected', 'asset-rejected', 'rejected-token', 'COMPLETED', 16, $2),
					('session-aborted', 'asset-aborted', 'aborted-token', 'ABORTED', 16, $1),
					('session-expired', 'asset-expired', 'expired-token', 'EXPIRED', 16, $1)`,
				[expiresAt, legacyCompletedExpiresAt],
			);
			await client.query(
				`UPDATE "media_upload_session" SET "multipartUploadId" = 'legacy-multipart' WHERE "id" = 'session-multipart'`,
			);
			await client.query(
				`INSERT INTO "storage_usage_reservation" ("id", "status", "referenceKey") VALUES
					('reservation-pending', 'ACTIVE', 'media-upload:session-pending'),
					('reservation-multipart', 'ACTIVE', 'media-upload:session-multipart'),
					('reservation-aborted', 'ACTIVE', 'media-upload:session-aborted'),
					('reservation-expired', 'ACTIVE', 'media-upload:session-expired')`,
			);
			await client.query(
				`INSERT INTO "asset_moderation_result" ("id", "assetId", "status") VALUES
					('moderation-rejected', 'asset-rejected', 'REJECTED')`,
			);

			await client.query(await migrationSql("20260823010000_immutable_upload_promotion"));
			await client.query(
				`INSERT INTO "media_asset" ("id", "status", "objectKey") VALUES
					('asset-finalizing', 'UPLOADING', 'users/u/assets/finalizing/original.png'),
					('asset-finalizing-stale', 'UPLOADING', 'users/u/assets/finalizing-stale/original.png')`,
			);
			await client.query(
				`INSERT INTO "media_upload_session" (
					"id", "assetId", "tokenHash", "status", "expectedBytes", "expiresAt",
					"stagingObjectKey", "finalizationToken"
				) VALUES (
					'session-finalizing', 'asset-finalizing', 'finalizing-token', 'FINALIZING', 16, $1,
					'users/u/staging/finalizing/nonce.png', 'old-finalization-token'
				), (
					'session-finalizing-stale', 'asset-finalizing-stale', 'finalizing-stale-token', 'FINALIZING', 16, $1,
					'users/u/staging/finalizing-stale/nonce.png', 'old-finalization-stale-token'
				)`,
				[expiresAt],
			);
			await client.query(
				`INSERT INTO "storage_usage_reservation" ("id", "status", "referenceKey") VALUES
					('reservation-finalizing', 'ACTIVE', 'media-upload:session-finalizing')`,
			);

			const rolloutStartedAt = Date.now();
			await client.query(await migrationSql("20260823014000_immutable_upload_promotion"));
			await client.query(await migrationSql("20260823014100_upload_finalization_leases"));

			await expect(
				client.query(`SELECT "status" FROM "media_upload_session" WHERE "id" = 'session-pending'`),
			).resolves.toMatchObject({ rows: [{ status: "EXPIRED" }] });
			await expect(
				client.query(`SELECT "status" FROM "media_asset" WHERE "id" = 'asset-pending'`),
			).resolves.toMatchObject({ rows: [{ status: "DELETED" }] });
			await expect(
				client.query(`SELECT "status" FROM "media_asset" WHERE "id" = 'asset-expired'`),
			).resolves.toMatchObject({ rows: [{ status: "DELETED" }] });
			await expect(
				client.query(
					`SELECT "status" FROM "storage_usage_reservation" WHERE "id" = 'reservation-pending'`,
				),
			).resolves.toMatchObject({ rows: [{ status: "ACTIVE" }] });
			await expect(
				client.query(
					`SELECT "status", "checksum" FROM "media_asset" WHERE "id" = 'asset-completed'`,
				),
			).resolves.toMatchObject({ rows: [{ status: "QUARANTINED", checksum: null }] });
			await expect(
				client.query(
					`SELECT "status", "checksum" FROM "media_asset" WHERE "id" = 'asset-rejected'`,
				),
			).resolves.toMatchObject({ rows: [{ status: "QUARANTINED", checksum: "rejected-sha256" }] });

			const cleanupEvents = await client.query<{
				dedupeKey: string;
				eventType: string;
				payload: Record<string, unknown>;
				availableAt: Date;
			}>(
				`SELECT "dedupeKey", "eventType", "payload", "availableAt" FROM "outbox_event"
				WHERE "dedupeKey" LIKE 'media-upload-legacy-%' ORDER BY "dedupeKey"`,
			);
			expect(cleanupEvents.rows).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						dedupeKey: "media-upload-legacy-delete-cleanup:session-pending",
						eventType: "MEDIA_UPLOAD_CLEANUP",
						payload: expect.objectContaining({
							uploadSessionId: "session-pending",
							reservationStatus: "EXPIRED",
						}),
					}),
					expect.objectContaining({
						dedupeKey: "media-upload-legacy-delete-cleanup:session-multipart",
						eventType: "MEDIA_UPLOAD_CLEANUP",
						payload: {
							assetId: "asset-multipart",
							objectKey: "users/u/assets/multipart/original.mp4",
						},
					}),
					expect.objectContaining({
						dedupeKey: "media-upload-legacy-abort-cleanup:session-multipart",
						eventType: "MEDIA_UPLOAD_CLEANUP",
						payload: expect.objectContaining({
							multipartUploadId: "legacy-multipart",
							uploadSessionId: "session-multipart",
							reservationStatus: "EXPIRED",
						}),
					}),
					expect.objectContaining({
						dedupeKey: "media-upload-legacy-delete-cleanup:session-aborted",
						eventType: "MEDIA_UPLOAD_CLEANUP",
						payload: expect.objectContaining({
							assetId: "asset-aborted",
							objectKey: "users/u/assets/aborted/original.png",
							uploadSessionId: "session-aborted",
							reservationStatus: "RELEASED",
						}),
					}),
					expect.objectContaining({
						dedupeKey: "media-upload-legacy-delete-cleanup:session-expired",
						eventType: "MEDIA_UPLOAD_CLEANUP",
						payload: expect.objectContaining({
							assetId: "asset-expired",
							objectKey: "users/u/assets/expired/original.png",
							uploadSessionId: "session-expired",
							reservationStatus: "EXPIRED",
						}),
					}),
					expect.objectContaining({
						dedupeKey: "media-upload-legacy-reverify:asset-completed",
						eventType: "MEDIA_ASSET_LEGACY_REVERIFY",
						payload: expect.objectContaining({
							assetId: "asset-completed",
							allowQuarantinedReverification: true,
						}),
					}),
				]),
			);
			for (const event of cleanupEvents.rows) {
				expect(event.availableAt.getTime()).toBeGreaterThanOrEqual(
					rolloutStartedAt + 9 * 60 * 1_000,
				);
			}
			const legacyReverify = cleanupEvents.rows.find(
				(event) => event.dedupeKey === "media-upload-legacy-reverify:asset-completed",
			);
			if (!legacyReverify) throw new Error("Expected delayed legacy re-verification event");
			expect(legacyReverify.availableAt.getTime()).toBeGreaterThanOrEqual(
				legacyCompletedExpiresAt.getTime() + 9 * 60 * 1_000,
			);
			expect(
				cleanupEvents.rows.some(
					(event) => event.dedupeKey === "media-upload-legacy-reverify:asset-rejected",
				),
			).toBe(false);

			await expect(
				client.query(`INSERT INTO "media_upload_session" (
					"id", "assetId", "tokenHash", "status", "expectedBytes", "expiresAt"
				) VALUES ('unsafe-old-writer', 'asset-pending', 'unsafe-token', 'PENDING', 16, CURRENT_TIMESTAMP)`),
			).rejects.toThrow(/MEDIA_UPLOAD_STAGING_KEY_REQUIRED/);
			await expect(
				client.query(
					`SELECT "finalizationLeaseExpiresAt", "legacyFinalizationToken" FROM "media_upload_session" WHERE "id" = 'session-finalizing'`,
				),
			).resolves.toMatchObject({
				rows: [
					{
						finalizationLeaseExpiresAt: expect.any(Date),
						legacyFinalizationToken: "old-finalization-token",
					},
				],
			});
			await client.query(
				`UPDATE "media_upload_session"
				SET "finalizationLeaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
				WHERE "id" = 'session-finalizing'`,
			);
			await client.query("BEGIN");
			try {
				await client.query(
					`UPDATE "media_upload_session" SET "status" = 'ABORTED' WHERE "id" = 'session-finalizing'`,
				);
				await client.query(
					`UPDATE "storage_usage_reservation" SET "status" = 'RELEASED'
					WHERE "referenceKey" = 'media-upload:session-finalizing' AND "status" = 'ACTIVE'`,
				);
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK");
				throw error;
			}
			await expect(
				client.query(
					`SELECT "status", "finalizationToken", "finalizationLeaseExpiresAt" FROM "media_upload_session" WHERE "id" = 'session-finalizing'`,
				),
			).resolves.toMatchObject({
				rows: [{ status: "ABORTED", finalizationToken: null, finalizationLeaseExpiresAt: null }],
			});
			await expect(
				client.query(
					`SELECT "status" FROM "storage_usage_reservation" WHERE "id" = 'reservation-finalizing'`,
				),
			).resolves.toMatchObject({ rows: [{ status: "RELEASED" }] });
			await client.query(
				`UPDATE "media_upload_session"
				SET "finalizationLeaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
				WHERE "id" = 'session-finalizing-stale'`,
			);
			await client.query(
				`UPDATE "media_upload_session"
				SET "finalizationToken" = 'new-finalization-token',
					"finalizationLeaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes'
				WHERE "id" = 'session-finalizing-stale'`,
			);
			await expect(
				client.query(
					`UPDATE "media_upload_session" SET "status" = 'ABORTED' WHERE "id" = 'session-finalizing-stale'`,
				),
			).rejects.toThrow(/MEDIA_UPLOAD_FINALIZATION_TOKEN_REQUIRED/);
			await expect(
				client.query(
					`UPDATE "media_upload_session"
					SET "status" = 'COMPLETED', "finalizationToken" = NULL
					WHERE "id" = 'session-finalizing-stale'`,
				),
			).rejects.toThrow(/MEDIA_UPLOAD_FINALIZATION_TOKEN_REQUIRED/);
		} finally {
			await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
			await client.end();
		}
	});
});
