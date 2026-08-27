import { createHash, randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import {
	getGuestJobSnapshot,
	getGuestOwnedResultAssetForAccess,
	getRegisteredGuestJobSnapshot,
	getRegisteredGuestResultAssetForAccess,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;

let client: PrismaClient;

describe("guest media read and grant boundary", () => {
	beforeAll(async () => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl() }),
		});
		await client.$connect();
	});

	beforeEach(async () => {
		await client.$executeRawUnsafe(
			'TRUNCATE TABLE "user", "guest_abuse_bucket", "guest_risk_budget_bucket", "outbox_event", "generation_quote" CASCADE',
		);
	});

	afterAll(async () => {
		await client?.$disconnect();
	});

	it("returns only the public guest snapshot to the exact anonymous owner", async () => {
		const fixture = await createReadyGuestResult("snapshot");
		const snapshot = await getGuestJobSnapshot(
			{ ownerId: fixture.guestId, jobId: fixture.jobId, now: fixture.now },
			client,
		);

		expect(snapshot).toMatchObject({
			jobId: fixture.jobId,
			stage: "READY",
			watermarked: true,
			trialConsumed: true,
			linkReady: false,
		});
		expect(Object.keys(snapshot ?? {})).toEqual([
			"jobId",
			"stage",
			"projectedDispatchAt",
			"estimateExpiresAt",
			"resultExpiresAt",
			"watermarked",
			"trialConsumed",
			"linkReady",
		]);
		await expect(
			getGuestJobSnapshot(
				{ ownerId: fixture.otherGuestId, jobId: fixture.jobId, now: fixture.now },
				client,
			),
		).resolves.toBeNull();
	});

	it("authorizes only the exact approved watermarked guest output", async () => {
		const fixture = await createReadyGuestResult("anonymous-access");
		const verification = currentVerification();

		await expect(
			getGuestOwnedResultAssetForAccess(
				{
					ownerId: fixture.guestId,
					jobId: fixture.jobId,
					assetId: fixture.outputAssetId,
					now: fixture.now,
					verification,
				},
				client,
			),
		).resolves.toMatchObject({ id: fixture.outputAssetId, deleteAfter: fixture.expiresAt });
		await expect(
			getGuestOwnedResultAssetForAccess(
				{
					ownerId: fixture.otherGuestId,
					jobId: fixture.jobId,
					assetId: fixture.outputAssetId,
					now: fixture.now,
					verification,
				},
				client,
			),
		).resolves.toBeNull();
		await expect(
			getGuestOwnedResultAssetForAccess(
				{
					ownerId: fixture.guestId,
					jobId: fixture.jobId,
					assetId: fixture.inputAssetId,
					now: fixture.now,
					verification,
				},
				client,
			),
		).resolves.toBeNull();
	});

	it("keeps a registered grant exact, expiry-bounded, and out of registered ownership", async () => {
		const fixture = await createReadyGuestResult("registered-grant");
		const verification = currentVerification();

		await expect(
			getRegisteredGuestJobSnapshot(
				{ registeredUserId: fixture.registeredUserId, jobId: fixture.jobId, now: fixture.now },
				client,
			),
		).resolves.toMatchObject({ jobId: fixture.jobId, stage: "READY" });
		await expect(
			getRegisteredGuestResultAssetForAccess(
				{
					registeredUserId: fixture.registeredUserId,
					jobId: fixture.jobId,
					assetId: fixture.outputAssetId,
					now: fixture.now,
					verification,
				},
				client,
			),
		).resolves.toMatchObject({ id: fixture.outputAssetId, resultExpiresAt: fixture.expiresAt });
		await expect(
			getRegisteredGuestResultAssetForAccess(
				{
					registeredUserId: fixture.registeredUserId,
					jobId: fixture.jobId,
					assetId: fixture.outputAssetId,
					now: fixture.expiresAt,
					verification,
				},
				client,
			),
		).resolves.toBeNull();
		await expect(
			Promise.all([
				client.generationJob.count({ where: { ownerId: fixture.registeredUserId } }),
				client.mediaAsset.count({ where: { ownerId: fixture.registeredUserId } }),
			]),
		).resolves.toEqual([0, 0]);
	});

	async function createReadyGuestResult(label: string) {
		const suffix = `${label}-${randomUUID()}`;
		const now = new Date();
		const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
		const guestId = `guest-${suffix}`;
		const otherGuestId = `other-${suffix}`;
		const registeredUserId = `registered-${suffix}`;
		const inputAssetId = `input-${suffix}`;
		const outputAssetId = `output-${suffix}`;
		const inputChecksum = hash(`input:${suffix}`);
		const outputChecksum = hash(`output:${suffix}`);
		const trialId = `trial-${suffix}`;
		const quoteId = `quote-${suffix}`;
		const jobId = `job-${suffix}`;
		const sourceSessionHash = hash(`session:${suffix}`);
		const deviceHash = hash(`device:${suffix}`);

		await client.user.createMany({
			data: [
				user(guestId, true, now),
				user(otherGuestId, true, now),
				user(registeredUserId, false, now),
			],
		});
		await createReadyAsset({
			id: inputAssetId,
			ownerId: guestId,
			kind: "INPUT",
			checksum: inputChecksum,
			expiresAt,
			watermarked: false,
		});
		await client.guestMediaTrial.create({
			data: {
				id: trialId,
				ownerId: guestId,
				promotionPeriod: `period-${suffix}`,
				eligibility: "CONSUMED",
				sponsorCredits: 4n,
				sourceAssetId: inputAssetId,
				sourceSessionHash,
				deviceHash,
				ipHash: hash(`ip:${suffix}`),
				subnetHash: hash(`subnet:${suffix}`),
				capabilityVersion: "guest-v7",
				idempotencyFingerprint: hash(`idempotency:${suffix}`),
				frozenQuotedRiskMicros: 3500n,
				riskState: "COMMITTED",
				providerBoundaryAt: now,
				projectedDispatchAt: now,
				estimateExpiresAt: new Date(now.getTime() + 60_000),
				consumedAt: now,
				expiresAt,
			},
		});
		await client.generationQuote.create({
			data: {
				id: quoteId,
				ownerType: "USER",
				ownerId: guestId,
				submittedByUserId: guestId,
				productKey: "image-fast",
				catalogVersion: "catalog-v1",
				pricingVersion: "pricing-v1",
				credits: 4n,
				costMicros: 3500n,
				inputSnapshot: { kind: "image-to-image", sourceAssetId: inputAssetId, prompt: "Violet" },
				pricingSnapshot: {},
				moderationDecision: "ALLOW",
				moderationProvider: "test",
				moderationRuleVersion: "text-safety-2026-08-14.1",
				moderationReasonCode: "ALLOW",
				inputFingerprint: hash(`quote:${suffix}`),
				expiresAt,
			},
		});
		await client.generationJob.create({
			data: {
				id: jobId,
				ownerType: "USER",
				ownerId: guestId,
				submittedByUserId: guestId,
				quoteId,
				idempotencyKey: `guest-result-${suffix}`,
				productKey: "image-fast",
				catalogVersion: "catalog-v1",
				pricingVersion: "pricing-v1",
				creditsReserved: 4n,
				inputSnapshot: { kind: "image-to-image", sourceAssetId: inputAssetId, prompt: "Violet" },
				pricingSnapshot: {},
				status: "SUCCEEDED",
				serviceClass: "GUEST_SLOW",
				dispatchEligibleAt: now,
				guestTrialId: trialId,
				terminalAt: now,
			},
		});
		await client.guestMediaTrial.update({
			where: { id: trialId },
			data: { consumedJobId: jobId, terminalAt: now, linkedAt: now },
		});
		await createReadyAsset({
			id: outputAssetId,
			ownerId: guestId,
			kind: "OUTPUT",
			checksum: outputChecksum,
			expiresAt,
			watermarked: true,
		});
		await client.generationJobAsset.createMany({
			data: [
				{ jobId, assetId: inputAssetId, assetChecksum: inputChecksum, role: "INPUT", position: 0 },
				{
					jobId,
					assetId: outputAssetId,
					assetChecksum: outputChecksum,
					role: "OUTPUT",
					position: 0,
				},
			],
		});
		await client.guestLinkIntent.create({
			data: {
				trialId,
				anonymousOwnerId: guestId,
				promotionPeriod: `period-${suffix}`,
				sourceSessionHash,
				deviceHash,
				returnPath: "/try",
				state: "LINKED",
				tokenHash: hash(`link:${suffix}`),
				idempotencyKey: `link-${suffix}`,
				registeredUserId,
				createdAt: now,
				expiresAt,
				linkedAt: now,
			},
		});
		await client.guestResultAccessGrant.create({
			data: {
				trialId,
				guestJobId: jobId,
				registeredUserId,
				grantTokenHash: hash(`grant:${suffix}`),
				createdAt: now,
				expiresAt,
			},
		});
		return {
			now,
			expiresAt,
			guestId,
			otherGuestId,
			registeredUserId,
			inputAssetId,
			outputAssetId,
			jobId,
		};
	}

	async function createReadyAsset(input: {
		id: string;
		ownerId: string;
		kind: "INPUT" | "OUTPUT";
		checksum: string;
		expiresAt: Date;
		watermarked: boolean;
	}) {
		await client.mediaAsset.create({
			data: {
				id: input.id,
				ownerType: "USER",
				ownerId: input.ownerId,
				kind: input.kind,
				status: "VERIFYING",
				retentionClass: "GUEST_TRIAL",
				deleteAfter: input.expiresAt,
				objectKey: `users/${input.ownerId}/assets/${input.id}/watermarked.png`,
				mimeType: "image/png",
				byteSize: 1024n,
				checksum: input.checksum,
				finalizedAt: new Date(),
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: "test",
				verificationProviderTaskId: `moderation-${input.id}`,
				verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				verificationValidUntil: input.expiresAt,
				...(input.watermarked
					? {
							watermarkVersion: "ezpic-watermark-v1",
							watermarkedAt: new Date(),
							cleanStagingDeletedAt: new Date(),
						}
					: {}),
			},
		});
		await client.assetModerationResult.create({
			data: {
				assetId: input.id,
				assetChecksum: input.checksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: input.kind,
				provider: "test",
				providerTaskId: `moderation-${input.id}`,
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				status: "APPROVED",
				reasonCode: "ALLOW",
				categories: {},
				rawEnvelope: {},
				validUntil: input.expiresAt,
			},
		});
		await client.mediaAsset.update({
			where: { id: input.id },
			data: { status: "READY" },
		});
	}
});

function user(id: string, isAnonymous: boolean, now: Date) {
	return {
		id,
		name: isAnonymous ? "Guest" : "Registered",
		email: `${id}@example.test`,
		emailVerified: !isAnonymous,
		isAnonymous,
		createdAt: now,
		updatedAt: now,
	};
}

function currentVerification() {
	return {
		provider: "test",
		ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
		policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
	};
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function safeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	if (DATABASE_URL && TEST_DATABASE_URL === DATABASE_URL) {
		throw new Error("UNSAFE_TEST_DATABASE: TEST_DATABASE_URL must not equal DATABASE_URL");
	}
	const parsed = new URL(TEST_DATABASE_URL);
	const databaseName = parsed.pathname.slice(1).toLowerCase();
	if (
		!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(databaseName)
	) {
		throw new Error("UNSAFE_TEST_DATABASE: expected a disposable loopback test database");
	}
	return TEST_DATABASE_URL;
}
