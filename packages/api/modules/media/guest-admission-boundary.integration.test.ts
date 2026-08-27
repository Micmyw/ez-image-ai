import { createHash, randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { PrismaPg } from "@prisma/adapter-pg";
import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import { createGuestGenerationTransaction } from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));

import { auth } from "@repo/auth";

import { guestAdmissionDependencies } from "./lib/guest-admission";
import { verifyGuestTurnstileEvidence } from "./lib/turnstile";
import { submitGuestGeneration } from "./procedures/submit-guest-generation";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;

let client: PrismaClient;
const originalDependencies = { ...guestAdmissionDependencies };

describe("guest admission real boundary", () => {
	beforeAll(async () => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl() }),
		});
		await client.$connect();
		await client.$executeRawUnsafe(
			'TRUNCATE TABLE "user", "guest_abuse_bucket", "guest_risk_budget_bucket", "outbox_event", "generation_quote" CASCADE',
		);
	});

	afterAll(async () => {
		Object.assign(guestAdmissionDependencies, originalDependencies);
		await client?.$disconnect();
	});

	it("canonicalizes a 32-way Turnstile replay through oRPC and the anonymous auth boundary", async () => {
		const fixture = await createGuestFixture("full-boundary-replay");
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: fixture.ownerId, isAnonymous: true },
			session: { id: fixture.sessionId, userId: fixture.ownerId },
		} as never);
		configureAdmissionDependencies(fixture);

		const headers = new Headers({
			origin: "https://app.ezpic.test",
			"x-vercel-forwarded-for": "203.0.113.42",
		});
		const input = {
			capabilityVersion: "guest-v7",
			sourceAssetId: fixture.assetId,
			prompt: "Make the sky violet",
			idempotencyKey: "guest-full-boundary-replay-0001",
			deviceId: "d4fbf8d2-945a-4f2c-8359-f179f6c734de",
			turnstileToken: "one-time-turnstile-token",
		};
		const results = await concurrentBarrier(32, () =>
			call(submitGuestGeneration, input, { context: { headers } }),
		);

		expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
		const jobId = results[0]!.jobId;
		const account = await client.creditAccount.findUniqueOrThrow({
			where: { ownerType_ownerId: { ownerType: "USER", ownerId: fixture.ownerId } },
		});
		await expect(
			Promise.all([
				client.guestAbuseBucket.count({
					where: {
						scope: "guest-turnstile-token",
						subjectHash: sha256(input.turnstileToken),
					},
				}),
				client.guestMediaTrial.count({ where: { ownerId: fixture.ownerId } }),
				client.generationQuote.count({ where: { ownerId: fixture.ownerId } }),
				client.generationJob.count({ where: { ownerId: fixture.ownerId } }),
				client.creditLedgerEntry.count({
					where: { accountId: account.id, type: "GRANT" },
				}),
				client.creditReservation.count({ where: { jobId } }),
				client.creditReservationAllocation.count({ where: { reservation: { jobId } } }),
				client.generationJobAsset.count({ where: { jobId, role: "INPUT" } }),
				client.outboxEvent.count({
					where: { aggregateId: jobId, eventType: "GUEST_GENERATION_ELIGIBLE" },
				}),
			]),
		).resolves.toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);

		await expect(
			call(
				submitGuestGeneration,
				{ ...input, idempotencyKey: "guest-different-semantics-0001", prompt: "Make it green" },
				{ context: { headers } },
			),
		).rejects.toThrow("TURNSTILE_REPLAYED");

		const otherFixture = await createGuestFixture("other-owner-replay");
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: otherFixture.ownerId, isAnonymous: true },
			session: { id: otherFixture.sessionId, userId: otherFixture.ownerId },
		} as never);
		configureAdmissionDependencies(otherFixture);
		await expect(
			call(
				submitGuestGeneration,
				{
					...input,
					sourceAssetId: otherFixture.assetId,
					idempotencyKey: "guest-other-owner-replay-0001",
				},
				{ context: { headers } },
			),
		).rejects.toThrow("TURNSTILE_REPLAYED");
		await expect(
			Promise.all([
				client.guestMediaTrial.count({ where: { ownerId: otherFixture.ownerId } }),
				client.generationJob.count({ where: { ownerId: otherFixture.ownerId } }),
			]),
		).resolves.toEqual([0, 0]);
	});
});

function configureAdmissionDependencies(fixture: GuestFixture): void {
	const resolveQuote = () => ({
		productKey: "image-fast",
		catalogVersion: "catalog-v1",
		pricingVersion: "pricing-v1",
		credits: 4n,
		costMicros: 3500n,
		pricingSnapshot: { settlementPolicy: { maxCharge: "4" } },
	});
	Object.assign(guestAdmissionDependencies, {
		now: () => fixture.now,
		saasOrigin: "https://app.ezpic.test",
		abuseSecret: "independent-guest-abuse-secret",
		loadCapability: async () => ({
			snapshot: { version: "guest-v7" },
			config: {
				enabled: true,
				promotionPeriod: fixture.promotionPeriod,
				productKey: "image-fast",
				sponsorCredits: 4n,
				maximumBytes: 10 * 1024 * 1024,
				mimeTypes: ["image/jpeg", "image/png", "image/webp"],
				retentionMs: 24 * 60 * 60_000,
				queueTtlMs: 15 * 60_000,
				limits: {
					maximumActiveJobsPerGuest: 1,
					maximumRequestsPerMinute: 100,
					maximumRequestsPerIpPerHour: 100,
					maximumGlobalQueueDepth: 100,
				},
				riskBudgetMicros: 350_000n,
				turnstile: { required: false, secretKey: null },
			},
		}),
		resolveIdentity: () => ({ ip: "203.0.113.42", subnet: "203.0.113.0/24" }),
		verifyTurnstile: async ({ token, hostname, clientIp, now }: TurnstileBoundaryInput) =>
			verifyGuestTurnstileEvidence(
				{ token, action: "guest_generate", hostname, clientIp, now },
				{
					verify: async () => ({
						success: true,
						hostname,
						action: "guest_generate",
						challengeTimestamp: now.toISOString(),
					}),
				},
			),
		loadSourceAsset: (assetId: string, ownerId: string) =>
			client.mediaAsset.findFirst({
				where: { id: assetId, ownerType: "USER", ownerId },
				select: {
					id: true,
					ownerType: true,
					ownerId: true,
					kind: true,
					status: true,
					retentionClass: true,
					deleteAfter: true,
					mimeType: true,
					byteSize: true,
					checksum: true,
					verificationValidUntil: true,
				},
			}),
		loadSourceBootstrap: ({ ownerId, promotionPeriod, sourceAssetId, now }: BootstrapInput) =>
			client.guestSessionBootstrap.findFirst({
				where: {
					ownerId,
					promotionPeriod,
					sourceAssetId,
					completedAt: { not: null },
					expiresAt: { gt: now },
				},
				select: { id: true, claimedDraftId: true, sourceAssetId: true },
			}),
		buildQuote: resolveQuote,
		moderatePrompt: async () => ({
			decision: "ALLOW",
			provider: "test",
			ruleVersion: "text-safety-2026-08-14.1",
			reasonCode: "ALLOW",
		}),
		moderationProvider: "test",
		createTransaction: (input: Parameters<typeof createGuestGenerationTransaction>[0]) =>
			createGuestGenerationTransaction(input, client, resolveQuote),
	});
}

async function createGuestFixture(label: string): Promise<GuestFixture> {
	const suffix = `${label}-${randomUUID()}`;
	const now = new Date("2026-08-28T00:00:00.000Z");
	const ownerId = `guest-${suffix}`;
	const sessionId = `session-${suffix}`;
	const assetId = `asset-${suffix}`;
	const draftId = `draft-${suffix}`;
	const checksum = sha256(`asset:${suffix}`);
	const promotionPeriod = "launch-2026-08";
	const validUntil = new Date(now.getTime() + 24 * 60 * 60_000);
	await client.user.create({
		data: {
			id: ownerId,
			name: "Guest",
			email: `${suffix}@anonymous.invalid`,
			emailVerified: false,
			isAnonymous: true,
			createdAt: now,
			updatedAt: now,
		},
	});
	await client.session.create({
		data: {
			id: sessionId,
			token: `token-${suffix}`,
			userId: ownerId,
			expiresAt: validUntil,
			createdAt: now,
			updatedAt: now,
		},
	});
	await client.mediaAsset.create({
		data: {
			id: assetId,
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			retentionClass: "GUEST_TRIAL",
			deleteAfter: validUntil,
			objectKey: `users/${ownerId}/assets/${assetId}/original.png`,
			mimeType: "image/png",
			byteSize: 1024n,
			checksum,
			finalizedAt: now,
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "test",
			verificationProviderTaskId: `moderation-${suffix}`,
			verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			verificationValidUntil: validUntil,
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
			providerTaskId: `moderation-${suffix}`,
			ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			status: "APPROVED",
			reasonCode: "ALLOW",
			categories: {},
			rawEnvelope: {},
			validUntil,
		},
	});
	await client.mediaAsset.update({ where: { id: assetId }, data: { status: "READY" } });
	await client.generationDraft.create({
		data: {
			id: draftId,
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			claimTokenHash: sha256(`claim:${suffix}`),
			assetId,
			productKey: "image-fast",
			inputSnapshot: { kind: "image-to-image", prompt: "Make the sky violet" },
			status: "SUBMITTED",
			expiresAt: validUntil,
		},
	});
	await client.guestSessionBootstrap.create({
		data: {
			ownerId,
			promotionPeriod,
			claimHash: sha256(`bootstrap-claim:${suffix}`),
			idempotencyKey: `bootstrap-idempotency-${suffix}`,
			claimedDraftId: draftId,
			sourceAssetId: assetId,
			createdAt: now,
			expiresAt: validUntil,
			completedAt: now,
		},
	});
	return { assetId, now, ownerId, promotionPeriod, sessionId };
}

interface GuestFixture {
	assetId: string;
	now: Date;
	ownerId: string;
	promotionPeriod: string;
	sessionId: string;
}

interface TurnstileBoundaryInput {
	token: string;
	hostname: string;
	clientIp: string;
	now: Date;
}

interface BootstrapInput {
	ownerId: string;
	promotionPeriod: string;
	sourceAssetId: string;
	now: Date;
}

async function concurrentBarrier<T>(count: number, operation: () => Promise<T>): Promise<T[]> {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const contenders = Array.from({ length: count }, async () => {
		await gate;
		return operation();
	});
	release();
	return Promise.all(contenders);
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
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
