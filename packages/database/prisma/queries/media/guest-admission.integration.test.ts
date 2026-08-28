import { createHash, randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { createGuestGenerationTransaction } from "./guest-admission";
import { expireGuestJobBeforeProvider } from "./guest-retention";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;

let client: PrismaClient;

describe("guest generation admission", () => {
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

	it("commits exactly one sponsored graph under a deterministic 32-way replay", async () => {
		const fixture = await createGuestFixture("replay");
		const input = guestAdmissionInput(fixture, { idempotencyKey: "guest-replay-0001" });
		const results = await concurrentBarrier(32, () => createGuestAdmission(input));

		expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
		const jobId = results[0]!.jobId;
		const trial = await client.guestMediaTrial.findUniqueOrThrow({
			where: {
				ownerId_promotionPeriod: {
					ownerId: fixture.ownerId,
					promotionPeriod: fixture.promotionPeriod,
				},
			},
		});
		const account = await client.creditAccount.findUniqueOrThrow({
			where: { ownerType_ownerId: { ownerType: "USER", ownerId: fixture.ownerId } },
		});
		await expect(
			Promise.all([
				client.guestMediaTrial.count({ where: { ownerId: fixture.ownerId } }),
				client.generationQuote.count({ where: { ownerId: fixture.ownerId } }),
				client.generationJob.count({ where: { ownerId: fixture.ownerId } }),
				client.creditLedgerEntry.count({
					where: { accountId: account.id, type: "GRANT" },
				}),
				client.creditReservation.count({ where: { jobId } }),
				client.creditReservationAllocation.count({
					where: { reservation: { jobId } },
				}),
				client.generationJobAsset.count({ where: { jobId, role: "INPUT" } }),
				client.outboxEvent.count({
					where: { aggregateId: jobId, eventType: "GUEST_GENERATION_ELIGIBLE" },
				}),
			]),
		).resolves.toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
		expect(trial).toMatchObject({
			currentJobId: jobId,
			eligibility: "IN_FLIGHT",
			riskState: "HELD",
			sponsorCredits: 4n,
		});
		expect(account).toMatchObject({ spendableCredits: 0n, reservedCredits: 4n });
		await expect(
			client.outboxEvent.findFirstOrThrow({
				where: { aggregateId: jobId, eventType: "GUEST_GENERATION_ELIGIBLE" },
			}),
		).resolves.toMatchObject({ availableAt: trial.projectedDispatchAt });
	});

	it("creates no business graph when the queue dimension is N plus one", async () => {
		const admitted = await createGuestFixture("capacity-a");
		await createGuestAdmission(
			guestAdmissionInput(admitted, {
				idempotencyKey: "guest-capacity-a",
				maximumGlobalQueueDepth: 1,
			}),
		);
		const rejected = await createGuestFixture("capacity-b");

		await expect(
			createGuestAdmission(
				guestAdmissionInput(rejected, {
					idempotencyKey: "guest-capacity-b",
					maximumGlobalQueueDepth: 1,
				}),
			),
		).rejects.toThrow("GUEST_CAPACITY_UNAVAILABLE");
		await expect(
			Promise.all([
				client.guestMediaTrial.count({ where: { ownerId: rejected.ownerId } }),
				client.generationQuote.count({ where: { ownerId: rejected.ownerId } }),
				client.generationJob.count({ where: { ownerId: rejected.ownerId } }),
				client.creditAccount.count({ where: { ownerId: rejected.ownerId } }),
			]),
		).resolves.toEqual([0, 0, 0, 0]);
	});

	it("projects admission in capacity waves instead of multiplying every queued job", async () => {
		for (const label of ["wave-a", "wave-b", "wave-c"]) {
			const queued = await createGuestFixture(label);
			await createGuestAdmission(
				guestAdmissionInput(queued, {
					idempotencyKey: `guest-${label}`,
					queueCapacity: 2,
				}),
			);
		}
		const fixture = await createGuestFixture("wave-target");
		const result = await createGuestAdmission(
			guestAdmissionInput(fixture, {
				idempotencyKey: "guest-wave-target",
				queueCapacity: 2,
			}),
		);

		expect(result.projectedDispatchAt).toEqual(new Date(fixture.now.getTime() + 2 * 60_000));
		expect(result.estimateExpiresAt).toEqual(new Date(fixture.now.getTime() + 3 * 60_000));
	});

	it("reprojects a pre-provider replacement from remaining queue capacity", async () => {
		const queued = await createGuestFixture("replacement-blocker");
		await createGuestAdmission(
			guestAdmissionInput(queued, { idempotencyKey: "guest-replacement-blocker" }),
		);
		const fixture = await createGuestFixture("replacement-target");
		const original = await createGuestAdmission(
			guestAdmissionInput(fixture, { idempotencyKey: "guest-replacement-target" }),
		);
		const replacementNow = new Date(fixture.now.getTime() + 10_000);

		const expired = await client.$transaction((tx) =>
			expireGuestJobBeforeProvider({ jobId: original.jobId, now: replacementNow }, tx),
		);
		if (expired.outcome !== "EXPIRED" || !expired.replacementJobId) {
			throw new Error("Expected one bounded guest replacement");
		}
		const [trial, replacement, event] = await Promise.all([
			client.guestMediaTrial.findUniqueOrThrow({ where: { id: original.trialId } }),
			client.generationJob.findUniqueOrThrow({ where: { id: expired.replacementJobId } }),
			client.outboxEvent.findFirstOrThrow({
				where: {
					aggregateId: expired.replacementJobId,
					eventType: "GUEST_GENERATION_ELIGIBLE",
				},
			}),
		]);
		const projectedDispatchAt = new Date(replacementNow.getTime() + 60_000);
		expect(trial).toMatchObject({
			projectedDispatchAt,
			estimateExpiresAt: new Date(replacementNow.getTime() + 2 * 60_000),
		});
		expect(replacement.dispatchEligibleAt).toEqual(projectedDispatchAt);
		expect(event.availableAt).toEqual(projectedDispatchAt);
	});

	it("terminalizes a pre-provider job when replacement projection exceeds immutable expiry", async () => {
		const queued = await createGuestFixture("replacement-expiry-blocker");
		await createGuestAdmission(
			guestAdmissionInput(queued, { idempotencyKey: "guest-replacement-expiry-blocker" }),
		);
		const fixture = await createGuestFixture("replacement-expiry-target");
		const original = await createGuestAdmission(
			guestAdmissionInput(fixture, { idempotencyKey: "guest-replacement-expiry-target" }),
		);
		const replacementNow = new Date(fixture.now.getTime() + 10_000);
		const nearExpiry = new Date(replacementNow.getTime() + 30_000);
		await client.guestMediaTrial.update({
			where: { id: original.trialId },
			data: {
				projectedDispatchAt: replacementNow,
				estimateExpiresAt: nearExpiry,
				expiresAt: nearExpiry,
			},
		});

		await expect(
			client.$transaction((tx) =>
				expireGuestJobBeforeProvider(
					{ jobId: original.jobId, now: replacementNow, serviceTimeMs: 60_000 },
					tx,
				),
			),
		).resolves.toEqual({ outcome: "EXPIRED", jobId: original.jobId });
		const [trial, job, reservation, riskBudget, jobCount, attemptCount] = await Promise.all([
			client.guestMediaTrial.findUniqueOrThrow({ where: { id: original.trialId } }),
			client.generationJob.findUniqueOrThrow({ where: { id: original.jobId } }),
			client.creditReservation.findUniqueOrThrow({ where: { jobId: original.jobId } }),
			client.guestRiskBudgetBucket.findUniqueOrThrow({
				where: {
					promotionPeriod_subjectHash: {
						promotionPeriod: fixture.promotionPeriod,
						subjectHash: "global",
					},
				},
			}),
			client.generationJob.count({ where: { ownerId: fixture.ownerId } }),
			client.generationAttempt.count({ where: { job: { ownerId: fixture.ownerId } } }),
		]);
		expect(trial).toMatchObject({
			currentJobId: null,
			eligibility: "AVAILABLE",
			replacementCount: 0,
			riskState: "RELEASED",
			projectedDispatchAt: replacementNow,
			estimateExpiresAt: nearExpiry,
			expiresAt: nearExpiry,
			terminalAt: replacementNow,
		});
		expect(job).toMatchObject({
			status: "FAILED",
			failureCode: "GUEST_QUEUE_EXPIRED",
			terminalAt: replacementNow,
		});
		expect(reservation).toMatchObject({ status: "RELEASED", releasedAmount: 4n });
		expect(riskBudget).toMatchObject({ reservedMicros: 3_500n });
		expect(jobCount).toBe(1);
		expect(attemptCount).toBe(0);
	});

	it.each([
		["catalog version", { catalogVersion: "catalog-v2" }],
		["pricing version", { pricingVersion: "pricing-v2" }],
		["sponsor credits", { credits: 5n }],
		["maximum route cost", { costMicros: 4500n }],
		["route graph", { pricingSnapshot: { routeGraph: { graphFingerprint: "changed-at-commit" } } }],
	] as const)(
		"rolls back the entire graph when canonical %s changes after preflight",
		async (_label, canonicalOverride) => {
			const slug = _label.replaceAll(" ", "-");
			const fixture = await createGuestFixture(`stale-${slug}`);
			const input = guestAdmissionInput(fixture, { idempotencyKey: `guest-stale-${slug}` });
			const resolveCanonicalQuote = () => ({ ...input.quote, ...canonicalOverride });

			await expect(
				createGuestGenerationTransaction(input, client, resolveCanonicalQuote),
			).rejects.toThrow("GUEST_PRICE_CHANGED");
			await expect(
				Promise.all([
					client.guestAbuseBucket.count({ where: { scope: "guest-turnstile-token" } }),
					client.guestMediaTrial.count({ where: { ownerId: fixture.ownerId } }),
					client.generationQuote.count({ where: { ownerId: fixture.ownerId } }),
					client.generationJob.count({ where: { ownerId: fixture.ownerId } }),
					client.creditAccount.count({ where: { ownerId: fixture.ownerId } }),
				]),
			).resolves.toEqual([0, 0, 0, 0, 0]);
		},
	);

	it("extends aggregate risk expiry through the latest staggered hold", async () => {
		const firstFixture = await createGuestFixture(
			"risk-expiry-first",
			new Date("2026-08-28T00:00:00.000Z"),
		);
		const first = await createGuestAdmission(
			guestAdmissionInput(firstFixture, { idempotencyKey: "guest-risk-expiry-first" }),
		);
		const laterFixture = await createGuestFixture(
			"risk-expiry-later",
			new Date("2026-08-28T01:00:00.000Z"),
		);
		const later = await createGuestAdmission(
			guestAdmissionInput(laterFixture, { idempotencyKey: "guest-risk-expiry-later" }),
		);
		const bucket = await client.guestRiskBudgetBucket.findUniqueOrThrow({
			where: {
				promotionPeriod_subjectHash: {
					promotionPeriod: firstFixture.promotionPeriod,
					subjectHash: "global",
				},
			},
		});

		expect(later.resultExpiresAt.getTime()).toBeGreaterThan(first.resultExpiresAt.getTime());
		expect(bucket.expiresAt).toEqual(later.resultExpiresAt);
	});

	it("rejects a link-fenced draft without creating sponsor or job rows", async () => {
		const fixture = await createGuestFixture("link-fenced");
		await client.guestLinkIntent.create({
			data: {
				claimedDraftId: fixture.draftId,
				anonymousOwnerId: fixture.ownerId,
				promotionPeriod: fixture.promotionPeriod,
				sourceSessionHash: fixture.sourceSessionHash,
				deviceHash: fixture.deviceHash,
				returnPath: "/create",
				state: "LINKING",
				tokenHash: "1".repeat(64),
				idempotencyKey: "link-fenced-intent",
				expiresAt: new Date(fixture.now.getTime() + 15 * 60_000),
			},
		});

		await expect(
			createGuestAdmission(guestAdmissionInput(fixture, { idempotencyKey: "guest-link-fenced" })),
		).rejects.toThrow("GUEST_LINK_IN_PROGRESS");
		await expect(
			Promise.all([
				client.guestMediaTrial.count({ where: { ownerId: fixture.ownerId } }),
				client.generationJob.count({ where: { ownerId: fixture.ownerId } }),
				client.creditAccount.count({ where: { ownerId: fixture.ownerId } }),
			]),
		).resolves.toEqual([0, 0, 0]);
	});

	async function createGuestFixture(label: string, now = new Date()) {
		const suffix = `${label}-${randomUUID()}`;
		const ownerId = `guest-${suffix}`;
		const sessionId = `session-${suffix}`;
		const sourceSessionHash = hashFixture(`session:${suffix}`);
		const deviceHash = hashFixture(`device:${suffix}`);
		const assetId = `asset-${suffix}`;
		const draftId = `draft-${suffix}`;
		const bootstrapId = `bootstrap-${suffix}`;
		const checksum = hashFixture(`asset:${suffix}`);
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
				verificationRuleVersion: "media-safety-rule-v1",
				verificationPolicyVersion: "media-safety-policy-v1",
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
				ruleVersion: "media-safety-rule-v1",
				policyVersion: "media-safety-policy-v1",
				status: "APPROVED",
				reasonCode: "ALLOW",
				categories: {},
				rawEnvelope: {},
				validUntil,
			},
		});
		await client.mediaAsset.update({
			where: { id: assetId },
			data: { status: "READY" },
		});
		await client.generationDraft.create({
			data: {
				id: draftId,
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				claimTokenHash: hashFixture(`claim:${suffix}`),
				assetId,
				productKey: "image-fast",
				inputSnapshot: { kind: "image-to-image", prompt: "Make the sky violet" },
				status: "SUBMITTED",
				expiresAt: validUntil,
			},
		});
		await client.guestSessionBootstrap.create({
			data: {
				id: bootstrapId,
				ownerId,
				promotionPeriod,
				claimHash: hashFixture(`bootstrap-claim:${suffix}`),
				idempotencyKey: `bootstrap-idempotency-${suffix}`,
				claimedDraftId: draftId,
				sourceAssetId: assetId,
				createdAt: now,
				expiresAt: validUntil,
				completedAt: now,
			},
		});
		return {
			assetId,
			bootstrapId,
			checksum,
			deviceHash,
			draftId,
			now,
			ownerId,
			promotionPeriod,
			sessionId,
			sourceSessionHash,
			validUntil,
		};
	}
});

interface GuestFixture {
	assetId: string;
	bootstrapId: string;
	checksum: string;
	deviceHash: string;
	draftId: string;
	now: Date;
	ownerId: string;
	promotionPeriod: string;
	sessionId: string;
	sourceSessionHash: string;
	validUntil: Date;
}

function guestAdmissionInput(
	fixture: GuestFixture,
	overrides: {
		idempotencyKey: string;
		maximumGlobalQueueDepth?: number;
		queueCapacity?: number;
	},
) {
	const quoteBase = {
		ownerType: "USER" as const,
		ownerId: fixture.ownerId,
		submittedByUserId: fixture.ownerId,
		productKey: "image-fast",
		catalogVersion: "catalog-v1",
		pricingVersion: "pricing-v1",
		credits: 4n,
		costMicros: 3500n,
		inputSnapshot: {
			kind: "image-to-image",
			prompt: "Make the sky violet",
			sourceAssetId: fixture.assetId,
		},
		pricingSnapshot: { settlementPolicy: { maxCharge: "4" } },
		expiresAt: new Date(fixture.now.getTime() + 10 * 60_000),
	};
	return {
		ownerId: fixture.ownerId,
		promotionPeriod: fixture.promotionPeriod,
		capabilityVersion: "guest-v7",
		sourceSessionHash: fixture.sourceSessionHash,
		deviceHash: fixture.deviceHash,
		ipHash: hashFixture(`ip:${fixture.ownerId}`),
		subnetHash: hashFixture(`subnet:${fixture.ownerId}`),
		idempotencyKey: overrides.idempotencyKey,
		idempotencyFingerprint: hashFixture(`admission:${overrides.idempotencyKey}`),
		turnstile: {
			tokenHash: hashFixture(`turnstile:${overrides.idempotencyKey}`),
			challengeTimestamp: fixture.now,
			expiresAt: new Date(fixture.now.getTime() + 5 * 60_000),
		},
		sourceDraftId: fixture.draftId,
		sourceBootstrapId: fixture.bootstrapId,
		sourceAssetId: fixture.assetId,
		sourceAssetChecksum: fixture.checksum,
		now: fixture.now,
		retentionMs: 24 * 60 * 60_000,
		queueTtlMs: 15 * 60_000,
		serviceTimeMs: 60_000,
		queueCapacity: overrides.queueCapacity ?? 1,
		maximumBytes: 10 * 1024 * 1024,
		maximumGlobalQueueDepth: overrides.maximumGlobalQueueDepth ?? 100,
		maximumActiveJobsPerGuest: 1,
		maximumRequestsPerMinute: 100,
		maximumRequestsPerIpPerHour: 100,
		riskBudgetMicros: 350_000n,
		sponsorCredits: 4n,
		assetModeration: {
			provider: "test",
			ruleVersion: "media-safety-rule-v1",
			policyVersion: "media-safety-policy-v1",
		},
		quote: {
			...quoteBase,
			moderation: {
				decision: "ALLOW" as const,
				provider: "test",
				ruleVersion: "text-safety-2026-08-14.1",
				reasonCode: "ALLOW",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteBase),
			},
		},
	};
}

function createGuestAdmission(input: ReturnType<typeof guestAdmissionInput>) {
	return createGuestGenerationTransaction(input, client, () => ({
		productKey: input.quote.productKey,
		catalogVersion: input.quote.catalogVersion,
		pricingVersion: input.quote.pricingVersion,
		credits: input.quote.credits,
		costMicros: input.quote.costMicros,
		pricingSnapshot: input.quote.pricingSnapshot,
	}));
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

function hashFixture(value: string): string {
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
