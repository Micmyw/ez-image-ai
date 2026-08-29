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

	it("scrubs due trial-held abuse evidence while retaining the immutable trial row", async () => {
		const now = new Date("2026-08-28T12:00:00.000Z");
		const ownerId = await createAnonymousOwner("trial-evidence");
		const evidenceExpiresAt = new Date(now.getTime() - 1);
		const trialId = await createTrialEvidenceRow({
			ownerId,
			promotionPeriod: "launch-evidence-red",
			evidenceExpiresAt,
			expiresAt: evidenceExpiresAt,
		});

		await expireGuestMediaTransaction({ now, limit: 25 }, client);

		const retained = await trialEvidenceSnapshot(trialId);
		expect([
			retained.sourceSessionHash,
			retained.deviceHash,
			retained.ipHash,
			retained.subnetHash,
			retained.idempotencyFingerprint,
		]).toEqual([null, null, null, null, null]);
		expect(asDate(retained.abuseEvidenceExpiresAt)).toEqual(evidenceExpiresAt);
		expect(asDate(retained.abuseEvidenceDeletedAt)).toEqual(now);
		expect(retained).toMatchObject({
			id: trialId,
			ownerId: null,
			promotionPeriod: "launch-evidence-red",
		});
		await expect(client.guestMediaTrial.count({ where: { id: trialId } })).resolves.toBe(1);
	});

	it("scrubs due evidence in a deterministic bounded batch and preserves the first scrub time", async () => {
		const now = new Date("2026-08-28T12:00:00.000Z");
		const owners = await Promise.all([
			createAnonymousOwner("evidence-order-a"),
			createAnonymousOwner("evidence-order-b"),
			createAnonymousOwner("evidence-order-c"),
		]);
		const trials = await Promise.all([
			createTrialEvidenceRow({
				id: `evidence-order-a-${randomUUID()}`,
				ownerId: owners[0]!,
				promotionPeriod: "evidence-order-a",
				evidenceExpiresAt: new Date(now.getTime() - 3_000),
				expiresAt: new Date(now.getTime() + 60_000),
			}),
			createTrialEvidenceRow({
				id: `evidence-order-b-${randomUUID()}`,
				ownerId: owners[1]!,
				promotionPeriod: "evidence-order-b",
				evidenceExpiresAt: new Date(now.getTime() - 2_000),
				expiresAt: new Date(now.getTime() + 60_000),
			}),
			createTrialEvidenceRow({
				id: `evidence-order-c-${randomUUID()}`,
				ownerId: owners[2]!,
				promotionPeriod: "evidence-order-c",
				evidenceExpiresAt: new Date(now.getTime() - 1_000),
				expiresAt: new Date(now.getTime() + 60_000),
			}),
		]);

		await expireGuestMediaTransaction({ now, limit: 2 }, client);
		const afterFirst = await Promise.all(trials.map(trialEvidenceSnapshot));
		expect(afterFirst.map((trial) => asDate(trial.abuseEvidenceDeletedAt))).toEqual([
			now,
			now,
			null,
		]);
		expect(afterFirst[2]).toMatchObject({
			sourceSessionHash: expect.any(String),
			idempotencyFingerprint: expect.any(String),
		});

		const secondSweepAt = new Date(now.getTime() + 1_000);
		await expireGuestMediaTransaction({ now: secondSweepAt, limit: 2 }, client);
		await expireGuestMediaTransaction(
			{ now: new Date(secondSweepAt.getTime() + 1_000), limit: 2 },
			client,
		);
		const converged = await Promise.all(trials.map(trialEvidenceSnapshot));
		expect(converged.map((trial) => asDate(trial.abuseEvidenceDeletedAt))).toEqual([
			now,
			now,
			secondSweepAt,
		]);
		expect(
			converged.map((trial) => [
				trial.sourceSessionHash,
				trial.deviceHash,
				trial.ipHash,
				trial.subnetHash,
				trial.idempotencyFingerprint,
			]),
		).toEqual(Array.from({ length: 3 }, () => [null, null, null, null, null]));
	});

	it("lets concurrent sweepers claim disjoint bounded evidence batches", async () => {
		const now = new Date("2026-08-28T12:00:00.000Z");
		const trialIds = await Promise.all(
			Array.from({ length: 4 }, async (_, index) => {
				const ownerId = await createAnonymousOwner(`evidence-concurrent-${index}`);
				return createTrialEvidenceRow({
					ownerId,
					promotionPeriod: `evidence-concurrent-${index}`,
					evidenceExpiresAt: new Date(now.getTime() - 4_000 + index),
					expiresAt: new Date(now.getTime() + 60_000),
				});
			}),
		);

		await Promise.all([
			expireGuestMediaTransaction({ now, limit: 2 }, client),
			expireGuestMediaTransaction({ now, limit: 2 }, client),
		]);

		const retained = await Promise.all(trialIds.map(trialEvidenceSnapshot));
		expect(retained.map((trial) => asDate(trial.abuseEvidenceDeletedAt))).toEqual([
			now,
			now,
			now,
			now,
		]);
		expect(
			retained.every(
				(trial) => trial.sourceSessionHash === null && trial.idempotencyFingerprint === null,
			),
		).toBe(true);
	});

	it("scrubs a consumed terminal trial without deleting its financial or audit graph", async () => {
		const now = new Date("2026-08-28T12:00:00.000Z");
		const graph = await createConsumedTerminalTrialGraph(now);
		const before = await consumedGraphSnapshot(graph);

		await expireGuestMediaTransaction({ now, limit: 25 }, client);

		const trial = await trialEvidenceSnapshot(graph.trialId);
		expect([
			trial.sourceSessionHash,
			trial.deviceHash,
			trial.ipHash,
			trial.subnetHash,
			trial.idempotencyFingerprint,
		]).toEqual([null, null, null, null, null]);
		expect(asDate(trial.abuseEvidenceDeletedAt)).toEqual(now);
		expect(trial.ownerId).toBeNull();
		expect(trial).toMatchObject({
			promotionPeriod: "consumed-terminal-period",
			eligibility: "CONSUMED",
			riskState: "COMMITTED",
			frozenQuotedRiskMicros: 3500,
			currentJobId: null,
			consumedJobId: graph.jobId,
			cleanupOutboxEventId: graph.outboxId,
		});
		await expect(consumedGraphSnapshot(graph)).resolves.toEqual(before);
		await expect(client.user.count({ where: { id: graph.ownerId } })).resolves.toBe(0);
	});

	it("removes expired link access while preserving linked trial facts and the registered user", async () => {
		const now = new Date("2026-08-28T12:00:00.000Z");
		const linked = await createExpiredLinkedTrialGraph(now);

		await expireGuestMediaTransaction({ now, limit: 25 }, client);

		const trial = await trialEvidenceSnapshot(linked.trialId);
		expect(asDate(trial.linkedAt)).toEqual(linked.linkedAt);
		expect(asDate(trial.abuseEvidenceDeletedAt)).toEqual(now);
		expect(trial.ownerId).toBeNull();
		await expect(
			Promise.all([
				client.guestLinkIntent.count({ where: { id: linked.intentId } }),
				client.guestResultAccessGrant.count({ where: { id: linked.grantId } }),
				client.user.count({ where: { id: linked.anonymousOwnerId } }),
				client.user.count({ where: { id: linked.registeredUserId } }),
				client.generationJob.count({ where: { id: linked.jobId } }),
			]),
		).resolves.toEqual([0, 0, 0, 1, 1]);
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
		const anonymousTrialId = await createTrialEvidenceRow({
			ownerId: anonymousOwnerId,
			promotionPeriod: "not-due-anonymous",
			evidenceExpiresAt: new Date(now.getTime() + 60_000),
			expiresAt: new Date(now.getTime() + 120_000),
		});
		const registeredTrialId = await createTrialEvidenceRow({
			ownerId: registered.id,
			promotionPeriod: "not-due-registered",
			evidenceExpiresAt: new Date(now.getTime() + 60_000),
			expiresAt: new Date(now.getTime() + 120_000),
		});

		await expireGuestMediaTransaction({ now, limit: 25 }, client);

		await expect(
			client.user.count({ where: { id: { in: [anonymousOwnerId, registered.id] } } }),
		).resolves.toBe(2);
		for (const trialId of [anonymousTrialId, registeredTrialId]) {
			const trial = await trialEvidenceSnapshot(trialId);
			expect(trial.abuseEvidenceDeletedAt ?? null).toBeNull();
			expect(trial.sourceSessionHash).toEqual(expect.any(String));
			expect(trial.idempotencyFingerprint).toEqual(expect.any(String));
		}
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

interface ConsumedTerminalGraph {
	ownerId: string;
	trialId: string;
	quoteId: string;
	jobId: string;
	attemptId: string;
	accountId: string;
	lotId: string;
	reservationId: string;
	allocationId: string;
	ledgerIds: string[];
	outboxId: string;
	sourceAssetId: string;
	resultAssetId: string;
}

async function createConsumedTerminalTrialGraph(now: Date): Promise<ConsumedTerminalGraph> {
	const ownerId = await createAnonymousOwner("consumed-terminal");
	const deletedAt = new Date(now.getTime() - 30_000);
	const source = await client.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "DELETED",
			retentionClass: "GUEST_TRIAL",
			deleteAfter: new Date(now.getTime() - 60_000),
			deletedAt,
			objectKey: `users/${ownerId}/consumed/source.png`,
			mimeType: "image/png",
			byteSize: 128n,
			checksum: "1".repeat(64),
		},
	});
	const result = await client.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind: "OUTPUT",
			status: "DELETED",
			retentionClass: "GUEST_TRIAL",
			deleteAfter: new Date(now.getTime() - 60_000),
			deletedAt,
			watermarkVersion: "guest-watermark-v1",
			watermarkedAt: new Date(now.getTime() - 120_000),
			objectKey: `users/${ownerId}/consumed/result.png`,
			mimeType: "image/png",
			byteSize: 256n,
			checksum: "2".repeat(64),
		},
	});
	const trialId = await createTrialEvidenceRow({
		ownerId,
		promotionPeriod: "consumed-terminal-period",
		evidenceExpiresAt: new Date(now.getTime() - 1),
		expiresAt: new Date(now.getTime() - 1),
		eligibility: "CONSUMED",
		riskState: "COMMITTED",
		providerBoundaryAt: new Date(now.getTime() - 120_000),
		terminalAt: new Date(now.getTime() - 90_000),
		consumedAt: new Date(now.getTime() - 90_000),
		sourceAssetId: source.id,
	});
	const quote = await client.generationQuote.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-fast",
			catalogVersion: "catalog-retained-v1",
			pricingVersion: "pricing-retained-v1",
			credits: 4n,
			costMicros: 3500n,
			inputSnapshot: { kind: "image-to-image", sourceAssetId: source.id },
			pricingSnapshot: { settlementPolicy: { maxCharge: "4" } },
			moderationDecision: "ALLOW",
			moderationProvider: "test",
			moderationRuleVersion: "text-safety-v1",
			moderationReasonCode: "ALLOW",
			inputFingerprint: createHashValue(`${trialId}:quote`),
			expiresAt: new Date(now.getTime() - 1),
		},
	});
	const job = await client.generationJob.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: `consumed-${randomUUID()}`,
			productKey: "image-fast",
			catalogVersion: quote.catalogVersion,
			pricingVersion: quote.pricingVersion,
			creditsReserved: 4n,
			inputSnapshot: { kind: "image-to-image", sourceAssetId: source.id },
			pricingSnapshot: { settlementPolicy: { maxCharge: "4" } },
			status: "SUCCEEDED",
			serviceClass: "GUEST_SLOW",
			dispatchEligibleAt: new Date(now.getTime() - 180_000),
			guestTrialId: trialId,
			terminalAt: new Date(now.getTime() - 90_000),
		},
	});
	await client.generationJobAsset.createMany({
		data: [
			{
				jobId: job.id,
				assetId: source.id,
				assetChecksum: source.checksum!,
				role: "INPUT",
			},
			{
				jobId: job.id,
				assetId: result.id,
				assetChecksum: result.checksum!,
				role: "OUTPUT",
			},
		],
	});
	const attempt = await client.generationAttempt.create({
		data: {
			jobId: job.id,
			attemptNumber: 1,
			provider: "test",
			providerModelId: "test-retained-model",
			providerTaskId: `retained-${randomUUID()}`,
			status: "SUCCEEDED",
			providerCostMicros: 3500n,
			requestSnapshot: { prompt: "retained" },
			responseSnapshot: { outputAssetId: result.id },
			submittedAt: new Date(now.getTime() - 120_000),
			completedAt: new Date(now.getTime() - 90_000),
		},
	});
	const account = await client.creditAccount.create({
		data: { ownerType: "USER", ownerId },
	});
	const lot = await client.creditLot.create({
		data: {
			accountId: account.id,
			grantReferenceKey: `guest-trial:${trialId}:grant`,
			grantedAmount: 4n,
			remainingAmount: 0n,
			expiresAt: new Date(now.getTime() - 1),
		},
	});
	const reservation = await client.creditReservation.create({
		data: {
			accountId: account.id,
			jobId: job.id,
			amount: 4n,
			settledAmount: 4n,
			status: "SETTLED",
		},
	});
	const allocation = await client.creditReservationAllocation.create({
		data: {
			reservationId: reservation.id,
			lotId: lot.id,
			amount: 4n,
			settledAmount: 4n,
		},
	});
	const ledgerEntries = await Promise.all(
		(["GRANT", "RESERVE", "SETTLE"] as const).map((type) =>
			client.creditLedgerEntry.create({
				data: {
					accountId: account.id,
					lotId: lot.id,
					reservationId: type === "GRANT" ? null : reservation.id,
					type,
					amount: 4n,
					referenceKey: `${trialId}:${type.toLowerCase()}`,
					metadata: { guestTrialId: trialId, command: type },
				},
			}),
		),
	);
	const outbox = await client.outboxEvent.create({
		data: {
			eventType: "MEDIA_OBJECT_DELETE",
			aggregateType: "MEDIA_ASSET",
			aggregateId: result.id,
			dedupeKey: `guest-trial:${trialId}:retained-cleanup`,
			payload: { assetId: result.id, objectKey: result.objectKey },
			status: "PROCESSED",
			processedAt: deletedAt,
		},
	});
	await client.guestMediaTrial.update({
		where: { id: trialId },
		data: { consumedJobId: job.id, cleanupOutboxEventId: outbox.id },
	});
	return {
		ownerId,
		trialId,
		quoteId: quote.id,
		jobId: job.id,
		attemptId: attempt.id,
		accountId: account.id,
		lotId: lot.id,
		reservationId: reservation.id,
		allocationId: allocation.id,
		ledgerIds: ledgerEntries.map((entry) => entry.id),
		outboxId: outbox.id,
		sourceAssetId: source.id,
		resultAssetId: result.id,
	};
}

async function consumedGraphSnapshot(graph: ConsumedTerminalGraph) {
	const [quote, job, attempt, account, lot, reservation, allocation, ledgers, outbox, assets] =
		await Promise.all([
			client.generationQuote.findUniqueOrThrow({ where: { id: graph.quoteId } }),
			client.generationJob.findUniqueOrThrow({ where: { id: graph.jobId } }),
			client.generationAttempt.findUniqueOrThrow({ where: { id: graph.attemptId } }),
			client.creditAccount.findUniqueOrThrow({ where: { id: graph.accountId } }),
			client.creditLot.findUniqueOrThrow({ where: { id: graph.lotId } }),
			client.creditReservation.findUniqueOrThrow({ where: { id: graph.reservationId } }),
			client.creditReservationAllocation.findUniqueOrThrow({
				where: { id: graph.allocationId },
			}),
			client.creditLedgerEntry.findMany({
				where: { id: { in: graph.ledgerIds } },
				orderBy: { referenceKey: "asc" },
			}),
			client.outboxEvent.findUniqueOrThrow({ where: { id: graph.outboxId } }),
			client.mediaAsset.findMany({
				where: { id: { in: [graph.sourceAssetId, graph.resultAssetId] } },
				orderBy: { kind: "asc" },
			}),
		]);
	return { quote, job, attempt, account, lot, reservation, allocation, ledgers, outbox, assets };
}

interface ExpiredLinkedTrialGraph {
	anonymousOwnerId: string;
	registeredUserId: string;
	trialId: string;
	jobId: string;
	intentId: string;
	grantId: string;
	linkedAt: Date;
}

async function createExpiredLinkedTrialGraph(now: Date): Promise<ExpiredLinkedTrialGraph> {
	const anonymousOwnerId = await createAnonymousOwner("linked-expired");
	const registered = await client.user.create({
		data: {
			name: "Linked Registered",
			email: `${randomUUID()}@example.test`,
			emailVerified: true,
			isAnonymous: false,
			createdAt: new Date(now.getTime() - 120_000),
			updatedAt: new Date(now.getTime() - 120_000),
		},
	});
	const linkedAt = new Date(now.getTime() - 60_000);
	const trialId = await createTrialEvidenceRow({
		ownerId: anonymousOwnerId,
		promotionPeriod: "linked-expired-period",
		evidenceExpiresAt: new Date(now.getTime() - 1),
		expiresAt: new Date(now.getTime() - 1),
		eligibility: "CONSUMED",
		riskState: "RELEASED",
		linkedAt,
		terminalAt: linkedAt,
		consumedAt: linkedAt,
	});
	const quote = await client.generationQuote.create({
		data: {
			ownerType: "USER",
			ownerId: anonymousOwnerId,
			submittedByUserId: anonymousOwnerId,
			productKey: "image-fast",
			catalogVersion: "catalog-linked-v1",
			pricingVersion: "pricing-linked-v1",
			credits: 4n,
			costMicros: 3500n,
			inputSnapshot: { kind: "image-to-image" },
			pricingSnapshot: { settlementPolicy: { maxCharge: "4" } },
			expiresAt: new Date(now.getTime() - 1),
		},
	});
	const job = await client.generationJob.create({
		data: {
			ownerType: "USER",
			ownerId: anonymousOwnerId,
			submittedByUserId: anonymousOwnerId,
			quoteId: quote.id,
			idempotencyKey: `linked-${randomUUID()}`,
			productKey: quote.productKey,
			catalogVersion: quote.catalogVersion,
			pricingVersion: quote.pricingVersion,
			creditsReserved: 4n,
			inputSnapshot: { kind: "image-to-image" },
			pricingSnapshot: { settlementPolicy: { maxCharge: "4" } },
			status: "SUCCEEDED",
			serviceClass: "GUEST_SLOW",
			guestTrialId: trialId,
			terminalAt: linkedAt,
		},
	});
	await client.guestMediaTrial.update({
		where: { id: trialId },
		data: { consumedJobId: job.id },
	});
	const intent = await client.guestLinkIntent.create({
		data: {
			trialId,
			anonymousOwnerId,
			promotionPeriod: "linked-expired-period",
			sourceSessionHash: createHashValue(`${trialId}:linked-session`),
			deviceHash: createHashValue(`${trialId}:linked-device`),
			returnPath: "/create",
			state: "LINKED",
			tokenHash: createHashValue(`${trialId}:link-token`),
			idempotencyKey: `linked-intent-${randomUUID()}`,
			registeredUserId: registered.id,
			createdAt: new Date(now.getTime() - 120_000),
			expiresAt: new Date(now.getTime() - 1),
			linkedAt,
		},
	});
	const grant = await client.guestResultAccessGrant.create({
		data: {
			trialId,
			guestJobId: job.id,
			registeredUserId: registered.id,
			grantTokenHash: createHashValue(`${trialId}:grant-token`),
			createdAt: new Date(now.getTime() - 120_000),
			expiresAt: new Date(now.getTime() - 1),
		},
	});
	return {
		anonymousOwnerId,
		registeredUserId: registered.id,
		trialId,
		jobId: job.id,
		intentId: intent.id,
		grantId: grant.id,
		linkedAt,
	};
}

interface TrialEvidenceSnapshot {
	id: string;
	ownerId: string | null;
	promotionPeriod: string;
	eligibility?: string;
	riskState?: string;
	frozenQuotedRiskMicros?: number;
	currentJobId?: string | null;
	consumedJobId?: string | null;
	cleanupOutboxEventId?: string | null;
	sourceSessionHash: string | null;
	deviceHash: string | null;
	ipHash: string | null;
	subnetHash: string | null;
	idempotencyFingerprint: string | null;
	abuseEvidenceExpiresAt?: string;
	abuseEvidenceDeletedAt?: string | null;
	linkedAt?: string | null;
}

async function createTrialEvidenceRow(input: {
	id?: string;
	ownerId: string;
	promotionPeriod: string;
	evidenceExpiresAt: Date;
	expiresAt: Date;
	eligibility?: "AVAILABLE" | "IN_FLIGHT" | "CONSUMED" | "EXPIRED";
	riskState?: "HELD" | "COMMITTED" | "RELEASED";
	linkedAt?: Date;
	providerBoundaryAt?: Date;
	terminalAt?: Date;
	consumedAt?: Date;
	sourceAssetId?: string;
}): Promise<string> {
	const id = input.id ?? randomUUID();
	const createdAt = new Date(input.expiresAt.getTime() - 24 * 60 * 60_000);
	const projectedDispatchAt = new Date(createdAt.getTime() + 60_000);
	const estimateExpiresAt = new Date(createdAt.getTime() + 120_000);
	const row = {
		id,
		ownerId: input.ownerId,
		promotionPeriod: input.promotionPeriod,
		eligibility: input.eligibility ?? "AVAILABLE",
		sponsorCredits: "4",
		sourceAssetId: input.sourceAssetId,
		sourceSessionHash: createHashValue(`${id}:session`),
		deviceHash: createHashValue(`${id}:device`),
		ipHash: createHashValue(`${id}:ip`),
		subnetHash: createHashValue(`${id}:subnet`),
		capabilityVersion: "guest-evidence-v1",
		idempotencyFingerprint: createHashValue(`${id}:idempotency`),
		replacementCount: 0,
		frozenQuotedRiskMicros: "3500",
		riskState: input.riskState ?? "RELEASED",
		projectedDispatchAt: projectedDispatchAt.toISOString(),
		estimateExpiresAt: estimateExpiresAt.toISOString(),
		createdAt: createdAt.toISOString(),
		updatedAt: createdAt.toISOString(),
		linkedAt: input.linkedAt?.toISOString(),
		providerBoundaryAt: input.providerBoundaryAt?.toISOString(),
		terminalAt: input.terminalAt?.toISOString(),
		consumedAt: input.consumedAt?.toISOString(),
		expiresAt: input.expiresAt.toISOString(),
		abuseEvidenceExpiresAt: input.evidenceExpiresAt.toISOString(),
		abuseEvidenceDeletedAt: null,
	};
	await client.$executeRaw`
		INSERT INTO "guest_media_trial"
		SELECT *
		FROM jsonb_populate_record(NULL::"guest_media_trial", ${JSON.stringify(row)}::jsonb)
	`;
	return id;
}

async function trialEvidenceSnapshot(trialId: string): Promise<TrialEvidenceSnapshot> {
	const rows = await client.$queryRaw<Array<{ trial: TrialEvidenceSnapshot }>>`
		SELECT to_jsonb(trial) AS "trial"
		FROM "guest_media_trial" trial
		WHERE trial."id" = ${trialId}
	`;
	if (!rows[0]) throw new Error(`Missing guest trial ${trialId}`);
	return rows[0].trial;
}

function asDate(value: string | null | undefined): Date | null {
	return value ? new Date(value) : null;
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
