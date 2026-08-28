import { createHash, randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "../../generated/client";
import { createGuestGenerationTransaction, lockGuestOwnerPromotion } from "./guest-admission";
import { beginGuestLinkIntentTransaction, completeGuestLinkIntentTransaction } from "./guest-link";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;
let client: PrismaClient;

describe("guest account-link fence", () => {
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

	it("durably links a pre-admission draft without leaving a trial, grant, or sponsor graph", async () => {
		const fixture = await createFixture("pre-admission");
		const tokenHash = hashFixture(`link:${fixture.ownerId}`);
		const intent = await beginGuestLinkIntentTransaction(linkInput(fixture, tokenHash), client);
		expect(intent).toMatchObject({ state: "LINKING", claimedDraftId: fixture.draftId });

		const completed = await completeGuestLinkIntentTransaction(
			{
				tokenHash,
				registeredUserId: fixture.registeredUserId,
				grantTokenHash: hashFixture(`grant:${fixture.ownerId}`),
				now: fixture.now,
			},
			client,
		);

		expect(completed).toMatchObject({ mode: "DRAFT", returnPath: "/create" });
		await expect(
			client.guestLinkIntent.findUniqueOrThrow({ where: { id: intent.id } }),
		).resolves.toMatchObject({
			state: "LINKED",
			trialId: null,
			claimedDraftId: fixture.draftId,
			registeredUserId: fixture.registeredUserId,
		});
		await expect(
			client.generationDraft.findUniqueOrThrow({ where: { id: fixture.draftId } }),
		).resolves.toMatchObject({
			ownerId: fixture.registeredUserId,
			submittedByUserId: fixture.registeredUserId,
			status: "SUBMITTED",
		});
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: fixture.assetId } }),
		).resolves.toMatchObject({ ownerId: fixture.registeredUserId });
		await expect(
			Promise.all([
				client.guestMediaTrial.count({ where: { ownerId: fixture.ownerId } }),
				client.guestResultAccessGrant.count({
					where: { registeredUserId: fixture.registeredUserId },
				}),
				client.creditAccount.count({ where: { ownerId: fixture.ownerId } }),
				client.generationJob.count({ where: { ownerId: fixture.ownerId } }),
				client.session.count({ where: { userId: fixture.ownerId } }),
			]),
		).resolves.toEqual([0, 0, 0, 0, 0]);
	});

	it("grants only the admitted guest job through its original expiry", async () => {
		const fixture = await createFixture("admitted");
		const admitted = await createGuestAdmission(admissionInput(fixture, "guest-admitted-link"));
		const tokenHash = hashFixture(`link:${fixture.ownerId}`);
		const intent = await beginGuestLinkIntentTransaction(linkInput(fixture, tokenHash), client);
		expect(intent).toMatchObject({ state: "LINKING", trialId: admitted.trialId });

		const completed = await completeGuestLinkIntentTransaction(
			{
				tokenHash,
				registeredUserId: fixture.registeredUserId,
				grantTokenHash: hashFixture(`grant:${fixture.ownerId}`),
				now: fixture.now,
			},
			client,
		);
		await expect(
			beginGuestLinkIntentTransaction(linkInput(fixture, tokenHash), client),
		).rejects.toThrow("GUEST_LINK_UNAVAILABLE");
		const trial = await client.guestMediaTrial.findUniqueOrThrow({
			where: { id: admitted.trialId },
		});

		expect(completed).toMatchObject({
			mode: "RESULT",
			jobId: admitted.jobId,
			returnPath: "/try",
			expiresAt: trial.expiresAt,
		});
		await expect(
			client.guestResultAccessGrant.findUniqueOrThrow({
				where: {
					guestJobId_registeredUserId: {
						guestJobId: admitted.jobId,
						registeredUserId: fixture.registeredUserId,
					},
				},
			}),
		).resolves.toMatchObject({
			trialId: admitted.trialId,
			expiresAt: trial.expiresAt,
		});
		await expect(
			client.generationJob.findUniqueOrThrow({ where: { id: admitted.jobId } }),
		).resolves.toMatchObject({ ownerId: fixture.ownerId, serviceClass: "GUEST_SLOW" });
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: fixture.assetId } }),
		).resolves.toMatchObject({ ownerId: fixture.ownerId, retentionClass: "GUEST_TRIAL" });
		await expect(client.session.count({ where: { userId: fixture.ownerId } })).resolves.toBe(0);
	});

	it.each(["SUBMITTING", "SUCCEEDED"] as const)(
		"links the canonical consumed guest job while it is %s",
		async (status) => {
			const fixture = await createFixture(`consumed-${status.toLowerCase()}`);
			const admitted = await createGuestAdmission(
				admissionInput(fixture, `guest-consumed-${status.toLowerCase()}`),
			);
			await client.guestMediaTrial.update({
				where: { id: admitted.trialId },
				data: {
					currentJobId: null,
					consumedJobId: admitted.jobId,
					eligibility: "CONSUMED",
					riskState: "COMMITTED",
					providerBoundaryAt: fixture.now,
					consumedAt: fixture.now,
				},
			});
			await client.generationJob.update({
				where: { id: admitted.jobId },
				data: { status, ...(status === "SUCCEEDED" ? { terminalAt: fixture.now } : {}) },
			});
			const tokenHash = hashFixture(`link-consumed:${fixture.ownerId}`);
			await beginGuestLinkIntentTransaction(linkInput(fixture, tokenHash), client);

			const completed = await completeGuestLinkIntentTransaction(
				{
					tokenHash,
					registeredUserId: fixture.registeredUserId,
					grantTokenHash: hashFixture(`grant-consumed:${fixture.ownerId}`),
					now: fixture.now,
				},
				client,
			);

			expect(completed).toMatchObject({ mode: "RESULT", jobId: admitted.jobId });
			await expect(
				completeGuestLinkIntentTransaction(
					{
						tokenHash,
						registeredUserId: fixture.registeredUserId,
						grantTokenHash: hashFixture(`ignored-replay:${fixture.ownerId}`),
						now: fixture.now,
					},
					client,
				),
			).resolves.toMatchObject({ mode: "RESULT", jobId: admitted.jobId });
		},
	);

	it("rejects an expired consumed-job link without creating a grant", async () => {
		const fixture = await createFixture("consumed-expired");
		const admitted = await createGuestAdmission(admissionInput(fixture, "guest-consumed-expired"));
		const expiredAt = new Date(Date.now() + 10 * 60 * 1000);
		await client.guestMediaTrial.update({
			where: { id: admitted.trialId },
			data: {
				currentJobId: null,
				consumedJobId: admitted.jobId,
				eligibility: "CONSUMED",
				riskState: "COMMITTED",
				providerBoundaryAt: fixture.now,
				consumedAt: fixture.now,
				expiresAt: expiredAt,
			},
		});
		const tokenHash = hashFixture(`link-expired:${fixture.ownerId}`);
		await beginGuestLinkIntentTransaction(linkInput(fixture, tokenHash), client);

		await expect(
			completeGuestLinkIntentTransaction(
				{
					tokenHash,
					registeredUserId: fixture.registeredUserId,
					grantTokenHash: hashFixture(`grant-expired:${fixture.ownerId}`),
					now: new Date(expiredAt.getTime() + 1),
				},
				client,
			),
		).rejects.toThrow("GUEST_LINK_UNAVAILABLE");
		await expect(client.guestResultAccessGrant.count()).resolves.toBe(0);
	});

	it("rejects a begin replay whose owner lock wait spans a completed link", async () => {
		const fixture = await createFixture("completion-before-delayed-begin");
		const tokenHash = hashFixture(`link:${fixture.ownerId}`);
		await beginGuestLinkIntentTransaction(linkInput(fixture, tokenHash), client);

		let signalBlockerReady!: () => void;
		const blockerReady = new Promise<void>((resolve) => {
			signalBlockerReady = resolve;
		});
		let releaseBlocker!: () => void;
		const blockerRelease = new Promise<void>((resolve) => {
			releaseBlocker = resolve;
		});
		const blocker = client.$transaction(async (tx) => {
			await lockGuestOwnerPromotion(tx, fixture.ownerId, fixture.promotionPeriod);
			signalBlockerReady();
			await blockerRelease;
		});
		await blockerReady;

		try {
			const completion = completeGuestLinkIntentTransaction(
				{
					tokenHash,
					registeredUserId: fixture.registeredUserId,
					grantTokenHash: hashFixture(`grant:${fixture.ownerId}`),
					now: fixture.now,
				},
				client,
			);
			await waitForAdvisoryWaiters(1);

			const delayedBegin = beginGuestLinkIntentTransaction(linkInput(fixture, tokenHash), client);
			await waitForAdvisoryWaiters(2);
			releaseBlocker();

			await expect(completion).resolves.toMatchObject({
				mode: "DRAFT",
				draftId: fixture.draftId,
			});
			await expect(delayedBegin).rejects.toThrow("GUEST_LINK_UNAVAILABLE");
			await expect(
				client.guestLinkIntent.findUniqueOrThrow({ where: { tokenHash } }),
			).resolves.toMatchObject({
				state: "LINKED",
				registeredUserId: fixture.registeredUserId,
			});
		} finally {
			releaseBlocker();
			await blocker;
		}
	});

	it("serializes link versus admission into one legal terminal target", async () => {
		const fixture = await createFixture("race");
		const tokenHash = hashFixture(`link:${fixture.ownerId}`);
		const [admission, linking] = await concurrentBarrier([
			() => createGuestAdmission(admissionInput(fixture, "guest-race-link")),
			() => beginGuestLinkIntentTransaction(linkInput(fixture, tokenHash), client),
		]);
		const intent = await client.guestLinkIntent.findUniqueOrThrow({ where: { tokenHash } });
		const trials = await client.guestMediaTrial.findMany({ where: { ownerId: fixture.ownerId } });
		const jobs = await client.generationJob.findMany({ where: { ownerId: fixture.ownerId } });

		if (trials.length === 0) {
			expect(intent).toMatchObject({ trialId: null, claimedDraftId: fixture.draftId });
			expect(jobs).toHaveLength(0);
			expect(admission.status).toBe("rejected");
			expect(linking.status).toBe("fulfilled");
		} else {
			expect(trials).toHaveLength(1);
			expect(jobs).toHaveLength(1);
			expect(intent).toMatchObject({ trialId: trials[0]!.id, claimedDraftId: null });
			expect(admission.status).toBe("fulfilled");
			expect(linking.status).toBe("fulfilled");
		}
	});

	async function createFixture(label: string): Promise<LinkFixture> {
		const suffix = `${label}-${randomUUID()}`;
		const now = new Date("2026-08-28T00:00:00.000Z");
		const validUntil = new Date(now.getTime() + 24 * 60 * 60_000);
		const ownerId = `guest-${suffix}`;
		const registeredUserId = `registered-${suffix}`;
		const assetId = `asset-${suffix}`;
		const draftId = `draft-${suffix}`;
		const bootstrapId = `bootstrap-${suffix}`;
		const checksum = hashFixture(`asset:${suffix}`);
		await client.user.createMany({
			data: [
				{
					id: ownerId,
					name: "Guest",
					email: `${ownerId}@anonymous.invalid`,
					emailVerified: false,
					isAnonymous: true,
					createdAt: now,
					updatedAt: now,
				},
				{
					id: registeredUserId,
					name: "Registered",
					email: `${registeredUserId}@example.test`,
					emailVerified: true,
					isAnonymous: false,
					createdAt: now,
					updatedAt: now,
				},
			],
		});
		await client.session.create({
			data: {
				id: `session-${suffix}`,
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
				promotionPeriod: "launch-2026-08",
				claimHash: hashFixture(`bootstrap:${suffix}`),
				idempotencyKey: `bootstrap-${suffix}`,
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
			deviceHash: hashFixture(`device:${suffix}`),
			draftId,
			now,
			ownerId,
			promotionPeriod: "launch-2026-08",
			registeredUserId,
			sourceSessionHash: hashFixture(`session:${suffix}`),
			validUntil,
		};
	}
});

interface LinkFixture {
	assetId: string;
	bootstrapId: string;
	checksum: string;
	deviceHash: string;
	draftId: string;
	now: Date;
	ownerId: string;
	promotionPeriod: string;
	registeredUserId: string;
	sourceSessionHash: string;
	validUntil: Date;
}

function linkInput(fixture: LinkFixture, tokenHash: string) {
	return {
		anonymousOwnerId: fixture.ownerId,
		promotionPeriod: fixture.promotionPeriod,
		sourceSessionHash: fixture.sourceSessionHash,
		deviceHash: fixture.deviceHash,
		returnPath: "/create" as const,
		idempotencyKey: `link-intent:${fixture.ownerId}`,
		tokenHash,
		now: fixture.now,
		expiresAt: new Date(fixture.now.getTime() + 15 * 60_000),
	};
}

function admissionInput(fixture: LinkFixture, idempotencyKey: string) {
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
		idempotencyKey,
		idempotencyFingerprint: hashFixture(`admission:${idempotencyKey}`),
		turnstile: {
			tokenHash: hashFixture(`turnstile:${idempotencyKey}`),
			challengeTimestamp: fixture.now,
			expiresAt: new Date(fixture.now.getTime() + 5 * 60_000),
		},
		sourceDraftId: fixture.draftId,
		sourceBootstrapId: fixture.bootstrapId,
		sourceAssetId: fixture.assetId,
		sourceAssetChecksum: fixture.checksum,
		now: fixture.now,
		retentionMs: 24 * 60 * 60_000,
		queueTtlMs: 10 * 60_000,
		serviceTimeMs: 60_000,
		maximumBytes: 10 * 1024 * 1024,
		maximumGlobalQueueDepth: 100,
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

function createGuestAdmission(input: ReturnType<typeof admissionInput>) {
	return createGuestGenerationTransaction(input, client, () => ({
		productKey: input.quote.productKey,
		catalogVersion: input.quote.catalogVersion,
		pricingVersion: input.quote.pricingVersion,
		credits: input.quote.credits,
		costMicros: input.quote.costMicros,
		pricingSnapshot: input.quote.pricingSnapshot,
	}));
}

async function concurrentBarrier(
	operations: Array<() => Promise<unknown>>,
): Promise<PromiseSettledResult<unknown>[]> {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const contenders = operations.map(async (operation) => {
		await gate;
		return operation();
	});
	release();
	return Promise.allSettled(contenders);
}

function hashFixture(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

async function waitForAdvisoryWaiters(minimum: number): Promise<void> {
	await vi.waitFor(
		async () => {
			const [row] = await client.$queryRaw<Array<{ count: bigint }>>`
				SELECT count(*)::bigint AS count
				FROM pg_stat_activity
				WHERE datname = current_database()
					AND wait_event_type = 'Lock'
					AND wait_event = 'advisory'
			`;
			expect(Number(row?.count ?? 0)).toBeGreaterThanOrEqual(minimum);
		},
		{ timeout: 5_000, interval: 20 },
	);
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
