import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import type { VideoEffectId } from "@repo/config/video-effects";
import {
	createVideoEffectTemplateSnapshot,
	videoEffectTemplateSnapshotSchema,
} from "@repo/config/video-effects.server";
import { createVideoAudioSafetyPolicy } from "@repo/config/video-output";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { applyVideoSharedFunding } from "@repo/config/video-shared-funding";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";

import { providerCapacityForTestRequests } from "../../../test-support/provider-dispatch-capacity";
import { runWithDatabaseClient } from "../../client";
import { PrismaClient, type Prisma } from "../../generated/client";
import { createMediaUploadSessionTransaction } from "./assets";
import {
	createCreditGrant,
	getCreditInvariantReport,
	refundCreditGrant,
	releaseCredits,
	settleCredits,
} from "./credits";
import {
	grantNewAnnualCredits,
	newAnnualProviders,
	newAnnualTiers,
} from "./testing/annual-credit-fixture";
import { withStorageSubscription } from "./testing/subscriber-storage-fixture";
import {
	createVideoTemplateQuoteRecord,
	createVideoTemplateJobRecord,
	findExistingVideoTemplateAdmission,
} from "./video-template-admission";
import { getVideoTemplateCreditBalance } from "./video-template-credits";
import {
	claimVideoTemplateSceneSubmission,
	recordVideoTemplateReview,
	recordVideoTemplateImageReview,
	recordVideoTemplateSceneAccepted,
	recordVideoTemplateSceneProviderResult,
	prepareVideoTemplateSceneAsset,
	recordVideoTemplateSceneAsset,
	sealVideoTemplateResolvedInput,
	getVideoTemplateExecution,
	persistVideoTemplateSceneWebhook,
	markVideoTemplateNeedsReview,
	markVideoTemplateSceneFailed,
} from "./video-template-execution";
import { createVideoJobRecord, createVideoQuoteRecord, type VideoPrice } from "./video-v1";
import {
	claimVideoResourceCleanup,
	completeVideoResourceCleanup,
	listVideoResourceCleanupCandidates,
	listVideoStagingCleanup,
	completeVideoStagingCleanup,
} from "./video-v1-cleanup";
import {
	failVideoExecution,
	claimVideoProviderSubmission,
	listPendingVideoWebhookEvents,
	markVideoWebhookNotified,
	postponeVideoWebhookNotification,
} from "./video-v1-execution";
import { failVideoDelivery } from "./video-v1-fulfillment";
const profile = createVideoTextSafetyProfile();
const object = (v: unknown) => v as Record<string, unknown>;
let db: PrismaClient;
const owners: string[] = [];
const run = <T>(f: () => T) => runWithDatabaseClient(db, f);
beforeAll(async () => {
	const raw = process.env.TEST_DATABASE_URL;
	if (!raw) throw new Error("TEST_DATABASE_URL_REQUIRED");
	const u = new URL(raw);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || !u.pathname.includes("test"))
		throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
	db = new PrismaClient({ adapter: new PrismaPg({ connectionString: raw, max: 30 }) });
	vi.stubEnv("VIDEO_RUNTIME_CONFIG", undefined);
	vi.stubEnv("VIDEO_V1_PROVIDER_CONCURRENCY", await providerCapacityForTestRequests(db, 32));
});
afterAll(async () => {
	vi.unstubAllEnvs();
	if (!db) return;
	for (const ownerId of owners) {
		const jobs = await db.generationJob.findMany({
			where: { ownerId },
			include: { reservation: true },
		});
		for (const job of jobs) {
			if (job.reservation?.status === "ACTIVE")
				await releaseCredits(
					{ reservationId: job.reservation.id, referenceKey: `template-test-cleanup:${job.id}` },
					db,
				);
			await db.videoExecution.update({ where: { jobId: job.id }, data: { stage: "FAILED" } });
			await db.generationJob.update({
				where: { id: job.id },
				data: { status: "FAILED", terminalAt: new Date() },
			});
		}
	}
	await db.$disconnect();
});
async function fixture(
	credits = 100n,
	effectId: VideoEffectId = "hotel-lobby-duo",
	duration: 5 | 10 = 5,
	pricingDetails: Prisma.InputJsonObject = {
		validUntil: new Date(Date.now() + 3600000).toISOString(),
	},
) {
	const ownerId = `template-db-test-${randomUUID()}`;
	owners.push(ownerId);
	const account = await db.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	if (credits > 0n)
		await createCreditGrant(
			{ accountId: account.id, amount: credits, referenceKey: `grant:${ownerId}` },
			db,
		);
	const assets = await Promise.all(
		[0, 1].map((i) =>
			db.mediaAsset.create({
				data: {
					ownerType: "USER",
					ownerId,
					kind: "INPUT",
					status: "VERIFYING",
					verificationEngine: "video-workflow-v1",
					objectKey: `users/${ownerId}/${i}.template-source.template-input.png`,
					mimeType: "image/png",
					byteSize: 1000n,
					width: 720,
					height: 1280,
					checksum: String(i + 1).repeat(64),
					storageEtag: `etag-${i}`,
					verificationGeneration: 1,
					finalizedAt: new Date(),
				},
			}),
		),
	);
	const request = {
		effectId,
		...(duration === 10 ? { duration: 10 as const } : {}),
		presetKey: "standard" as const,
		inputs: {
			leftAssetId: assets[0]!.id,
			rightAssetId: assets[effectId === "raindance-solo" ? 0 : 1]!.id,
		},
	};
	const template = createVideoEffectTemplateSnapshot(request);
	if (template.schemaVersion === 2) throw new Error("SCENE_TEMPLATE_FIXTURE_REQUIRED");
	const base = {
		ownerId,
		request,
		template,
		price: {
			credits: 7n,
			providerCostMicros: 107500n,
			moderationCostMicros: 10000n,
			pricingBasis: "ISOLATED_TEST_NOT_FORMAL",
			pricingVersion: "TEMPLATE_TEST_V1",
			pricingDetails,
		},
		visualSafetyProfile: createVideoVisualSafetyProfile("seeapi", duration),
		textSafetyProfile: profile,
		audioSafetyPolicy: createVideoAudioSafetyPolicy(),
	};
	const limits = {
		ownerConcurrency: 50,
		globalConcurrency: 10000,
		providerConcurrency: 10000,
		maximumStorageBytes: 1000000000n,
		maximumInputBytes: 10000000,
	};
	const quote = await createVideoTemplateQuoteRecord({ ...base, maximumInputBytes: 10000000 }, db);
	const input = { ...base, quoteId: quote.quoteId, idempotencyKey: randomUUID(), limits };
	return { ownerId, assets, base, quote, input };
}
async function accepted() {
	const f = await fixture();
	const { jobId } = await createVideoTemplateJobRecord(f.input, db);
	return { ...f, jobId };
}
async function sharedFixture(credits = 7n, effectId: VideoEffectId = "hotel-lobby-duo") {
	const f = await fixture(credits, effectId);
	const retailPrice = {
		...f.base.price,
		paidFundingPolicy: { minimumUsdMicrosPerCredit: 21_944n },
		pricingDetails: {},
	} satisfies VideoPrice & { paidFundingPolicy: { minimumUsdMicrosPerCredit: bigint } };
	const price = applyVideoSharedFunding(retailPrice);
	const quote = await createVideoTemplateQuoteRecord(
		{ ...f.base, price, maximumInputBytes: 10000000 },
		db,
	);
	return {
		...f,
		input: { ...f.input, quoteId: quote.quoteId, price, paidFundingPolicy: undefined },
	};
}

it("subscribers retain both template scene and video output byte reservations above the free quota", async () => {
	const f = await fixture();
	await withStorageSubscription(db, f.ownerId, async () => {
		const accepted = await createVideoTemplateJobRecord(
			{ ...f.input, limits: { ...f.input.limits, maximumStorageBytes: 1n } },
			db,
		);
		const job = await db.generationJob.findUniqueOrThrow({ where: { id: accepted.jobId } });
		expect(job.pricingSnapshot).toMatchObject({
			aggregateStoragePolicy: { schemaVersion: 1, maximumBytes: null },
		});
		expect(job.creditsReserved).toBe(f.input.price.credits);
		const reservations = await db.storageUsageReservation.findMany({
			where: { ownerId: f.ownerId, status: "ACTIVE" },
		});
		expect(reservations).toHaveLength(2);
		expect(reservations.reduce((sum, row) => sum + row.bytes, 0n)).toBe(124857600n);
	});
});
const decision = {
	decision: "ALLOW",
	reasonCode: "WAFFO_PROMPT_ALLOWED",
	ruleVersion: profile.ruleVersion,
	evidence: {
		requestId: "test-waffo-1",
		models: ["waffo-prompt-sift"],
		operations: 1,
		waffo: {
			requestId: "test-waffo-1",
			action: "allow",
			semanticStatus: "scored",
			matchedCategories: [],
		},
	},
};
async function reviewInputs(jobId: string) {
	const e = await run(() => getVideoTemplateExecution(jobId));
	for (const value of e!.orderedRoleIdentities as Prisma.JsonArray) {
		const i = object(value);
		await run(() =>
			recordVideoTemplateImageReview(jobId, i.role as "left" | "right", {
				...i,
				decision: { decision: "ALLOW" },
				ruleVersion: "test-video-rule",
				safetyPolicyVersion: object(e!.templateSnapshot).safetyPolicyVersion,
				validUntil: new Date(Date.now() + 3600000).toISOString(),
			}),
		);
	}
	await run(() =>
		recordVideoTemplateReview(jobId, "inputs", {
			status: "ALLOW",
			requestFingerprint: object(e!.job.inputSnapshot).requestFingerprint,
			textSafetyProfile: profile,
			sceneTextDecision: decision,
			motionTextDecision: decision,
		}),
	);
}
async function storedScene(jobId: string) {
	await reviewInputs(jobId);
	await run(() => claimVideoTemplateSceneSubmission({ jobId, callbackTokenHash: randomUUID() }));
	const taskId = randomUUID();
	await run(() => recordVideoTemplateSceneAccepted(jobId, taskId));
	await run(() =>
		recordVideoTemplateSceneProviderResult({
			jobId,
			taskId,
			evidence: { status: "SUCCEEDED", outputUrl: "https://fixture.invalid/scene.png" },
		}),
	);
	const asset = await run(() => prepareVideoTemplateSceneAsset(jobId));
	await run(() =>
		recordVideoTemplateSceneAsset({
			jobId,
			transferToken: asset.outputTransferToken!,
			asset: {
				id: asset.id,
				objectKey: asset.objectKey,
				mimeType: "image/png",
				byteSize: 2000n,
				checksum: "a".repeat(64),
				width: 720,
				height: 1280,
				storageEtag: "scene-etag",
				storageVersionId: null,
			},
		}),
	);
	const e = await run(() => getVideoTemplateExecution(jobId));
	await run(() =>
		recordVideoTemplateImageReview(jobId, "scene", {
			assetId: asset.id,
			objectKey: asset.objectKey,
			checksum: "a".repeat(64),
			storageEtag: "scene-etag",
			storageVersionId: null,
			verificationGeneration: 1,
			decision: { decision: "ALLOW" },
			ruleVersion: "test-video-rule",
			safetyPolicyVersion: object(e!.templateSnapshot).safetyPolicyVersion,
			validUntil: new Date(Date.now() + 3600000).toISOString(),
		}),
	);
	await run(() => recordVideoTemplateReview(jobId, "scene", { status: "ALLOW" }));
	return asset;
}
describe("template admission and durable scene PostgreSQL regressions", () => {
	it.each(["hotel-lobby-duo", "raindance-solo", "raindance-duo"] as const)(
		"spends gifted shared credits for %s without a separate paid-credit wallet",
		async (effectId) => {
			const f = await sharedFixture(7n, effectId);
			const accepted = await createVideoTemplateJobRecord(f.input, db);
			const allocations = await db.creditReservationAllocation.findMany({
				where: { reservation: { jobId: accepted.jobId } },
				include: { lot: true },
			});
			expect(allocations).toHaveLength(1);
			expect(allocations[0]).toMatchObject({
				amount: 7n,
				lot: { grantReferenceKey: `grant:${f.ownerId}` },
			});
			expect(await getCreditInvariantReport(allocations[0]!.lot.accountId, db)).toMatchObject({
				valid: true,
				account: { spendable: 0n, reserved: 7n, debt: 0n },
			});
		},
	);
	it.each(["settle", "release"] as const)(
		"shared template %s keeps mixed annual/gift refund revocations and idempotence",
		async (mode) => {
			const f = await sharedFixture(3n);
			const annual = await grantNewAnnualCredits(db, f.ownerId, {
				...newAnnualTiers[0],
				provider: "paypal",
			});
			await refundCreditGrant(
				{
					accountId: annual.account.id,
					grantReferenceKey: annual.grantReferenceKey,
					amount: 696n,
					referenceKey: `trim:${f.ownerId}`,
				},
				db,
			);
			const accepted = await createVideoTemplateJobRecord(f.input, db);
			const reservation = await db.creditReservation.findUniqueOrThrow({
				where: { jobId: accepted.jobId },
				include: { allocations: { include: { lot: true } } },
			});
			expect(
				Object.fromEntries(
					reservation.allocations.map((allocation) => [
						allocation.lot.grantReferenceKey,
						allocation.amount,
					]),
				),
			).toEqual({ [`grant:${f.ownerId}`]: 3n, [annual.grantReferenceKey]: 4n });
			const refund = {
				accountId: annual.account.id,
				grantReferenceKey: annual.grantReferenceKey,
				amount: 4n,
				referenceKey: `refund:${f.ownerId}`,
			};
			const refunded = await refundCreditGrant(refund, db);
			expect(await refundCreditGrant(refund, db)).toEqual(refunded);
			await createCreditGrant(
				{ accountId: annual.account.id, amount: 7n, referenceKey: `spare:${f.ownerId}` },
				db,
			);
			const mutation = {
				reservationId: reservation.id,
				amount: 7n,
				referenceKey: `${mode}:${f.ownerId}`,
			};
			const finalize = mode === "settle" ? settleCredits : releaseCredits;
			const result = await finalize(mutation, db);
			expect(await finalize(mutation, db)).toEqual(result);
			await expect(finalize({ ...mutation, amount: 6n }, db)).rejects.toThrow(
				"IDEMPOTENCY_CONFLICT",
			);
			expect(await getCreditInvariantReport(annual.account.id, db)).toMatchObject({
				valid: true,
				account: {
					spendable: mode === "settle" ? 7n : 10n,
					reserved: 0n,
					debt: mode === "settle" ? 4n : 0n,
				},
			});
			expect(
				await db.creditLot.findUniqueOrThrow({
					where: {
						accountId_grantReferenceKey: {
							accountId: annual.account.id,
							grantReferenceKey: annual.grantReferenceKey,
						},
					},
				}),
			).toMatchObject({ remainingAmount: 0n, reservedAmount: 0n });
			const refunds = await db.creditLedgerEntry.findMany({
				where: { accountId: annual.account.id, type: "REFUND" },
			});
			expect(refunds.reduce((sum, entry) => sum + entry.amount, 0n)).toBe(700n);
		},
	);
	it("shared template admission excludes expired and fully refunded lots", async () => {
		const f = await sharedFixture(7n);
		const annual = await grantNewAnnualCredits(db, f.ownerId, {
			...newAnnualTiers[0],
			provider: "waffo",
		});
		await refundCreditGrant(
			{
				accountId: annual.account.id,
				grantReferenceKey: annual.grantReferenceKey,
				amount: 700n,
				referenceKey: `refund:${f.ownerId}`,
			},
			db,
		);
		await db.creditLot.update({
			where: {
				accountId_grantReferenceKey: {
					accountId: annual.account.id,
					grantReferenceKey: `grant:${f.ownerId}`,
				},
			},
			data: { expiresAt: new Date(Date.now() - 1000) },
		});
		await expect(createVideoTemplateJobRecord(f.input, db)).rejects.toThrow("INSUFFICIENT_CREDITS");
		expect(await db.creditReservation.count({ where: { accountId: annual.account.id } })).toBe(0);
		await createCreditGrant(
			{ accountId: annual.account.id, amount: 7n, referenceKey: `valid:${f.ownerId}` },
			db,
		);
		const accepted = await createVideoTemplateJobRecord(f.input, db);
		const allocation = await db.creditReservationAllocation.findMany({
			where: { reservation: { jobId: accepted.jobId } },
			include: { lot: true },
		});
		expect(allocation).toHaveLength(1);
		expect(allocation[0]!.lot.grantReferenceKey).toBe(`valid:${f.ownerId}`);
		await db.creditLot.update({
			where: { id: allocation[0]!.lotId },
			data: { expiresAt: new Date(Date.now() - 1000) },
		});
		await releaseCredits(
			{ reservationId: allocation[0]!.reservationId, referenceKey: `expired-release:${f.ownerId}` },
			db,
		);
		expect(await getCreditInvariantReport(annual.account.id, db)).toMatchObject({
			valid: true,
			account: { spendable: 0n, reserved: 0n, debt: 0n },
		});
	});
	it("shared templates cannot overspend a mixed account under competing submissions", async () => {
		const f = await sharedFixture(3n);
		const annual = await grantNewAnnualCredits(db, f.ownerId, {
			...newAnnualTiers[0],
			provider: "paypal",
		});
		await refundCreditGrant(
			{
				accountId: annual.account.id,
				grantReferenceKey: annual.grantReferenceKey,
				amount: 696n,
				referenceKey: `trim:${f.ownerId}`,
			},
			db,
		);
		const second = await createVideoTemplateQuoteRecord(
			{ ...f.base, price: f.input.price, maximumInputBytes: 10000000 },
			db,
		);
		const outcomes = await Promise.allSettled(
			[f.input, { ...f.input, quoteId: second.quoteId, idempotencyKey: randomUUID() }].map(
				(input) => createVideoTemplateJobRecord(input, db),
			),
		);
		expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.find((result) => result.status === "rejected")).toMatchObject({
			reason: new Error("INSUFFICIENT_CREDITS"),
		});
		expect(await db.creditReservation.count({ where: { accountId: annual.account.id } })).toBe(1);
		expect(await getCreditInvariantReport(annual.account.id, db)).toMatchObject({
			valid: true,
			account: { spendable: 0n, reserved: 7n, debt: 0n },
		});
	});
	it("shared template concurrent retries create only one reservation and durable intent", async () => {
		const f = await sharedFixture();
		const results = await Promise.all(
			Array.from({ length: 8 }, () => createVideoTemplateJobRecord(f.input, db)),
		);
		expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
		expect(results.filter((result) => !result.replayed)).toHaveLength(1);
		expect(await db.creditReservation.count({ where: { account: { ownerId: f.ownerId } } })).toBe(
			1,
		);
		expect(
			await db.videoExecution.count({
				where: { jobId: results[0]!.jobId, stage: "QUEUED", startState: "PENDING" },
			}),
		).toBe(1);
	});
	it.each(
		newAnnualTiers.flatMap((tier) =>
			newAnnualProviders.flatMap((provider) =>
				(["hotel-lobby-duo", "raindance-solo", "raindance-duo"] as const).map((effectId) => ({
					...tier,
					provider,
					effectId,
				})),
			),
		),
	)(
		"shares $provider $planId annual credits with $effectId without a receipt-price gate",
		async (selection) => {
			const f = await fixture(0n, selection.effectId);
			const annual = await grantNewAnnualCredits(db, f.ownerId, selection);
			const retailPrice = {
				...f.base.price,
				credits: 69n,
				paidFundingPolicy: { minimumUsdMicrosPerCredit: 21_944n },
				pricingDetails: {},
			} satisfies VideoPrice & { paidFundingPolicy: { minimumUsdMicrosPerCredit: bigint } };
			const sharedPrice = applyVideoSharedFunding(retailPrice);
			expect(await getVideoTemplateCreditBalance(f.ownerId, undefined, db)).toEqual({
				totalCredits: selection.monthlyCredits.toString(),
				eligibleCredits: selection.monthlyCredits.toString(),
			});
			const quote = await createVideoTemplateQuoteRecord(
				{ ...f.base, price: sharedPrice, maximumInputBytes: 10000000 },
				db,
			);
			const input = {
				...f.input,
				quoteId: quote.quoteId,
				price: sharedPrice,
				paidFundingPolicy: undefined,
			};
			const accepted = await createVideoTemplateJobRecord(input, db);
			expect(await createVideoTemplateJobRecord(input, db)).toEqual({
				...accepted,
				replayed: true,
			});
			const reservation = await db.creditReservation.findUniqueOrThrow({
				where: { jobId: accepted.jobId },
				include: { allocations: { include: { lot: true } } },
			});
			expect(reservation.amount).toBe(69n);
			expect(reservation.allocations).toHaveLength(1);
			expect(reservation.allocations[0]).toMatchObject({
				amount: 69n,
				lot: {
					grantReferenceKey: annual.grantReferenceKey,
					remainingAmount: selection.monthlyCredits - 69n,
					reservedAmount: 69n,
				},
			});
			expect(
				await db.billingPeriod.count({ where: { subscriptionId: annual.subscription.id } }),
			).toBe(12);
			expect(
				await db.creditLedgerEntry.count({
					where: { accountId: annual.account.id, type: "RESERVE" },
				}),
			).toBe(1);
			const job = await db.generationJob.findUniqueOrThrow({ where: { id: accepted.jobId } });
			expect(job.pricingSnapshot).not.toHaveProperty("paidFundingPolicy");
			expect(job.pricingSnapshot).toMatchObject({
				pricingDetails: {
					paidRevenueQualified: false,
					funding: { mode: "shared-media-credits-v1" },
				},
			});
			await reviewInputs(accepted.jobId);
			const sceneClaim = { jobId: accepted.jobId, callbackTokenHash: randomUUID() };
			expect(await run(() => claimVideoTemplateSceneSubmission(sceneClaim))).toMatchObject({
				claimed: true,
			});
			expect(await run(() => claimVideoTemplateSceneSubmission(sceneClaim))).toMatchObject({
				claimed: false,
			});
		},
	);
	it.each([
		{ validUntil: "2000-01-01T00:00:00.000Z" },
		{ priceApprovalExpiryMode: "until", validUntil: "2000-01-01T00:00:00.000Z" },
		{ priceApprovalExpiryMode: "none", validUntil: null },
	])("claims a scene once without enforcing retired price metadata %j", async (pricingDetails) => {
		const f = await fixture(100n, "hotel-lobby-duo", 5, pricingDetails);
		const { jobId } = await createVideoTemplateJobRecord(f.input, db);
		await reviewInputs(jobId);
		const frozen = (await db.generationJob.findUniqueOrThrow({ where: { id: jobId } }))
			.pricingSnapshot;
		const input = { jobId, callbackTokenHash: randomUUID() };
		expect(await run(() => claimVideoTemplateSceneSubmission(input))).toMatchObject({
			claimed: true,
		});
		expect(await run(() => claimVideoTemplateSceneSubmission(input))).toMatchObject({
			claimed: false,
		});
		expect(
			(await db.generationJob.findUniqueOrThrow({ where: { id: jobId } })).pricingSnapshot,
		).toEqual(frozen);
		expect((await db.creditReservation.findUniqueOrThrow({ where: { jobId } })).status).toBe(
			"ACTIVE",
		);
		expect(await db.generationAttempt.count({ where: { jobId } })).toBe(0);
	});
	it.each(
		(["hotel-lobby-duo", "raindance-solo", "raindance-duo"] as const).flatMap((effectId) =>
			([5, 10] as const).flatMap((duration) =>
				[
					"media.model.nano-banana-2-lite-1k.enabled",
					"media.model.image-nano-banana-2-lite.enabled",
				].map((configKey) => ({ effectId, duration, configKey })),
			),
		),
	)(
		"Mini scene-emergency closure blocks $effectId $duration seconds before reservation: $configKey",
		async ({ effectId, duration, configKey }) => {
			// The quote predates closure. Final admission must recheck both scene gates
			// inside its transaction even after an earlier asynchronous readiness check.
			const f = await fixture(100n, effectId, duration);
			expect(f.input.template.schemaVersion).toBe(4);
			const versions = await db.runtimeConfigOverride.aggregate({ _max: { version: true } });
			const flag = await db.runtimeConfigOverride.create({
				data: {
					configKey,
					version: (versions._max.version ?? 0) + 1,
					value: false,
					reason: f.ownerId,
					createdByUserId: f.ownerId,
				},
			});
			try {
				await expect(createVideoTemplateJobRecord(f.input, db)).rejects.toThrow("VIDEO_DISABLED");
				expect(await db.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
				const account = await db.creditAccount.findUniqueOrThrow({
					where: { ownerType_ownerId: { ownerType: "USER", ownerId: f.ownerId } },
				});
				expect(account).toMatchObject({ spendableCredits: 100n, reservedCredits: 0n });
				expect(await db.creditReservation.count({ where: { accountId: account.id } })).toBe(0);
			} finally {
				await db.runtimeConfigOverride.delete({ where: { id: flag.id } });
			}
		},
	);
	it("binds duration to the quote and replays an accepted ten-second order without another reservation", async () => {
		const f = await fixture(100n, "hotel-lobby-duo", 10);
		await expect(
			createVideoTemplateJobRecord(
				{ ...f.input, request: { ...f.input.request, duration: undefined } },
				db,
			),
		).rejects.toThrow("VIDEO_TEMPLATE_QUOTE_INPUT_MISMATCH");
		const accepted = await createVideoTemplateJobRecord(f.input, db);
		const replay = await findExistingVideoTemplateAdmission(
			{ ownerId: f.ownerId, request: f.input.request, idempotencyKey: f.input.idempotencyKey },
			db,
		);
		expect(replay?.id).toBe(accepted.jobId);
		await expect(
			findExistingVideoTemplateAdmission(
				{
					ownerId: f.ownerId,
					request: { ...f.input.request, duration: undefined },
					idempotencyKey: f.input.idempotencyKey,
				},
				db,
			),
		).rejects.toThrow();
		const job = await db.generationJob.findUniqueOrThrow({ where: { id: accepted.jobId } });
		expect(object(job.inputSnapshot).duration).toBe(10);
		expect(object(object(job.inputSnapshot).videoEffectTemplate).schemaVersion).toBe(4);
		expect(await db.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(1);
	});
	it.each([
		{ name: "missing effect", snapshot: {} },
		{ name: "null effect", snapshot: { effectId: null } },
		{ name: "unknown effect", snapshot: { effectId: "unapproved-template" } },
		{ name: "non-object snapshot", snapshot: [] },
		{ name: "reversed roles", roles: [{ role: "right" }, { role: "left" }] },
		{ name: "missing role", roles: [{ role: "left" }] },
		{ name: "unknown state", state: "UNAPPROVED" },
		{ name: "provider task without submission", providerTaskId: "unsubmitted-task" },
		{ name: "resolved identity without stored scene", resolvedIdentity: { assetId: "missing" } },
	])("installed template CHECK rejects $name", async (input) => {
		// Copy the installed CHECK into a disposable table to test it independently
		// of the parent-identity trigger without disabling any production guard.
		await expect(
			db.$transaction(async (tx) => {
				await tx.$executeRaw`CREATE TEMP TABLE template_shape_regression
					(LIKE video_template_execution INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
					ON COMMIT DROP`;
				await tx.$executeRaw`INSERT INTO template_shape_regression
					("jobId", "templateSnapshot", "orderedRoleIdentities", "sceneState",
					 "sceneProviderTaskId", "resolvedInputIdentity", "updatedAt")
					VALUES (${randomUUID()},
					 ${JSON.stringify(input.snapshot ?? { effectId: "raindance-solo" })}::jsonb,
					 ${JSON.stringify(input.roles ?? [{ role: "left" }, { role: "right" }])}::jsonb,
					 ${input.state ?? "PENDING"}, ${input.providerTaskId ?? null},
					 ${input.resolvedIdentity ? JSON.stringify(input.resolvedIdentity) : null}::jsonb,
					 NOW())`;
			}),
		).rejects.toThrow(/video_template_shape_check/);
	});
	it.each(["raindance-solo", "raindance-duo"] as const)(
		"persists %s identities with one idempotent reservation and no Outbox",
		async (effectId) => {
			const f = await fixture(100n, effectId);
			const first = await createVideoTemplateJobRecord(f.input, db);
			expect(await createVideoTemplateJobRecord(f.input, db)).toEqual({
				jobId: first.jobId,
				replayed: true,
			});
			const execution = await run(() => getVideoTemplateExecution(first.jobId));
			expect(object(execution!.templateSnapshot).effectId).toBe(effectId);
			const identities = execution!.orderedRoleIdentities as Prisma.JsonArray;
			expect(identities.map((identity) => object(identity).assetId)).toEqual([
				f.base.request.inputs.leftAssetId,
				f.base.request.inputs.rightAssetId,
			]);
			expect(await db.creditReservation.count({ where: { jobId: first.jobId } })).toBe(1);
			expect(await db.outboxEvent.count({ where: { aggregateId: first.jobId } })).toBe(0);
			await storedScene(first.jobId);
		},
	);
	it("20 concurrent retries create one commercial job, reservation, workflow and two capacity rows", async () => {
		const f = await fixture();
		const results = await Promise.all(
			Array.from({ length: 20 }, () => createVideoTemplateJobRecord(f.input, db)),
		);
		expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
		expect(results.filter((r) => !r.replayed)).toHaveLength(1);
		expect(
			await createVideoTemplateJobRecord(
				{
					...f.input,
					template: videoEffectTemplateSnapshotSchema.parse({
						...f.input.template,
						video: { ...f.input.template.video, prompt: "A new server prompt for new orders" },
					}),
					price: { ...f.input.price, credits: 99n },
				},
				db,
			),
		).toEqual({ jobId: results[0]!.jobId, replayed: true });
		expect(
			await db.auditLog.count({ where: { id: `video-effect:${results[0]!.jobId}:accepted` } }),
		).toBe(1);
		const jobId = results[0]!.jobId;
		expect(await db.creditReservation.count({ where: { jobId } })).toBe(1);
		expect(await db.generationJob.count({ where: { quoteId: f.quote.quoteId } })).toBe(1);
		expect(await db.videoExecution.count({ where: { jobId } })).toBe(1);
		const capacity = await db.storageUsageReservation.findMany({
			where: { ownerId: f.ownerId, status: "ACTIVE" },
		});
		expect(capacity).toHaveLength(2);
		expect(capacity.reduce((s, r) => s + r.bytes, 0n)).toBe(124857600n);
		await expect(
			createVideoTemplateJobRecord({ ...f.input, idempotencyKey: randomUUID() }, db),
		).rejects.toThrow("VIDEO_QUOTE_ALREADY_USED");
		expect(
			(
				await findExistingVideoTemplateAdmission(
					{ ownerId: f.ownerId, idempotencyKey: f.input.idempotencyKey, request: f.base.request },
					db,
				)
			)?.id,
		).toBe(jobId);
	});
	it("freezes both ordered identities and rejects role swap, foreign input, insufficient balance and cross-kind replay", async () => {
		const f = await fixture();
		const flipped = {
			...f.base.request,
			inputs: { leftAssetId: f.assets[1]!.id, rightAssetId: f.assets[0]!.id },
		};
		await expect(
			createVideoTemplateJobRecord({ ...f.input, request: flipped }, db),
		).rejects.toThrow();
		const swapped = await createVideoTemplateQuoteRecord(
			{ ...f.base, request: flipped, maximumInputBytes: 10000000 },
			db,
		);
		expect(swapped.requestFingerprint).not.toBe(f.quote.requestFingerprint);
		const sameLeft = {
			...f.base.request,
			inputs: { leftAssetId: f.assets[0]!.id, rightAssetId: f.assets[0]!.id },
		};
		expect(
			(
				await createVideoTemplateQuoteRecord(
					{ ...f.base, request: sameLeft, maximumInputBytes: 10000000 },
					db,
				)
			).requestFingerprint,
		).not.toBe(f.quote.requestFingerprint);
		const foreign = await fixture();
		await expect(
			createVideoTemplateQuoteRecord(
				{
					...f.base,
					request: {
						...f.base.request,
						inputs: { ...f.base.request.inputs, rightAssetId: foreign.assets[1]!.id },
					},
					maximumInputBytes: 10000000,
				},
				db,
			),
		).rejects.toThrow("VIDEO_INPUT_NOT_AVAILABLE");
		const ordinary = {
			productKey: f.base.template.video.productKey,
			mode: "image-to-video" as const,
			prompt: f.base.template.video.prompt,
			duration: 5 as const,
			resolution: "720p" as const,
			aspectRatio: "9:16" as const,
			sound: false as const,
			inputAssetId: f.assets[0]!.id,
		};
		const { template: _, ...plain } = f.input;
		await expect(createVideoJobRecord({ ...plain, request: ordinary }, db)).rejects.toThrow(
			"INVALID_VIDEO_QUOTE_KIND",
		);
		const ordinaryQuote = await createVideoQuoteRecord(
			{ ...f.base, template: undefined, request: ordinary, maximumInputBytes: 10000000 },
			db,
		);
		await expect(
			createVideoTemplateJobRecord({ ...f.input, quoteId: ordinaryQuote.quoteId }, db),
		).rejects.toThrow("VIDEO_TEMPLATE_QUOTE_INPUT_MISMATCH");
		const poor = await fixture(1n);
		await expect(createVideoTemplateJobRecord(poor.input, db)).rejects.toThrow();
		expect(await db.generationJob.count({ where: { ownerId: poor.ownerId } })).toBe(0);
		expect(await db.storageUsageReservation.count({ where: { ownerId: poor.ownerId } })).toBe(0);
	});
	it("keeps full capacity and credits through uncertain first paid scene with zero final attempts", async () => {
		const f = await accepted();
		await reviewInputs(f.jobId);
		const claims = await Promise.all(
			Array.from({ length: 5 }, () =>
				run(() =>
					claimVideoTemplateSceneSubmission({ jobId: f.jobId, callbackTokenHash: randomUUID() }),
				),
			),
		);
		expect(
			claims.filter((claim) => {
				if ("deferred" in claim) throw new Error("Unexpected provider capacity wait");
				return claim.claimed;
			}),
		).toHaveLength(1);
		expect(await db.generationAttempt.count({ where: { jobId: f.jobId } })).toBe(0);
		expect(await run(() => failVideoExecution(f.jobId, "TEST_TIMEOUT"))).toBe(false);
		expect(await run(() => failVideoExecution(f.jobId, "TEST_TIMEOUT", false, true))).toBe(false);
		await expect(run(() => failVideoDelivery(f.jobId, "TEST_TIMEOUT"))).rejects.toThrow(
			"VIDEO_UNCERTAIN_RESERVATION_MUST_REMAIN",
		);
		expect((await db.creditReservation.findUnique({ where: { jobId: f.jobId } }))?.status).toBe(
			"ACTIVE",
		);
		expect(
			await db.storageUsageReservation.count({ where: { ownerId: f.ownerId, status: "ACTIVE" } }),
		).toBe(2);
		for (const asset of f.assets) {
			await db.mediaAsset.update({ where: { id: asset.id }, data: { deleteAfter: new Date(0) } });
			expect(await claimVideoResourceCleanup(asset.id, new Date(), db)).toBeNull();
		}
	});
	it("binds early scene callbacks exactly once and rejects role/task confusion", async () => {
		const f = await accepted();
		await reviewInputs(f.jobId);
		const token = randomUUID();
		await run(() =>
			claimVideoTemplateSceneSubmission({ jobId: f.jobId, callbackTokenHash: token }),
		);
		const payload = {
			callbackTokenHash: token,
			taskId: randomUUID(),
			timestamp: "test1",
			receivedAt: new Date(),
		};
		const first = await run(() => persistVideoTemplateSceneWebhook(payload));
		const second = await run(() => persistVideoTemplateSceneWebhook(payload));
		expect(second.eventId).toBe(first.eventId);
		expect(second.replayed).toBe(true);
		await expect(
			run(() => persistVideoTemplateSceneWebhook({ ...payload, taskId: randomUUID() })),
		).rejects.toThrow("VIDEO_TEMPLATE_SCENE_TASK_CONFLICT");
		await expect(
			run(() => persistVideoTemplateSceneWebhook({ ...payload, callbackTokenHash: randomUUID() })),
		).rejects.toThrow("VIDEO_TEMPLATE_CALLBACK_INVALID");
		expect(
			await run(() =>
				claimVideoTemplateSceneSubmission({ jobId: f.jobId, callbackTokenHash: randomUUID() }),
			),
		).toMatchObject({ claimed: false });
	});
	it("seals derived content once without rewriting parent or creating a final OUTPUT/attempt", async () => {
		const f = await accepted();
		const before = (await db.generationJob.findUniqueOrThrow({ where: { id: f.jobId } }))
			.inputSnapshot;
		const asset = await storedScene(f.jobId);
		const one = await run(() => sealVideoTemplateResolvedInput(f.jobId));
		const two = await run(() => sealVideoTemplateResolvedInput(f.jobId));
		expect(two).toEqual(one);
		expect(
			(await db.generationJob.findUniqueOrThrow({ where: { id: f.jobId } })).inputSnapshot,
		).toEqual(before);
		expect(await db.generationAttempt.count({ where: { jobId: f.jobId } })).toBe(0);
		expect(await db.generationJobAsset.count({ where: { jobId: f.jobId, role: "OUTPUT" } })).toBe(
			0,
		);
		await expect(
			db.generationJob.update({
				where: { id: f.jobId },
				data: { inputSnapshot: { changed: true } },
			}),
		).rejects.toThrow(/immutable/);
		await expect(
			db.videoTemplateExecution.update({
				where: { jobId: f.jobId },
				data: { resolvedInputIdentity: { assetId: "different" } },
			}),
		).rejects.toThrow(/immutable/);
		await expect(
			db.videoTemplateExecution.update({
				where: { jobId: f.jobId },
				data: { templateSnapshot: { changed: true } },
			}),
		).rejects.toThrow();
		await expect(
			db.generationJobAsset.create({
				data: { jobId: f.jobId, assetId: asset.id, role: "OUTPUT", assetChecksum: "a".repeat(64) },
			}),
		).rejects.toThrow(/OUTPUT/);
		await expect(
			db.mediaAsset.update({
				where: { id: asset.id },
				data: { status: "VERIFYING", verificationGeneration: 2 },
			}),
		).rejects.toThrow(/immutable/);
	});
	it("retains physical scene capacity after terminal failure until explicit successful cleanup", async () => {
		const f = await accepted();
		const asset = await storedScene(f.jobId);
		await run(() => sealVideoTemplateResolvedInput(f.jobId));
		await db.mediaAsset.update({ where: { id: asset.id }, data: { deleteAfter: new Date(0) } });
		expect(await claimVideoResourceCleanup(asset.id, new Date(), db)).toBeNull();
		const candidates = await listVideoResourceCleanupCandidates(
			{ limit: 100, now: new Date() },
			db,
		);
		expect(candidates.some((a) => a.id === asset.id)).toBe(false);
		await run(() => failVideoDelivery(f.jobId, "TEST_FINAL_FAILED"));
		expect(
			(
				await db.storageUsageReservation.findUnique({
					where: { referenceKey: `video-template-scene:${f.jobId}` },
				})
			)?.status,
		).toBe("ACTIVE");
		const claim = await claimVideoResourceCleanup(asset.id, new Date(), db);
		expect(claim).not.toBeNull();
		expect(claim!.objectKeys).toContain(asset.objectKey);
		expect(claim!.objectKeys).toContain(asset.outputStagingObjectKey);
		expect(
			(
				await db.storageUsageReservation.findUnique({
					where: { referenceKey: `video-template-scene:${f.jobId}` },
				})
			)?.status,
		).toBe("ACTIVE");
		await completeVideoResourceCleanup(claim!, new Date(), db);
		await completeVideoResourceCleanup(claim!, new Date(), db);
		expect(
			(
				await db.storageUsageReservation.findUnique({
					where: { referenceKey: `video-template-scene:${f.jobId}` },
				})
			)?.status,
		).toBe("RELEASED");
	});
	it("reserves scene plus final before accepting and rolls back insufficient storage", async () => {
		const f = await fixture();
		await expect(
			createVideoTemplateJobRecord(
				{ ...f.input, limits: { ...f.input.limits, maximumStorageBytes: 124857599n } },
				db,
			),
		).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
		expect(await db.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await db.creditReservation.count({ where: { account: { ownerId: f.ownerId } } })).toBe(
			0,
		);
	});
});

it("honors explicit scene retention after terminal state even when older than orphan age", async () => {
	const f = await accepted();
	const asset = await storedScene(f.jobId);
	await run(() => sealVideoTemplateResolvedInput(f.jobId));
	await run(() => failVideoDelivery(f.jobId, "TEST_TERMINAL"));
	await db.mediaAsset.update({
		where: { id: asset.id },
		data: {
			createdAt: new Date(Date.now() - 172800000),
			deleteAfter: new Date(Date.now() + 28 * 86400000),
		},
	});
	expect(await claimVideoResourceCleanup(asset.id, new Date(), db)).toBeNull();
	expect(
		(await listVideoResourceCleanupCandidates({ limit: 100, now: new Date() }, db)).some(
			(a) => a.id === asset.id,
		),
	).toBe(false);
});
it("expired frozen scene review prevents final paid submit without replacing evidence", async () => {
	const f = await accepted();
	await storedScene(f.jobId);
	await run(() => sealVideoTemplateResolvedInput(f.jobId));
	const frozen = (await run(() => getVideoTemplateExecution(f.jobId)))!.resolvedInputIdentity;
	const now = Date.now();
	const spy = vi.spyOn(Date, "now").mockReturnValue(now + 7200000);
	try {
		await expect(
			run(() =>
				claimVideoProviderSubmission({
					jobId: f.jobId,
					callbackTokenHash: randomUUID(),
					providerModelId: "seedance-test",
					ruleVersion: "test",
				}),
			),
		).rejects.toThrow("VIDEO_TEMPLATE_SCENE_REVIEW_EXPIRED");
	} finally {
		spy.mockRestore();
	}
	expect(await db.generationAttempt.count({ where: { jobId: f.jobId } })).toBe(0);
	expect((await run(() => getVideoTemplateExecution(f.jobId)))!.resolvedInputIdentity).toEqual(
		frozen,
	);
	expect(
		await run(() =>
			failVideoExecution(f.jobId, "VIDEO_PRICE_EXPIRED", false, false, {
				onlyBeforeSubmission: true,
			}),
		),
	).toBe(true);
	expect((await db.creditReservation.findUnique({ where: { jobId: f.jobId } }))?.status).toBe(
		"RELEASED",
	);
	expect(
		(
			await db.storageUsageReservation.findUnique({
				where: { referenceKey: `video-template-scene:${f.jobId}` },
			})
		)?.status,
	).toBe("ACTIVE");
});
it("recovers canonical template upload source cleanup after browser disappeared", async () => {
	const f = await accepted();
	const asset = f.assets[0]!;
	const session = await db.mediaUploadSession.create({
		data: {
			assetId: asset.id,
			tokenHash: randomUUID(),
			status: "COMPLETED",
			expectedBytes: 1000n,
			expiresAt: new Date(Date.now() + 3600000),
			completedAt: new Date(Date.now() - 700000),
		},
	});
	await db.storageUsageReservation.create({
		data: {
			ownerType: "USER",
			ownerId: f.ownerId,
			referenceKey: `media-upload:${session.id}`,
			status: "COMMITTED",
			bytes: 2000n,
			expiresAt: new Date(Date.now() + 3600000),
		},
	});
	const rows = await listVideoStagingCleanup({ limit: 100, now: new Date() }, db);
	const row = rows.find((r) => r.sessionId === session.id);
	expect(row?.sourceKey).toBe(asset.objectKey.slice(0, -".template-input.png".length));
	expect(
		(
			await db.storageUsageReservation.findUnique({
				where: { referenceKey: `media-upload:${session.id}` },
			})
		)?.bytes,
	).toBe(2000n);
	await completeVideoStagingCleanup(
		{ sessionId: session.id, stagingKey: null, sourceKey: row!.sourceKey },
		db,
	);
	expect(
		(
			await db.storageUsageReservation.findUnique({
				where: { referenceKey: `media-upload:${session.id}` },
			})
		)?.bytes,
	).toBe(1000n);
});
it("leases scene writes before transfer so terminal cleanup cannot race an in-flight object", async () => {
	const f = await accepted();
	await reviewInputs(f.jobId);
	await run(() =>
		claimVideoTemplateSceneSubmission({ jobId: f.jobId, callbackTokenHash: randomUUID() }),
	);
	const taskId = randomUUID();
	await run(() => recordVideoTemplateSceneAccepted(f.jobId, taskId));
	await run(() =>
		recordVideoTemplateSceneProviderResult({
			jobId: f.jobId,
			taskId,
			evidence: { status: "SUCCEEDED", outputUrl: "https://fixture.invalid/scene.png" },
		}),
	);
	const asset = await run(() => prepareVideoTemplateSceneAsset(f.jobId));
	expect(asset.outputTransferToken).toBeTruthy();
	expect(asset.objectKey.startsWith(`users/${f.ownerId}/`)).toBe(true);
	await expect(run(() => prepareVideoTemplateSceneAsset(f.jobId))).rejects.toThrow(
		"VIDEO_TEMPLATE_SCENE_TRANSFER_BUSY",
	);
	await run(() => failVideoDelivery(f.jobId, "TEST_TRANSFER_FAILED"));
	await db.mediaAsset.update({ where: { id: asset.id }, data: { deleteAfter: new Date(0) } });
	expect(await claimVideoResourceCleanup(asset.id, new Date(), db)).toBeNull();
	await db.mediaAsset.update({
		where: { id: asset.id },
		data: { outputTransferLeaseExpiresAt: new Date(0) },
	});
	expect(await claimVideoResourceCleanup(asset.id, new Date(), db)).not.toBeNull();
	expect(
		(
			await db.storageUsageReservation.findUnique({
				where: { referenceKey: `video-template-scene:${f.jobId}` },
			})
		)?.status,
	).toBe("ACTIVE");
});

it.each(["left", "right"] as const)(
	"rejects expired %s role at quote and admission before any paid scene",
	async (role) => {
		const f = await fixture();
		const asset = f.assets[role === "left" ? 0 : 1]!;
		await db.mediaAsset.update({ where: { id: asset.id }, data: { deleteAfter: new Date(0) } });
		await expect(
			createVideoTemplateQuoteRecord({ ...f.base, maximumInputBytes: 10000000 }, db),
		).rejects.toThrow("VIDEO_INPUT_NOT_AVAILABLE");
		await expect(createVideoTemplateJobRecord(f.input, db)).rejects.toThrow(
			"VIDEO_INPUT_NOT_AVAILABLE",
		);
		expect(await db.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await db.storageUsageReservation.count({ where: { ownerId: f.ownerId } })).toBe(0);
	},
);
it.each(["left", "right"] as const)(
	"rejects changed %s role after quote and again at the first paid fence",
	async (role) => {
		const f = await fixture();
		const asset = f.assets[role === "left" ? 0 : 1]!;
		await db.mediaAsset.update({ where: { id: asset.id }, data: { checksum: "c".repeat(64) } });
		await expect(createVideoTemplateJobRecord(f.input, db)).rejects.toThrow(
			"ASSET_CONTENT_CHANGED",
		);
		expect(await db.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		const acceptedJob = await accepted();
		await reviewInputs(acceptedJob.jobId);
		const original = acceptedJob.assets[role === "left" ? 0 : 1]!;
		await db.mediaAsset.update({ where: { id: original.id }, data: { checksum: "d".repeat(64) } });
		await expect(
			run(() =>
				claimVideoTemplateSceneSubmission({
					jobId: acceptedJob.jobId,
					callbackTokenHash: randomUUID(),
				}),
			),
		).rejects.toThrow("VIDEO_INPUT_IDENTITY_CHANGED");
		expect((await run(() => getVideoTemplateExecution(acceptedJob.jobId)))?.submittedAt).toBeNull();
		expect(await db.generationAttempt.count({ where: { jobId: acceptedJob.jobId } })).toBe(0);
	},
);
it.each(["left", "right"] as const)(
	"a %s input moderation rejection blocks the scene fence and releases exactly once",
	async (role) => {
		const f = await accepted();
		await reviewInputs(f.jobId);
		await run(() =>
			recordVideoTemplateImageReview(f.jobId, role, {
				decision: { decision: "REJECT", reasonCode: "TEST_INPUT_REJECT" },
			}),
		);
		await expect(
			run(() =>
				claimVideoTemplateSceneSubmission({ jobId: f.jobId, callbackTokenHash: randomUUID() }),
			),
		).rejects.toThrow("VIDEO_TEMPLATE_INPUT_REVIEW_REQUIRED");
		await run(() => failVideoDelivery(f.jobId, "TEST_INPUT_REJECT", true));
		await run(() => failVideoDelivery(f.jobId, "TEST_INPUT_REJECT", true));
		const reservation = await db.creditReservation.findUniqueOrThrow({ where: { jobId: f.jobId } });
		expect(reservation.status).toBe("RELEASED");
		expect(
			await db.creditLedgerEntry.count({
				where: { reservationId: reservation.id, type: "RELEASE" },
			}),
		).toBe(1);
		expect((await run(() => getVideoTemplateExecution(f.jobId)))?.submittedAt).toBeNull();
		expect(await db.generationAttempt.count({ where: { jobId: f.jobId } })).toBe(0);
	},
);
it("scene moderation rejection cannot seal or submit video and preserves physical capacity until cleanup", async () => {
	const f = await accepted();
	await storedScene(f.jobId);
	await run(() =>
		recordVideoTemplateImageReview(f.jobId, "scene", {
			decision: { decision: "REJECT", reasonCode: "TEST_SCENE_REJECT" },
		}),
	);
	await expect(run(() => sealVideoTemplateResolvedInput(f.jobId))).rejects.toThrow(
		"VIDEO_TEMPLATE_SCENE_REVIEW_REQUIRED",
	);
	await expect(
		run(() =>
			claimVideoProviderSubmission({
				jobId: f.jobId,
				callbackTokenHash: randomUUID(),
				providerModelId: "test-video",
				ruleVersion: "test",
			}),
		),
	).rejects.toThrow("VIDEO_TEMPLATE_SCENE_NOT_READY");
	await run(() => markVideoTemplateSceneFailed(f.jobId, "TEST_SCENE_REJECT"));
	await run(() => failVideoDelivery(f.jobId, "TEST_SCENE_REJECT", true));
	await run(() => failVideoDelivery(f.jobId, "TEST_SCENE_REJECT", true));
	const reservation = await db.creditReservation.findUniqueOrThrow({ where: { jobId: f.jobId } });
	expect(
		await db.creditLedgerEntry.count({ where: { reservationId: reservation.id, type: "RELEASE" } }),
	).toBe(1);
	expect(await db.generationAttempt.count({ where: { jobId: f.jobId } })).toBe(0);
	expect((await run(() => getVideoTemplateExecution(f.jobId)))?.resolvedInputIdentity).toBeNull();
	expect(
		(
			await db.storageUsageReservation.findUnique({
				where: { referenceKey: `video-template-scene:${f.jobId}` },
			})
		)?.status,
	).toBe("ACTIVE");
});
it("a concurrent ordinary image upload cannot steal the accepted template combined capacity", async () => {
	const f = await fixture();
	const id = randomUUID();
	const ceiling = 124857600n;
	const upload = () =>
		createMediaUploadSessionTransaction(
			{
				ownerType: "USER",
				ownerId: f.ownerId,
				assetId: `image-race-${id}`,
				sessionId: id,
				kind: "INPUT",
				objectKey: `users/${f.ownerId}/ordinary/${id}.png`,
				stagingObjectKey: `users/${f.ownerId}/staging/${id}.png`,
				mimeType: "image/png",
				expectedBytes: 1n,
				tokenHash: id,
				multipartUploadId: null,
				expiresAt: new Date(Date.now() + 60000),
				limits: { maximumActiveSessions: 5, maximumReservedBytes: ceiling },
			},
			db,
		);
	const results = await Promise.allSettled([
		createVideoTemplateJobRecord(
			{ ...f.input, limits: { ...f.input.limits, maximumStorageBytes: ceiling } },
			db,
		),
		upload(),
	]);
	expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	expect(
		(results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message,
	).toBe("STORAGE_QUOTA_EXCEEDED");
	const bytes = await db.storageUsageReservation.aggregate({
		where: { ownerId: f.ownerId, status: { in: ["ACTIVE", "COMMITTED"] } },
		_sum: { bytes: true },
	});
	expect(bytes._sum.bytes! <= ceiling).toBe(true);
	if (results[0]!.status === "fulfilled") {
		expect(bytes._sum.bytes).toBe(ceiling);
		expect(
			await db.storageUsageReservation.count({ where: { ownerId: f.ownerId, status: "ACTIVE" } }),
		).toBe(2);
	} else {
		expect(await db.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await db.creditReservation.count({ where: { account: { ownerId: f.ownerId } } })).toBe(
			0,
		);
	}
});
it("manual-review scene and both original roles remain protected after retention expiry", async () => {
	const f = await accepted();
	const scene = await storedScene(f.jobId);
	await run(() => markVideoTemplateNeedsReview(f.jobId, "VIDEO_TEMPLATE_SCENE_REVIEW_UNCERTAIN"));
	await run(() => markVideoTemplateNeedsReview(f.jobId, "VIDEO_TEMPLATE_SCENE_REVIEW_UNCERTAIN"));
	for (const asset of [...f.assets, scene]) {
		await db.mediaAsset.update({ where: { id: asset.id }, data: { deleteAfter: new Date(0) } });
		expect(await claimVideoResourceCleanup(asset.id, new Date(), db)).toBeNull();
	}
	const candidates = await listVideoResourceCleanupCandidates({ limit: 100, now: new Date() }, db);
	expect(candidates.some((row) => row.id === scene.id)).toBe(false);
	expect((await db.creditReservation.findUnique({ where: { jobId: f.jobId } }))?.status).toBe(
		"ACTIVE",
	);
	expect(
		await db.storageUsageReservation.count({ where: { ownerId: f.ownerId, status: "ACTIVE" } }),
	).toBe(2);
	expect(await db.auditLog.count({ where: { id: `video-effect:${f.jobId}:held` } })).toBe(1);
});

it("keeps scene callbacks in bounded live recovery without any final-video attempt", async () => {
	const f = await accepted();
	await reviewInputs(f.jobId);
	const token = randomUUID();
	await run(() => claimVideoTemplateSceneSubmission({ jobId: f.jobId, callbackTokenHash: token }));
	const now = new Date();
	const event = await run(() =>
		persistVideoTemplateSceneWebhook({
			callbackTokenHash: token,
			taskId: randomUUID(),
			timestamp: "pending-scene",
			receivedAt: now,
		}),
	);
	expect(await db.generationAttempt.count({ where: { jobId: f.jobId } })).toBe(0);
	const rows = await run(() => listPendingVideoWebhookEvents(100, now));
	expect(rows).toContainEqual({
		eventId: event.eventId,
		jobId: f.jobId,
		workflowInstanceId: `video-v1-${f.jobId}`,
	});
	expect((await run(() => listPendingVideoWebhookEvents(1, now))).length).toBeLessThanOrEqual(1);
	await run(() => postponeVideoWebhookNotification(event.eventId, now));
	expect(
		(await run(() => listPendingVideoWebhookEvents(100, now))).some(
			(row) => row.eventId === event.eventId,
		),
	).toBe(false);
	expect(
		(await run(() => listPendingVideoWebhookEvents(100, new Date(now.getTime() + 120001)))).some(
			(row) => row.eventId === event.eventId,
		),
	).toBe(true);
	await run(() => markVideoWebhookNotified(event.eventId));
	expect(
		(await run(() => listPendingVideoWebhookEvents(100, new Date(now.getTime() + 120001)))).some(
			(row) => row.eventId === event.eventId,
		),
	).toBe(false);
	expect(
		(await db.providerWebhookEvent.findUniqueOrThrow({ where: { id: event.eventId } })).status,
	).toBe("RECEIVED");
});
it("preserves manual and unconfirmed terminal scene inbox evidence without blocking live recovery", async () => {
	for (const stage of ["NEEDS_REVIEW", "FAILED"] as const) {
		const f = await accepted();
		await reviewInputs(f.jobId);
		const token = randomUUID();
		await run(() =>
			claimVideoTemplateSceneSubmission({ jobId: f.jobId, callbackTokenHash: token }),
		);
		const event = await run(() =>
			persistVideoTemplateSceneWebhook({
				callbackTokenHash: token,
				taskId: randomUUID(),
				timestamp: stage,
				receivedAt: new Date(),
			}),
		);
		await db.videoExecution.update({ where: { jobId: f.jobId }, data: { stage } });
		const before = await db.providerWebhookEvent.findUniqueOrThrow({
			where: { id: event.eventId },
		});
		expect(
			(await run(() => listPendingVideoWebhookEvents(100))).some(
				(row) => row.eventId === event.eventId,
			),
		).toBe(false);
		expect(
			await db.providerWebhookEvent.findUniqueOrThrow({ where: { id: event.eventId } }),
		).toEqual(before);
	}
});
it("scene recovery rejects mismatched provider task job workflow and unverified envelopes", async () => {
	const f = await accepted();
	await reviewInputs(f.jobId);
	const token = randomUUID();
	const taskId = randomUUID();
	await run(() => claimVideoTemplateSceneSubmission({ jobId: f.jobId, callbackTokenHash: token }));
	const original = await run(() =>
		persistVideoTemplateSceneWebhook({
			callbackTokenHash: token,
			taskId,
			timestamp: "identity",
			receivedAt: new Date(),
		}),
	);
	await run(() => markVideoWebhookNotified(original.eventId));
	await expect(
		db.$executeRaw`UPDATE "provider_webhook_event" SET "verifiedAt"=NULL WHERE "id"=${original.eventId}`,
	).rejects.toThrow(/null/i);
	const variants = [
		{ provider: "kie-video-v1" },
		{ providerTaskId: "foreign-task" },
		{ envelope: { jobId: "foreign-job" } },
		{ envelope: { taskId: "foreign-task" } },
		{ envelope: { workflowInstanceId: "video-v1-foreign" } },
	];
	const ids: string[] = [];
	try {
		for (const variant of variants) {
			const row = await db.providerWebhookEvent.create({
				data: {
					provider: "kie-video-template-scene",
					providerEventId: randomUUID(),
					providerTaskId: taskId,
					verifiedAt: new Date(),
					...variant,
					envelope: {
						jobId: f.jobId,
						taskId,
						workflowInstanceId: `video-v1-${f.jobId}`,
						notifiedAt: null,
						...variant.envelope,
					},
				},
			});
			ids.push(row.id);
		}
		const pending = await run(() => listPendingVideoWebhookEvents(100));
		for (const id of ids) {
			expect(pending.some((row) => row.eventId === id)).toBe(false);
			expect((await db.providerWebhookEvent.findUniqueOrThrow({ where: { id } })).status).toBe(
				"RECEIVED",
			);
		}
	} finally {
		// Deliberately invalid inbox rows must not leak into the later full-database audit.
		await db.providerWebhookEvent.deleteMany({ where: { id: { in: ids } } });
	}
});
