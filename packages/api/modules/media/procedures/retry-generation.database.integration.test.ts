import { createHash, randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import { createCreditGrant } from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk", () => ({
	tasks: { trigger: vi.fn(async () => ({ id: "retry-generation-integration-task" })) },
}));

import { retryGenerationForUser } from "./retry-generation";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;

let client: PrismaClient;

describe("retry generation database boundary", () => {
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
		vi.stubEnv("MEDIA_GENERATION_ENABLED", "true");
		vi.stubEnv("MEDIA_SAFETY_ADAPTER", "test");
		vi.stubEnv("MEDIA_ALLOW_TEST_SAFETY_ADAPTER", "true");
	});

	afterAll(async () => {
		vi.unstubAllEnvs();
		await client?.$disconnect();
	});

	it("does not clone a failed guest trial into the registered retry queue", async () => {
		const fixture = await seedFailedGuestJob();
		const before = await retrySideEffectCounts(fixture.ownerId);

		await expect(
			retryGenerationForUser(fixture.ownerId, {
				jobId: fixture.jobId,
				idempotencyKey: `retry-guest-${fixture.suffix}`,
			}),
		).rejects.toThrow("NOT_FOUND");

		await expect(retrySideEffectCounts(fixture.ownerId)).resolves.toEqual(before);
	});
});

async function seedFailedGuestJob() {
	const suffix = randomUUID();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
	const ownerId = `guest-retry-${suffix}`;
	const assetId = `asset_${hash(`asset-id:${suffix}`).slice(0, 32)}`;
	const checksum = hash(`asset:${suffix}`);

	await client.user.create({
		data: {
			id: ownerId,
			name: "Guest",
			email: `${ownerId}@anonymous.invalid`,
			emailVerified: false,
			isAnonymous: true,
			createdAt: now,
			updatedAt: now,
		},
	});
	const account = await client.creditAccount.create({
		data: { ownerType: "USER", ownerId },
	});
	await createCreditGrant(
		{ accountId: account.id, amount: 100n, referenceKey: `guest-retry-grant:${suffix}` },
		client,
	);
	await client.mediaAsset.create({
		data: {
			id: assetId,
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			retentionClass: "GUEST_TRIAL",
			deleteAfter: expiresAt,
			objectKey: `users/${ownerId}/guest/${assetId}.png`,
			mimeType: "image/png",
			byteSize: 1_024n,
			checksum,
			finalizedAt: now,
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "test",
			verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			verificationValidUntil: expiresAt,
		},
	});
	await client.assetModerationResult.create({
		data: {
			assetId,
			assetChecksum: checksum,
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: "INPUT",
			provider: "test",
			ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			status: "APPROVED",
			reasonCode: "ALLOW",
			categories: {},
			rawEnvelope: {},
			validUntil: expiresAt,
		},
	});
	await client.mediaAsset.update({ where: { id: assetId }, data: { status: "READY" } });
	const trial = await client.guestMediaTrial.create({
		data: {
			ownerId,
			promotionPeriod: `retry-${suffix}`,
			eligibility: "CONSUMED",
			sponsorCredits: 4n,
			sourceAssetId: assetId,
			sourceSessionHash: hash(`session:${suffix}`),
			deviceHash: hash(`device:${suffix}`),
			ipHash: hash(`ip:${suffix}`),
			subnetHash: hash(`subnet:${suffix}`),
			capabilityVersion: "guest-retry-regression-v1",
			idempotencyFingerprint: hash(`idempotency:${suffix}`),
			frozenQuotedRiskMicros: 3_500n,
			riskState: "COMMITTED",
			providerBoundaryAt: now,
			projectedDispatchAt: now,
			estimateExpiresAt: new Date(now.getTime() + 60_000),
			consumedAt: now,
			expiresAt,
		},
	});
	const inputSnapshot = {
		kind: "image-to-image",
		prompt: "A guest source that must not enter registered retry",
		sourceAssetId: assetId,
	};
	const quote = await client.generationQuote.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-fast",
			catalogVersion: DEFAULT_PRODUCT_CONFIG.catalogVersion,
			pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
			credits: 4n,
			costMicros: 3_500n,
			inputSnapshot,
			pricingSnapshot: {},
			moderationDecision: "ALLOW",
			moderationProvider: "test",
			moderationRuleVersion: "text-safety-2026-08-14.1",
			moderationReasonCode: "ALLOW",
			inputFingerprint: hash(`quote:${suffix}`),
			expiresAt,
		},
	});
	const job = await client.generationJob.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: `guest-source-${suffix}`,
			productKey: "image-fast",
			catalogVersion: DEFAULT_PRODUCT_CONFIG.catalogVersion,
			pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
			creditsReserved: 4n,
			inputSnapshot,
			pricingSnapshot: {},
			status: "FAILED",
			serviceClass: "GUEST_SLOW",
			dispatchEligibleAt: now,
			guestTrialId: trial.id,
			failureCode: "PROVIDER_REJECTED",
			terminalAt: now,
		},
	});
	await client.generationJobAsset.create({
		data: { jobId: job.id, assetId, assetChecksum: checksum, role: "INPUT", position: 0 },
	});
	await client.guestMediaTrial.update({
		where: { id: trial.id },
		data: { consumedJobId: job.id, terminalAt: now },
	});
	return { suffix, ownerId, jobId: job.id };
}

async function retrySideEffectCounts(ownerId: string) {
	return Promise.all([
		client.generationJob.count({ where: { ownerId } }),
		client.creditReservation.count({ where: { account: { ownerId } } }),
		client.outboxEvent.count({
			where: { aggregateType: "GENERATION_JOB", aggregateId: { in: await jobIds(ownerId) } },
		}),
		client.generationRetryRequest.count({ where: { ownerId } }),
	]);
}

async function jobIds(ownerId: string): Promise<string[]> {
	return (await client.generationJob.findMany({ where: { ownerId }, select: { id: true } })).map(
		(job) => job.id,
	);
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
