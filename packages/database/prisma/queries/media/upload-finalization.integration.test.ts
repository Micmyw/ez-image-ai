import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import {
	claimMediaUploadSessionFinalizationTransaction,
	completeMediaUploadSessionTransaction,
	createMediaUploadSessionTransaction,
	expirePendingMediaUploadSessions,
	MediaUploadSessionExpiredError,
	recordMediaUploadPromotionMultipartTransaction,
} from "./assets";

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

async function createUploadFixture(client: PrismaClient, overrides: { expiresAt?: Date } = {}) {
	const suffix = randomUUID();
	const ownerId = `upload-finalization-${suffix}`;
	const assetId = `asset_${suffix}`;
	const sessionId = `session_${suffix}`;
	const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 60_000);
	return {
		ownerId,
		...(await createMediaUploadSessionTransaction(
			{
				assetId,
				sessionId,
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				objectKey: `users/${ownerId}/assets/${assetId}/original.png`,
				stagingObjectKey: `users/${ownerId}/staging/${sessionId}/nonce.png`,
				mimeType: "image/png",
				expectedBytes: 16n,
				tokenHash: `token-${suffix}`,
				expiresAt,
				multipartUploadId: null,
				limits: { maximumActiveSessions: 5, maximumReservedBytes: 1_000_000n },
			},
			client,
		)),
	};
}

async function waitForAdvisoryLock(
	client: PrismaClient,
	classId: number,
	objectId: number,
): Promise<boolean> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const rows = await client.$queryRaw<Array<{ locked: boolean }>>`
			SELECT EXISTS (
				SELECT 1 FROM pg_locks
				WHERE locktype = 'advisory'
					AND classid = ${classId}::oid
					AND objid = ${objectId}::oid
					AND granted
			) AS locked`;
		if (rows[0]?.locked) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return false;
}

describe("media upload finalization PostgreSQL transactions", () => {
	let client: PrismaClient;

	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl() }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("gives one concurrent claimant the lease and keeps the other claimant out of promotion", async () => {
		const fixture = await createUploadFixture(client);
		const suffix = randomUUID().replaceAll("-", "");
		const functionName = `test_hold_upload_finalization_${suffix}`;
		const triggerName = `test_hold_upload_finalization_claim_${suffix}`;
		const lockClassId = 214_732;
		const lockObjectId = Math.floor(Math.random() * 1_000_000) + 1;
		await client.$executeRawUnsafe(`
			CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger AS $$
			BEGIN
				IF NEW."id" = '${fixture.session.id}'
					AND OLD."status" = 'PENDING'
					AND NEW."status" = 'FINALIZING' THEN
					PERFORM pg_advisory_xact_lock(${lockClassId}, ${lockObjectId});
					PERFORM pg_sleep(0.5);
				END IF;
				RETURN NEW;
			END;
			$$ LANGUAGE plpgsql;
			CREATE TRIGGER ${triggerName}
			BEFORE UPDATE ON "media_upload_session"
			FOR EACH ROW EXECUTE FUNCTION ${functionName}();
		`);
		try {
			const firstClaim = claimMediaUploadSessionFinalizationTransaction(
				{ sessionId: fixture.session.id, ownerId: fixture.ownerId },
				client,
			);
			expect(await waitForAdvisoryLock(client, lockClassId, lockObjectId)).toBe(true);
			const secondClaim = claimMediaUploadSessionFinalizationTransaction(
				{ sessionId: fixture.session.id, ownerId: fixture.ownerId },
				client,
			);
			const [first, second] = await Promise.all([firstClaim, secondClaim]);
			const claims = [first, second];
			const winner = claims.find((claim) => claim.outcome === "CLAIMED");
			expect(winner).toMatchObject({ outcome: "CLAIMED", finalizationToken: expect.any(String) });
			expect(claims.filter((claim) => claim.outcome === "IN_PROGRESS")).toHaveLength(1);
			const session = await client.mediaUploadSession.findUniqueOrThrow({
				where: { id: fixture.session.id },
			});
			expect(session).toMatchObject({
				status: "FINALIZING",
				finalizationToken: winner?.outcome === "CLAIMED" ? winner.finalizationToken : undefined,
				finalizationLeaseExpiresAt: expect.any(Date),
			});
		} finally {
			await client.$executeRawUnsafe(`
				DROP TRIGGER IF EXISTS ${triggerName} ON "media_upload_session";
				DROP FUNCTION IF EXISTS ${functionName}();
			`);
		}
	});

	it("requeues an expired finalization lease before the upload session expires", async () => {
		const fixture = await createUploadFixture(client, { expiresAt: new Date(Date.now() + 60_000) });
		const expiredLease = new Date(Date.now() - 1_000);
		await client.mediaUploadSession.update({
			where: { id: fixture.session.id },
			data: {
				status: "FINALIZING",
				finalizationToken: `expired-${randomUUID()}`,
				finalizationLeaseExpiresAt: expiredLease,
				finalizationParts: [{ partNumber: 1, etag: "persisted" }],
			},
		});

		await expect(
			expirePendingMediaUploadSessions({ now: new Date(), limit: 10 }, client),
		).resolves.toBeGreaterThanOrEqual(1);
		await expect(
			client.mediaUploadSession.findUniqueOrThrow({ where: { id: fixture.session.id } }),
		).resolves.toMatchObject({
			status: "PENDING",
			finalizationToken: null,
			finalizationLeaseExpiresAt: null,
			finalizationParts: [{ partNumber: 1, etag: "persisted" }],
		});
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: fixture.asset.id, eventType: "MEDIA_UPLOAD_CLEANUP" },
			}),
		).toBe(0);
		await expect(
			claimMediaUploadSessionFinalizationTransaction(
				{ sessionId: fixture.session.id, ownerId: fixture.ownerId },
				client,
			),
		).resolves.toMatchObject({ outcome: "CLAIMED", finalizationToken: expect.any(String) });
	});

	it("expires an abandoned finalization lease and queues cleanup for staged and final keys", async () => {
		const fixture = await createUploadFixture(client, { expiresAt: new Date(Date.now() - 60_000) });
		await client.mediaUploadSession.update({
			where: { id: fixture.session.id },
			data: {
				status: "FINALIZING",
				finalizationToken: `expired-${randomUUID()}`,
				finalizationLeaseExpiresAt: new Date(Date.now() - 1_000),
				finalizationParts: [{ partNumber: 1, etag: "persisted" }],
			},
		});
		const sweptAt = new Date();

		await expect(
			expirePendingMediaUploadSessions({ now: sweptAt, limit: 10 }, client),
		).resolves.toBeGreaterThanOrEqual(1);
		await expect(
			client.mediaUploadSession.findUniqueOrThrow({ where: { id: fixture.session.id } }),
		).resolves.toMatchObject({
			status: "EXPIRED",
			finalizationToken: null,
			finalizationLeaseExpiresAt: null,
			finalizationParts: [{ partNumber: 1, etag: "persisted" }],
		});
		await expect(
			client.outboxEvent.findUniqueOrThrow({
				where: { dedupeKey: `media-upload-staging-expire-cleanup:${fixture.session.id}` },
			}),
		).resolves.toMatchObject({
			availableAt: new Date(sweptAt.getTime() + 10 * 60 * 1_000),
			payload: {
				assetId: fixture.asset.id,
				objectKey: fixture.session.stagingObjectKey,
				cleanupObjectKeys: [fixture.asset.objectKey],
				uploadSessionId: fixture.session.id,
				reservationStatus: "EXPIRED",
			},
		});
	});

	it("commits expired-finalization cleanup before rejecting a stale client retry", async () => {
		const fixture = await createUploadFixture(client, { expiresAt: new Date(Date.now() - 60_000) });
		await client.mediaUploadSession.update({
			where: { id: fixture.session.id },
			data: {
				status: "FINALIZING",
				finalizationToken: `expired-${randomUUID()}`,
				finalizationLeaseExpiresAt: new Date(Date.now() - 1_000),
			},
		});
		const retriedAt = new Date();

		await expect(
			claimMediaUploadSessionFinalizationTransaction(
				{ sessionId: fixture.session.id, ownerId: fixture.ownerId, now: retriedAt },
				client,
			),
		).rejects.toBeInstanceOf(MediaUploadSessionExpiredError);
		await expect(
			client.mediaUploadSession.findUniqueOrThrow({ where: { id: fixture.session.id } }),
		).resolves.toMatchObject({ status: "EXPIRED", finalizationToken: null });
		await expect(
			client.outboxEvent.findUniqueOrThrow({
				where: { dedupeKey: `media-upload-staging-expire-cleanup:${fixture.session.id}` },
			}),
		).resolves.toMatchObject({
			payload: expect.objectContaining({
				objectKey: fixture.session.stagingObjectKey,
				cleanupObjectKeys: [fixture.asset.objectKey],
				uploadSessionId: fixture.session.id,
				reservationStatus: "EXPIRED",
			}),
		});
	});

	it("completes an active lease after the original upload URL expires and queues delayed staging cleanup", async () => {
		const fixture = await createUploadFixture(client);
		const claim = await claimMediaUploadSessionFinalizationTransaction(
			{ sessionId: fixture.session.id, ownerId: fixture.ownerId },
			client,
		);
		if (claim.outcome !== "CLAIMED")
			throw new Error("Expected the fixture claimant to acquire a lease");
		const completedAt = new Date();
		const expiredUploadUrlAt = new Date(completedAt.getTime() - 1_000);
		await client.mediaUploadSession.update({
			where: { id: fixture.session.id },
			data: { expiresAt: expiredUploadUrlAt },
		});

		await expect(
			completeMediaUploadSessionTransaction(
				{
					sessionId: fixture.session.id,
					ownerId: fixture.ownerId,
					checksum: "a".repeat(64),
					finalizationToken: claim.finalizationToken,
					now: completedAt,
				},
				client,
			),
		).resolves.toMatchObject({ id: fixture.asset.id, status: "VERIFYING" });
		await expect(
			client.outboxEvent.findUniqueOrThrow({
				where: { dedupeKey: `media-upload-staging-expire-cleanup:${fixture.session.id}` },
			}),
		).resolves.toMatchObject({
			availableAt: new Date(completedAt.getTime() + 10 * 60 * 1_000),
			payload: expect.objectContaining({ objectKey: fixture.session.stagingObjectKey }),
		});
	});

	it("persists a final promotion multipart under its lease and clears it only at matching completion", async () => {
		const fixture = await createUploadFixture(client);
		const claim = await claimMediaUploadSessionFinalizationTransaction(
			{ sessionId: fixture.session.id, ownerId: fixture.ownerId },
			client,
		);
		if (claim.outcome !== "CLAIMED")
			throw new Error("Expected the fixture claimant to acquire a lease");
		const promotion = {
			multipartUploadId: `promotion-${randomUUID()}`,
			promotionToken: `promotion-token-${randomUUID()}`,
		};

		await expect(
			recordMediaUploadPromotionMultipartTransaction(
				{
					sessionId: fixture.session.id,
					ownerId: fixture.ownerId,
					finalizationToken: claim.finalizationToken,
					...promotion,
				},
				client,
			),
		).resolves.toMatchObject(promotion);

		await expect(
			completeMediaUploadSessionTransaction(
				{
					sessionId: fixture.session.id,
					ownerId: fixture.ownerId,
					checksum: "a".repeat(64),
					finalizationToken: claim.finalizationToken,
				},
				client,
			),
		).rejects.toThrow(/promotion multipart/i);

		await expect(
			completeMediaUploadSessionTransaction(
				{
					sessionId: fixture.session.id,
					ownerId: fixture.ownerId,
					checksum: "a".repeat(64),
					finalizationToken: claim.finalizationToken,
					promotion,
				},
				client,
			),
		).resolves.toMatchObject({ id: fixture.asset.id, status: "VERIFYING" });
		await expect(
			client.mediaUploadSession.findUniqueOrThrow({ where: { id: fixture.session.id } }),
		).resolves.toMatchObject({
			status: "COMPLETED",
			promotionMultipartUploadId: null,
			promotionToken: null,
		});
	});

	it("queues an exact final promotion abort before reclaiming an expired finalization lease", async () => {
		const fixture = await createUploadFixture(client, { expiresAt: new Date(Date.now() + 60_000) });
		const claimedAt = new Date();
		const claim = await claimMediaUploadSessionFinalizationTransaction(
			{
				sessionId: fixture.session.id,
				ownerId: fixture.ownerId,
				now: claimedAt,
				leaseDurationMs: 1_000,
			},
			client,
		);
		if (claim.outcome !== "CLAIMED")
			throw new Error("Expected the fixture claimant to acquire a lease");
		const promotion = {
			multipartUploadId: `promotion-${randomUUID()}`,
			promotionToken: `promotion-token-${randomUUID()}`,
		};
		await recordMediaUploadPromotionMultipartTransaction(
			{
				sessionId: fixture.session.id,
				ownerId: fixture.ownerId,
				finalizationToken: claim.finalizationToken,
				...promotion,
				now: new Date(claimedAt.getTime() + 100),
			},
			client,
		);

		const reclaimed = await claimMediaUploadSessionFinalizationTransaction(
			{
				sessionId: fixture.session.id,
				ownerId: fixture.ownerId,
				now: new Date(claimedAt.getTime() + 2_000),
			},
			client,
		);
		expect(reclaimed).toMatchObject({ outcome: "CLAIMED", promotionMultipartUploadId: null });
		await expect(
			client.outboxEvent.findUniqueOrThrow({
				where: {
					dedupeKey: `media-upload-promotion-abort:${fixture.session.id}:${promotion.promotionToken}`,
				},
			}),
		).resolves.toMatchObject({
			payload: {
				assetId: fixture.asset.id,
				objectKey: fixture.asset.objectKey,
				multipartUploadId: promotion.multipartUploadId,
				promotionAbortOnly: true,
			},
		});
	});

	it("sweeps a pre-fence FINALIZING staged row that has no terminalization token", async () => {
		const sweepAt = new Date();
		const fixture = await createUploadFixture(client, {
			expiresAt: new Date(sweepAt.getTime() - 60_000),
		});
		await client.$executeRaw`
			UPDATE "media_upload_session"
			SET
				"status" = 'FINALIZING',
				"finalizationToken" = ${`legacy-finalization-${randomUUID()}`},
				"finalizationLeaseExpiresAt" = ${new Date(sweepAt.getTime() - 1_000)},
				"stagedTerminalizationToken" = NULL
			WHERE "id" = ${fixture.session.id}`;

		await expect(
			expirePendingMediaUploadSessions({ now: sweepAt, limit: 10 }, client),
		).resolves.toBeGreaterThanOrEqual(1);
		await expect(
			client.mediaUploadSession.findUniqueOrThrow({ where: { id: fixture.session.id } }),
		).resolves.toMatchObject({
			status: "EXPIRED",
			stagedTerminalizationToken: null,
		});
		await expect(
			client.outboxEvent.findUniqueOrThrow({
				where: { dedupeKey: `media-upload-staging-expire-cleanup:${fixture.session.id}` },
			}),
		).resolves.toMatchObject({
			payload: expect.objectContaining({
				assetId: fixture.asset.id,
				uploadSessionId: fixture.session.id,
				reservationStatus: "EXPIRED",
			}),
		});
	});

	it.each(["COMPLETED", "ABORTED", "EXPIRED"] as const)(
		"rejects a legacy staged PENDING writer that tries to transition directly to %s",
		async (status) => {
			const fixture = await createUploadFixture(client);

			await expect(
				client.mediaUploadSession.update({
					where: { id: fixture.session.id },
					data: { status },
				}),
			).rejects.toThrow(/MEDIA_UPLOAD_STAGED_TERMINALIZATION_TOKEN_REQUIRED/);
		},
	);
});
