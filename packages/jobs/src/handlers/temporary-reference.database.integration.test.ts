import { PrismaPg } from "@prisma/adapter-pg";
import {
	createRouteGraphSnapshot,
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	TestMediaSafetyAdapter,
} from "@repo/ai";
import {
	DEFAULT_PRODUCT_CONFIG,
	temporaryReferenceObjectKey,
	type TemporaryReference,
} from "@repo/config";
import {
	applyAdminModerationReview,
	commitTemporaryReferenceVerificationTransaction,
	createCreditGrant,
	createGenerationJobTransaction,
	createModeratedGenerationQuoteTransaction,
	finalizeStorageUsageReservation,
	fingerprintGenerationQuoteSecurityPayload,
	reserveTemporaryReference,
	unexpiredStorageReservations,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { providerCapacityForTestRequests } from "../../../database/test-support/provider-dispatch-capacity";
import { IMAGE_APPROVAL_NO_TIME_EXPIRY } from "../media-approval-lifetime";
import {
	createDatabaseDispatchStore,
	createDatabaseSettlementStore,
	createDatabaseVerifyUploadDependencies,
} from "../runtime";
import { settleGeneration } from "./settle-generation";

let client: PrismaClient;
let mockProviderConcurrency: string;
const environment = {
	...process.env,
	MEDIA_GENERATION_ENABLED: "true",
	MEDIA_SAFETY_ADAPTER: "configured",
	MODERATION_IMAGE_SEEAPI_ENABLED: "true",
	MODERATION_IMAGE_SIGHTENGINE_ENABLED: "false",
};
const signedRead = vi.fn(
	async ({ key }: { key: string }) => `https://private.example/${encodeURIComponent(key)}`,
);
function dispatchStore() {
	return createDatabaseDispatchStore(client, {
		environment: {
			...environment,
			VIDEO_RUNTIME_CONFIG: undefined,
			VIDEO_V1_PROVIDER_CONCURRENCY: mockProviderConcurrency,
		},
		enabledProviders: new Set(["kie"]),
		createSignedReadUrl: signedRead,
	});
}
const noStorageRead = async () => {
	throw new Error("Immutable references must not be inspected again");
};

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (
		!url ||
		!["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
		!new URL(url).pathname.includes("test")
	)
		throw new Error("UNSAFE_TEST_DATABASE");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
	// This suite creates fewer than 16 mocked Kie submissions, preserving old in-flight rows.
	mockProviderConcurrency = await providerCapacityForTestRequests(client, 16);
});
afterAll(async () => client?.$disconnect());
afterEach(() => vi.unstubAllEnvs());

async function fixture(
	referenceRemainingMs = 86_400_000,
	preReview = false,
	verificationPolicyVersion = MEDIA_VERIFICATION_POLICY_VERSION,
) {
	const ownerId = `temporary-test-${crypto.randomUUID()}`;
	const assetId = crypto.randomUUID();
	const now = new Date();
	const reference: TemporaryReference = {
		v: 1,
		ownerId,
		assetId,
		contentType: "image/png",
		bytes: 30_802,
		checksum: "b".repeat(64),
		createdAt: new Date(now.getTime() - 86_400_000 + referenceRemainingMs).toISOString(),
		expiresAt: new Date(now.getTime() + referenceRemainingMs).toISOString(),
	};
	const storageReservation = await reserveTemporaryReference(
		{
			ownerId,
			assetId,
			bytes: reference.bytes,
			expiresAt: new Date(reference.expiresAt),
			maximumBytes: 10_000_000n,
		},
		client,
	);
	const prepare = () =>
		commitTemporaryReferenceVerificationTransaction(
			{
				ownerId,
				reservationId: storageReservation.id,
				reference,
				verification: {
					provider: "seeapi",
					ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
					policyVersion: verificationPolicyVersion,
				},
			},
			client,
		);
	const preparation = preReview ? await prepare() : undefined;
	if (!preReview) await finalizeStorageUsageReservation(storageReservation.id, "COMMITTED", client);
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{ accountId: account.id, amount: 100n, referenceKey: `temporary-grant:${ownerId}` },
		client,
	);
	const graph = createRouteGraphSnapshot({
		productKey: "image-nano-banana-2-lite",
		catalogVersion: DEFAULT_PRODUCT_CONFIG.catalogVersion,
		pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
		routes: [
			{
				provider: "kie",
				providerModelId: "nano-banana-2-lite",
				providerCostMicros: 20_000,
				weight: 100,
			},
		],
	});
	const quoteInput = {
		ownerType: "USER" as const,
		ownerId,
		submittedByUserId: ownerId,
		productKey: "image-nano-banana-2-lite",
		catalogVersion: DEFAULT_PRODUCT_CONFIG.catalogVersion,
		pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
		credits: 5n,
		costMicros: 20_000n,
		expiresAt: new Date(now.getTime() + 600_000),
		inputSnapshot: {
			kind: "image-to-image",
			prompt: "test",
			sourceAssetId: assetId,
			skuKey: "nano-banana-2-lite-1k",
			aspectRatio: "auto",
			editContext: { kind: "ROOT", rootAssetId: assetId },
			temporaryReference: reference,
		},
		pricingSnapshot: {
			skuKey: "nano-banana-2-lite-1k",
			credits: "5",
			settlementPolicy: { unitCredits: "5", requestedOutputCount: 1, maxCharge: "5" },
			routeGraph: { ...graph, allowedRoutes: graph.allowedRoutes.map((route) => ({ ...route })) },
		},
	};
	const quote = await createModeratedGenerationQuoteTransaction(
		{
			...quoteInput,
			moderation: {
				decision: "ALLOW",
				provider: "waffo",
				ruleVersion: "TEST_REFERENCE_V1",
				reasonCode: "TEST_ALLOW",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
			},
		},
		client,
	);
	const create = () =>
		createGenerationJobTransaction(
			{
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				quoteId: quote.id,
				idempotencyKey: `temporary-job:${assetId}`,
				inputAssetIds: [assetId],
				maximumConcurrentJobs: 2,
				maximumStorageBytes: 10_000_000n,
				expectedModerationRuleVersion: "TEST_REFERENCE_V1",
				expectedModerationProvider: "waffo",
				expectedAssetModerationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				expectedAssetModerationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				edit: { kind: "ROOT", rootAssetId: assetId },
			},
			client,
		);
	return { ownerId, assetId, reference, account, quote, create, prepare, preparation };
}

function verification(safety: TestMediaSafetyAdapter) {
	return createDatabaseVerifyUploadDependencies(client, {
		safety,
		moderationProvider: "seeapi",
		createSignedReadUrl: signedRead,
		headObject: noStorageRead,
		readMediaHeader: noStorageRead,
		inspectPrivateMediaObject: noStorageRead,
	});
}

async function requestAdminReview(assetId: string, action: "RECHECK" | "REJECT") {
	const asset = await client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
	const now = new Date();
	const review = await client.moderationReview.create({
		data: {
			targetType: "ASSET",
			targetId: assetId,
			provider: "seeapi",
			stage: "IMAGE",
			status: "PENDING_REVIEW",
			attemptEpoch: String(asset.verificationGeneration),
			lastErrorCode: "MANUAL_REVIEW_REQUESTED",
			firstFailureAt: now,
			lastFailureAt: now,
		},
	});
	return applyAdminModerationReview(
		{
			reviewId: review.id,
			version: review.version,
			action,
			reason: "Fixture requests a review of the immutable input",
			idempotencyKey: `temporary-review:${assetId}:${action}`,
			actorUserId: "temporary-review-test-admin",
			verification: {
				provider: "seeapi",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			},
		},
		client,
	);
}

describe("temporary reference generation boundary", () => {
	it("reviews a committed upload before Generate and reuses the approved generation without another paid review", async () => {
		const f = await fixture(86_400_000, true);
		expect(f.preparation?.continuationEventIds).toHaveLength(1);
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await client.creditAccount.findUnique({ where: { id: f.account.id } })).toMatchObject({
			reservedCredits: 0n,
		});
		const safety = new TestMediaSafetyAdapter("ALLOW");
		const moderate = vi.spyOn(safety, "moderateImage");
		const verifier = verification(safety);
		await verifier.verify(f.assetId);
		const approved = await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } });
		expect(approved).toMatchObject({
			status: "READY",
			verificationGeneration: 1,
			checksum: f.reference.checksum,
		});
		const { job, continuationEventIds } = await f.create();
		expect(
			await client.outboxEvent.findMany({
				where: { id: { in: continuationEventIds } },
				select: { eventType: true },
			}),
		).toEqual([{ eventType: "JOB_CREATED" }]);
		await verifier.verify(f.assetId);
		expect(moderate).toHaveBeenCalledOnce();
		expect(await client.mediaAsset.findUnique({ where: { id: f.assetId } })).toMatchObject({
			verificationGeneration: approved.verificationGeneration,
			verificationAttemptCount: approved.verificationAttemptCount,
		});
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: f.assetId, eventType: "MEDIA_ASSET_VERIFY" },
			}),
		).toBe(1);
		expect(
			await dispatchStore().claimDispatch({ jobId: job.id, version: job.version }),
		).not.toBeNull();
	});
	it("attaches Generate to pre-existing PENDING review and never duplicates its paid submit", async () => {
		const f = await fixture(86_400_000, true);
		let pending = true;
		const submitImage = vi.fn(async (input: { idempotencyKey: string; ruleVersion: string }) => ({
			moderationTaskId: `pre-review-${f.assetId}`,
			status: "QUEUED" as const,
			ruleVersion: input.ruleVersion,
			idempotency: { key: input.idempotencyKey, providerSupported: false, replayed: false },
		}));
		const retrieveImage = vi.fn(async ({ ruleVersion }: { ruleVersion: string }) => ({
			decision: pending ? ("REVIEW" as const) : ("ALLOW" as const),
			reasonCode: pending ? "IMAGE_PROCESSING" : "NO_POLICY_MATCH",
			ruleVersion,
		}));
		const verifier = verification(
			Object.assign(new TestMediaSafetyAdapter("ERROR"), { submitImage, retrieveImage }),
		);
		await verifier.verify(f.assetId);
		const reviewing = await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } });
		expect(reviewing.verificationProviderTaskId).toBe(`pre-review-${f.assetId}`);
		expect(await f.prepare()).toMatchObject({ continuationEventIds: [] });
		const { job } = await f.create();
		expect(await client.mediaAsset.findUnique({ where: { id: f.assetId } })).toMatchObject({
			verificationGeneration: reviewing.verificationGeneration,
			verificationProviderTaskId: reviewing.verificationProviderTaskId,
			verificationSubmissionToken: reviewing.verificationSubmissionToken,
		});
		expect(await dispatchStore().claimDispatch({ jobId: job.id, version: job.version })).toBeNull();
		pending = false;
		await client.mediaAsset.update({
			where: { id: f.assetId },
			data: { verificationNextAttemptAt: new Date(0) },
		});
		await verifier.verify(f.assetId);
		expect(submitImage).toHaveBeenCalledOnce();
		expect(retrieveImage).toHaveBeenCalledTimes(2);
		expect(
			await dispatchStore().claimDispatch({ jobId: job.id, version: job.version }),
		).not.toBeNull();
	});
	it("rejects a complete historical approval under the old policy before reserving credits", async () => {
		const oldPolicy = "media-policy-2026-09-08.1";
		const f = await fixture(86_400_000, true, oldPolicy);
		// Reproduce an old receiver's valid commit: append complete evidence first,
		// then publish READY under that same policy. Existing evidence is never edited.
		const original = await client.$transaction(async (tx) => {
			const validUntil = new Date(IMAGE_APPROVAL_NO_TIME_EXPIRY);
			const evidence = await tx.assetModerationResult.create({
				data: {
					assetId: f.assetId,
					assetChecksum: f.reference.checksum,
					verificationGeneration: 1,
					attemptNumber: 1,
					evidenceKind: "INPUT",
					provider: "seeapi",
					providerTaskId: null,
					ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
					policyVersion: oldPolicy,
					status: "APPROVED",
					reasonCode: "TEST_HISTORICAL_ALLOW",
					categories: {},
					rawEnvelope: { decision: "ALLOW" },
					validUntil,
				},
			});
			await tx.mediaAsset.update({
				where: { id: f.assetId },
				data: {
					status: "READY",
					verificationAttemptCount: 1,
					verificationValidUntil: validUntil,
					verificationDeadlineAt: null,
				},
			});
			return evidence;
		});
		await expect(f.create()).rejects.toThrow("ASSET_MODERATION_EVIDENCE_STALE");
		expect(await client.assetModerationResult.findUnique({ where: { id: original.id } })).toEqual(
			original,
		);
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await client.creditAccount.findUnique({ where: { id: f.account.id } })).toMatchObject({
			reservedCredits: 0n,
		});
	});
	it("reserves a waiting job during legal reverification but cannot dispatch using an earlier generation's approval", async () => {
		const f = await fixture(86_400_000, true);
		const safety = new TestMediaSafetyAdapter("ALLOW");
		const moderate = vi.spyOn(safety, "moderateImage");
		const verifier = verification(safety);
		await verifier.verify(f.assetId);
		const original = await client.assetModerationResult.findFirstOrThrow({
			where: { assetId: f.assetId },
		});
		await requestAdminReview(f.assetId, "RECHECK");
		expect(await client.mediaAsset.findUnique({ where: { id: f.assetId } })).toMatchObject({
			status: "VERIFYING",
			verificationGeneration: 2,
			verificationAttemptCount: 0,
		});
		expect(
			await client.assetModerationResult.count({
				where: { assetId: f.assetId, verificationGeneration: 2 },
			}),
		).toBe(0);
		// VERIFYING admission intentionally reserves and waits; it is not approval.
		const { job } = await f.create();
		expect(await client.creditAccount.findUnique({ where: { id: f.account.id } })).toMatchObject({
			reservedCredits: 5n,
		});
		expect(await dispatchStore().claimDispatch({ jobId: job.id, version: job.version })).toBeNull();
		expect(await client.generationAttempt.count({ where: { jobId: job.id } })).toBe(0);
		await verifier.verify(f.assetId);
		expect(moderate).toHaveBeenCalledTimes(2);
		expect(
			await client.assetModerationResult.findFirstOrThrow({
				where: { assetId: f.assetId, verificationGeneration: 2 },
			}),
		).toMatchObject({ status: "APPROVED" });
		expect(await client.assetModerationResult.findUnique({ where: { id: original.id } })).toEqual(
			original,
		);
		const current = await client.generationJob.findUniqueOrThrow({ where: { id: job.id } });
		expect(
			await dispatchStore().claimDispatch({ jobId: job.id, version: current.version }),
		).not.toBeNull();
	});
	it("rejects an approval revoked by an appended administrator decision without rewriting prior evidence", async () => {
		const f = await fixture(86_400_000, true);
		await verification(new TestMediaSafetyAdapter("ALLOW")).verify(f.assetId);
		const original = await client.assetModerationResult.findFirstOrThrow({
			where: { assetId: f.assetId },
		});
		await requestAdminReview(f.assetId, "REJECT");
		expect(
			await client.assetModerationResult.findFirstOrThrow({
				where: { assetId: f.assetId },
				orderBy: { attemptNumber: "desc" },
			}),
		).toMatchObject({ status: "REJECTED", attemptNumber: original.attemptNumber + 1 });
		expect(await client.assetModerationResult.findUnique({ where: { id: original.id } })).toEqual(
			original,
		);
		expect(await client.mediaAsset.findUnique({ where: { id: f.assetId } })).toMatchObject({
			status: "QUARANTINED",
		});
		await expect(f.create()).rejects.toThrow("ASSET_NOT_READY");
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await client.creditAccount.findUnique({ where: { id: f.account.id } })).toMatchObject({
			reservedCredits: 0n,
		});
	});
	it("concurrent preparation commits one review generation and one outbox intent", async () => {
		const f = await fixture();
		const results = await Promise.all([f.prepare(), f.prepare()]);
		expect(results.flatMap((result) => result.continuationEventIds)).toHaveLength(1);
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: f.assetId, eventType: "MEDIA_ASSET_VERIFY" },
			}),
		).toBe(1);
		expect(await client.mediaAsset.findUnique({ where: { id: f.assetId } })).toMatchObject({
			verificationGeneration: 1,
		});
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
	});
	it("allows a still-valid reference close to expiry through moderation and dispatch", async () => {
		const f = await fixture(60_000);
		const { job } = await f.create();
		await verification(new TestMediaSafetyAdapter("ALLOW")).verify(f.assetId);
		expect(await dispatchStore().claimDispatch({ jobId: job.id, version: 0 })).not.toBeNull();
	});
	it("does not resurrect a deleted reference when a stale verification event arrives after expiry", async () => {
		const f = await fixture();
		await f.create();
		await client.mediaAsset.update({
			where: { id: f.assetId },
			data: { status: "DELETED", deletedAt: new Date(), deleteAfter: new Date(0) },
		});
		const safety = new TestMediaSafetyAdapter("ALLOW");
		const moderate = vi.spyOn(safety, "moderateImage");
		await verification(safety).verify(f.assetId);
		expect(await client.mediaAsset.findUnique({ where: { id: f.assetId } })).toMatchObject({
			status: "DELETED",
		});
		expect(moderate).not.toHaveBeenCalled();
	});
	it("expires a pending reference without a model call and releases its credit hold", async () => {
		const f = await fixture();
		const { job } = await f.create();
		await client.mediaAsset.update({
			where: { id: f.assetId },
			data: { deleteAfter: new Date(0) },
		});
		const safety = new TestMediaSafetyAdapter("ALLOW");
		const moderate = vi.spyOn(safety, "moderateImage");
		// The claim exits without calling the detector, but its transaction commits
		// settlement work. It must not be classified as an unchanged duplicate.
		expect(await verification(safety).verify(f.assetId)).toEqual({ outboxCommitted: true });
		expect(await verification(safety).verify(f.assetId)).toEqual({ outboxCommitted: false });
		expect(moderate).not.toHaveBeenCalled();
		expect(await client.generationAttempt.count({ where: { jobId: job.id } })).toBe(0);
		const current = await client.generationJob.findUniqueOrThrow({ where: { id: job.id } });
		expect(current.status).toBe("FINALIZING");
		await settleGeneration(
			{ jobId: job.id, version: current.version },
			{ store: createDatabaseSettlementStore(client) },
		);
		expect(await client.creditReservation.findUnique({ where: { jobId: job.id } })).toMatchObject({
			settledAmount: 0n,
			releasedAmount: 5n,
		});
	});
	it("creates the asset, binding, hold and verification event atomically only on Generate; retries reuse one job", async () => {
		const f = await fixture();
		expect(await client.mediaAsset.findUnique({ where: { id: f.assetId } })).toBeNull();
		expect(await client.outboxEvent.count({ where: { aggregateId: f.assetId } })).toBe(0);
		const [first, second] = await Promise.all([f.create(), f.create()]);
		expect(first.job.id).toBe(second.job.id);
		expect([first.replayed, second.replayed].sort((a, b) => Number(a) - Number(b))).toEqual([
			false,
			true,
		]);
		expect(await client.mediaUploadSession.count({ where: { assetId: f.assetId } })).toBe(0);
		expect(await client.mediaAsset.findUnique({ where: { id: f.assetId } })).toMatchObject({
			status: "VERIFYING",
			objectKey: temporaryReferenceObjectKey(f.reference),
			checksum: f.reference.checksum,
		});
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: f.assetId, eventType: "MEDIA_ASSET_VERIFY" },
			}),
		).toBe(1);
		expect(await client.creditAccount.findUnique({ where: { id: f.account.id } })).toMatchObject({
			reservedCredits: 5n,
		});
		expect(await dispatchStore().claimDispatch({ jobId: first.job.id, version: 0 })).toBeNull();
		expect(await client.generationAttempt.count({ where: { jobId: first.job.id } })).toBe(0);
	});
	it("polls SeeAPI once per tick, then dispatches the exact approved immutable reference without internal receipt metadata", async () => {
		const f = await fixture();
		const { job } = await f.create();
		let pending = true;
		const submitImage = vi.fn(
			async (input: { idempotencyKey: string; ruleVersion: string; assetUrl: string }) => ({
				moderationTaskId: `seeapi-${f.assetId}`,
				status: "QUEUED" as const,
				ruleVersion: input.ruleVersion,
				idempotency: { key: input.idempotencyKey, providerSupported: false, replayed: false },
			}),
		);
		const retrieveImage = vi.fn(async ({ ruleVersion }: { ruleVersion: string }) => ({
			decision: pending ? ("REVIEW" as const) : ("ALLOW" as const),
			reasonCode: pending ? "IMAGE_PROCESSING" : "NO_POLICY_MATCH",
			ruleVersion,
		}));
		const verifier = verification(
			Object.assign(new TestMediaSafetyAdapter("ERROR"), { submitImage, retrieveImage }),
		);
		await verifier.verify(f.assetId);
		expect(await dispatchStore().claimDispatch({ jobId: job.id, version: 0 })).toBeNull();
		pending = false;
		await client.mediaAsset.update({
			where: { id: f.assetId },
			data: { verificationNextAttemptAt: new Date(0) },
		});
		await verifier.verify(f.assetId);
		await verifier.verify(f.assetId);
		expect(submitImage).toHaveBeenCalledOnce();
		expect(retrieveImage).toHaveBeenCalledTimes(2);
		const claim = await dispatchStore().claimDispatch({ jobId: job.id, version: 0 });
		if (claim && ("deferred" in claim || "phaseOwnershipLost" in claim))
			throw new Error("Expected available provider capacity");
		expect(claim).not.toBeNull();
		expect(claim!.input).toMatchObject({
			sourceAsset: { assetId: f.assetId, transferUrl: submitImage.mock.calls[0]![0].assetUrl },
		});
		expect(claim!.input).not.toHaveProperty("temporaryReference");
		expect(claim!.input).not.toHaveProperty("editContext");
		// A later expiry must not cancel/refund or submit a second attempt after acceptance became uncertain.
		await client.generationJob.update({
			where: { id: job.id },
			data: { status: "NEEDS_RECONCILIATION" },
		});
		await client.generationAttempt.update({
			where: { id: claim!.attemptId },
			data: { status: "SUBMISSION_UNCERTAIN", uncertainSubmission: true },
		});
		await client.mediaAsset.update({
			where: { id: f.assetId },
			data: { deleteAfter: new Date(0) },
		});
		await verifier.verify(f.assetId);
		expect(await client.generationJob.findUnique({ where: { id: job.id } })).toMatchObject({
			status: "NEEDS_RECONCILIATION",
		});
		expect(await client.mediaAsset.findUnique({ where: { id: f.assetId } })).toMatchObject({
			status: "READY",
		});
		expect(await client.creditAccount.findUnique({ where: { id: f.account.id } })).toMatchObject({
			reservedCredits: 5n,
		});
		expect(await client.generationAttempt.count({ where: { jobId: job.id } })).toBe(1);
	});
	it.each(["REJECT", "REVIEW", "ERROR"] as const)(
		"never submits the model on %s and releases the credit hold",
		async (decision) => {
			const f = await fixture();
			const { job } = await f.create();
			const safety = new TestMediaSafetyAdapter(decision);
			if (decision === "ERROR")
				safety.moderateImage = async ({ ruleVersion }) => ({
					decision: "ERROR",
					reasonCode: "MODERATION_TIMEOUT",
					ruleVersion,
				});
			const verifier = verification(safety);
			for (let tick = 0; tick < (decision === "ERROR" ? 4 : 1); tick++) {
				await verifier.verify(f.assetId);
				await client.mediaAsset.update({
					where: { id: f.assetId },
					data: { verificationNextAttemptAt: new Date(0) },
				});
			}
			expect(
				await client.assetModerationResult.count({
					where: { assetId: f.assetId, status: "BYPASSED" },
				}),
			).toBe(0);
			expect(await dispatchStore().claimDispatch({ jobId: job.id, version: 0 })).toBeNull();
			expect(await client.generationAttempt.count({ where: { jobId: job.id } })).toBe(0);
			const current = await client.generationJob.findUniqueOrThrow({ where: { id: job.id } });
			expect(current.status).toBe("FINALIZING");
			await settleGeneration(
				{ jobId: job.id, version: current.version },
				{ store: createDatabaseSettlementStore(client) },
			);
			expect(await client.creditReservation.findUnique({ where: { jobId: job.id } })).toMatchObject(
				{ settledAmount: 0n, releasedAmount: 5n },
			);
		},
	);
	it("rejects a missing quota reservation and rolls back partial job creation on insufficient credits", async () => {
		const f = await fixture();
		await client.storageUsageReservation.deleteMany({ where: { ownerId: f.ownerId } });
		await expect(f.create()).rejects.toThrow("TEMPORARY_REFERENCE_INVALID");
		expect(await client.mediaAsset.findUnique({ where: { id: f.assetId } })).toBeNull();
		const insufficient = await fixture();
		await client.creditLot.updateMany({
			where: { accountId: insufficient.account.id },
			data: { remainingAmount: 0n },
		});
		await client.creditAccount.update({
			where: { id: insufficient.account.id },
			data: { spendableCredits: 0n },
		});
		await expect(insufficient.create()).rejects.toThrow();
		expect(await client.mediaAsset.findUnique({ where: { id: insufficient.assetId } })).toBeNull();
		expect(await client.outboxEvent.count({ where: { aggregateId: insufficient.assetId } })).toBe(
			0,
		);
	});
	it.each([false, true])(
		"enforces raced quota and retention with automatic deletion %s",
		async (automaticDeletion) => {
			vi.stubEnv("MEDIA_IMAGE_AUTO_DELETE_ENABLED", automaticDeletion ? "true" : undefined);
			const ownerId = `quota-${crypto.randomUUID()}`;
			const attempts = await Promise.allSettled(
				[1, 2].map(() =>
					reserveTemporaryReference(
						{
							ownerId,
							assetId: crypto.randomUUID(),
							bytes: 60,
							expiresAt: new Date(Date.now() + 86_400_000),
							maximumBytes: 100n,
						},
						client,
					),
				),
			);
			expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
			await client.storageUsageReservation.updateMany({
				where: { ownerId },
				data: { expiresAt: new Date(0) },
			});
			await client.storageUsageReservation.create({
				data: {
					ownerType: "USER",
					ownerId,
					bytes: 10n,
					status: "COMMITTED",
					expiresAt: new Date(0),
					referenceKey: `permanent:${ownerId}`,
				},
			});
			const usage = await client.storageUsageReservation.aggregate({
				where: {
					ownerId,
					status: { in: ["ACTIVE", "COMMITTED"] },
					...unexpiredStorageReservations(),
				},
				_sum: { bytes: true },
			});
			expect(usage._sum.bytes).toBe(automaticDeletion ? 10n : 70n);
		},
	);
});
