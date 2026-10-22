import { PrismaPg } from "@prisma/adapter-pg";
import { applyVideoInternalFunding } from "@repo/config/video-internal-funding";
import {
	VIDEO_MODEL_CATALOG,
	VIDEO_MODEL_CATALOG_VERSION,
	isVideoModelRetired,
	type VideoModelSelection,
} from "@repo/config/video-models";
import { createVideoAudioSafetyPolicy, VIDEO_OUTPUT_MAX_BYTES } from "@repo/config/video-output";
import {
	resolveVideoModelPrice,
	VIDEO_RETAIL_PRICE_VERSION,
	VIDEO_SUPPLIER_PRICE_VERSION,
} from "@repo/config/video-pricing.server";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { applyVideoSharedFunding } from "@repo/config/video-shared-funding";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import approvedVideoRetail from "../../../../config/fixtures/video-retail-approved-2026-10-08.json";
import { providerCapacityForTestRequests } from "../../../test-support/provider-dispatch-capacity";
import { runWithDatabaseClient } from "../../client";
import { PrismaClient, type Prisma } from "../../generated/client";
import { createMediaUploadSessionTransaction } from "./assets";
import {
	createCreditGrant,
	getCreditInvariantReport,
	refundCreditGrant,
	releaseCredits,
	reserveCreditsInTransaction,
	settleCredits,
} from "./credits";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";
import { withStorageSubscription } from "./testing/subscriber-storage-fixture";
import { resolveVideoRetailEligibility } from "./video-retail-eligibility";
import { getVideoTemplateCreditBalance } from "./video-template-credits";
import {
	createVideoJobRecord,
	createVideoQuoteRecord,
	getVideoJobRecord,
	listVideoJobRecords,
	fingerprintVideoRequest,
	findExistingVideoSubmission,
	submitVideoJobRecord,
	videoSubmissionIdentity,
	type VideoPrice,
} from "./video-v1";
import { claimVideoProviderSubmission, recordVideoInputReview } from "./video-v1-execution";

const request = {
	mode: "text-to-video" as const,
	prompt: "A sailboat moves slowly across a blue lake",
	duration: 5 as const,
	sound: false as const,
	aspectRatio: "16:9" as const,
};
const price = {
	credits: 7n,
	pricingVersion: "TEST_ONLY_VIDEO_V1",
	providerCostMicros: 2n,
	moderationCostMicros: 1n,
	pricingBasis: "ISOLATED_TEST_NOT_A_FORMAL_PRICE",
};
const visualSafetyProfile = createVideoVisualSafetyProfile("seeapi", request.duration);
const limits = {
	ownerConcurrency: 1,
	globalConcurrency: 5,
	providerConcurrency: 5,
	maximumStorageBytes: 1_000_000_000n,
	maximumInputBytes: 10_000_000,
};
const modelModeSelections = VIDEO_MODEL_CATALOG.filter(
	(model) => model.status === "implemented" && !isVideoModelRetired(model.productKey),
).flatMap((model) =>
	model.modes.map((mode) => ({
		productKey: model.productKey,
		mode,
		...model.defaults[mode]!,
	})),
);

describe("video V1 admission isolated PostgreSQL", () => {
	let client: PrismaClient;
	const owners: string[] = [];
	beforeAll(async () => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("BLOCKED: explicit TEST_DATABASE_URL required");
		const url = new URL(connectionString);
		if (
			!["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
			!/(^|[_-])test([_-]|$)/.test(url.pathname.slice(1))
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 30 }) });
		vi.stubEnv("VIDEO_RUNTIME_CONFIG", undefined);
		vi.stubEnv("VIDEO_V1_PROVIDER_CONCURRENCY", await providerCapacityForTestRequests(client, 8));
	});
	afterEach(async () => {
		for (const ownerId of owners.splice(0)) {
			const jobs = await client.generationJob.findMany({
				where: { ownerId },
				include: { reservation: true },
			});
			for (const job of jobs) {
				if (job.reservation?.status === "ACTIVE")
					await releaseCredits(
						{
							reservationId: job.reservation.id,
							amount: job.reservation.amount,
							referenceKey: `test-cleanup:${job.id}`,
						},
						client,
					);
				await client.videoExecution.update({ where: { jobId: job.id }, data: { stage: "FAILED" } });
				await client.generationJob.update({
					where: { id: job.id },
					data: { status: "FAILED", terminalAt: new Date() },
				});
			}
		}
	});
	afterAll(async () => {
		vi.unstubAllEnvs();
		await client?.$disconnect();
	});
	async function fixture(credits = 100n) {
		const ownerId = `video-admission-test-${crypto.randomUUID()}`;
		owners.push(ownerId);
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		if (credits > 0n)
			await createCreditGrant(
				{ accountId: account.id, amount: credits, referenceKey: `test:${ownerId}` },
				client,
			);
		const quote = await createVideoQuoteRecord(
			{
				ownerId,
				request,
				price,
				visualSafetyProfile,
				textSafetyProfile: createVideoTextSafetyProfile(),
				audioSafetyPolicy: createVideoAudioSafetyPolicy(),
				maximumInputBytes: limits.maximumInputBytes,
			},
			client,
		);
		return {
			ownerId,
			account,
			quote,
			input: {
				ownerId,
				quoteId: quote.quoteId,
				idempotencyKey: crypto.randomUUID(),
				request,
				price,
				visualSafetyProfile,
				textSafetyProfile: createVideoTextSafetyProfile(),
				audioSafetyPolicy: createVideoAudioSafetyPolicy(),
				limits,
			},
		};
	}
	async function quoteWithExpiry(quoteId: string, expiresAt: Date) {
		const quote = await client.generationQuote.findUniqueOrThrow({ where: { id: quoteId } });
		const { id: _id, createdAt: _createdAt, ...fields } = quote;
		const expired = { ...fields, expiresAt };
		return client.generationQuote.create({
			data: {
				...expired,
				inputSnapshot: fields.inputSnapshot as never,
				pricingSnapshot: fields.pricingSnapshot as never,
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(expired),
			},
		});
	}
	async function modelQuoteFixture(selection: VideoModelSelection) {
		const f = await fixture();
		const asset =
			selection.mode === "image-to-video"
				? await client.mediaAsset.create({
						data: {
							ownerType: "USER",
							ownerId: f.ownerId,
							kind: "INPUT",
							status: "VERIFYING",
							verificationEngine: "video-workflow-v1",
							objectKey: `test/multimodel/${crypto.randomUUID()}.png`,
							mimeType: "image/png",
							byteSize: 100n,
							width: 100,
							height: 100,
							checksum: "a".repeat(64),
							finalizedAt: new Date(),
						},
					})
				: null;
		const selectedRequest = {
			...selection,
			prompt: request.prompt,
			...(asset ? { inputAssetId: asset.id } : {}),
		};
		const selectedProfile = createVideoVisualSafetyProfile("seeapi", selection.duration);
		const quote = await createVideoQuoteRecord(
			{
				...f.input,
				request: selectedRequest,
				visualSafetyProfile: selectedProfile,
				maximumInputBytes: limits.maximumInputBytes,
			},
			client,
		);
		return {
			...f,
			quote,
			input: {
				...f.input,
				quoteId: quote.quoteId,
				request: selectedRequest,
				visualSafetyProfile: selectedProfile,
			},
		};
	}
	async function insertQuoteEvidenceVariant(
		quoteId: string,
		evidence: {
			productKey: string;
			moderationDecision?: string;
			moderationProvider?: string;
			moderationReasonCode?: string;
			inputFingerprint?: string;
		},
	) {
		return client.$executeRaw`
			INSERT INTO "generation_quote" (
				"id", "ownerType", "ownerId", "submittedByUserId", "productKey", "catalogVersion",
				"pricingVersion", "credits", "costMicros", "inputSnapshot", "pricingSnapshot",
				"moderationDecision", "moderationProvider", "moderationRuleVersion", "moderationReasonCode",
				"inputFingerprint", "expiresAt"
			)
			SELECT ${crypto.randomUUID()}, "ownerType", "ownerId", "submittedByUserId", ${evidence.productKey},
				"catalogVersion", "pricingVersion", "credits", "costMicros", "inputSnapshot", "pricingSnapshot",
				${evidence.moderationDecision ?? "PENDING_VIDEO_WORKFLOW"},
				${evidence.moderationProvider ?? "video-workflow-v1"}, "moderationRuleVersion",
				${evidence.moderationReasonCode ?? "PENDING_VIDEO_WORKFLOW"},
				${evidence.inputFingerprint ?? "a".repeat(64)}, "expiresAt"
			FROM "generation_quote" WHERE "id" = ${quoteId}`;
	}
	it.each(["lite", "fast", "quality"] as const)(
		"binds the %s Veo tier through quote signature, admission and same-key replay",
		async (veoTier) => {
			const f = await modelQuoteFixture({
				productKey: "video-veo-3-1",
				mode: "text-to-video",
				duration: 8,
				resolution: "1080p",
				aspectRatio: "16:9",
				sound: true,
				veoTier,
			});
			const quote = await client.generationQuote.findUniqueOrThrow({
				where: { id: f.quote.quoteId },
			});
			expect(quote.inputSnapshot).toMatchObject({ veoTier });
			expect(
				fingerprintGenerationQuoteSecurityPayload({
					...quote,
					inputSnapshot: {
						...(quote.inputSnapshot as object),
						veoTier: veoTier === "quality" ? "lite" : "quality",
					},
				}),
			).not.toBe(quote.inputFingerprint);
			await expect(
				createVideoJobRecord(
					{
						...f.input,
						request: { ...f.input.request, veoTier: veoTier === "quality" ? "lite" : "quality" },
					},
					client,
				),
			).rejects.toThrow("VIDEO_QUOTE_INPUT_MISMATCH");
			const accepted = await createVideoJobRecord(f.input, client);
			await expect(createVideoJobRecord(f.input, client)).resolves.toEqual({
				...accepted,
				replayed: true,
			});
			await expect(
				createVideoJobRecord(
					{
						...f.input,
						request: { ...f.input.request, veoTier: veoTier === "quality" ? "lite" : "quality" },
					},
					client,
				),
			).rejects.toThrow("IDEMPOTENCY_CONFLICT");
			expect(
				(await client.generationJob.findUniqueOrThrow({ where: { id: accepted.jobId } }))
					.inputSnapshot,
			).toEqual(quote.inputSnapshot);
			expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
		},
	);
	const paidFundingPolicy = { minimumUsdMicrosPerCredit: 21_944n };
	const sharedPrice: VideoPrice = {
		...price,
		pricingDetails: {
			creditFloorMicros: "21944",
			costPolicy: { version: "isolated-shared-credit-cost-fixture" },
			paidRevenueQualified: false,
			funding: { mode: "shared-media-credits-v1" },
		},
	};
	async function requote(f: Awaited<ReturnType<typeof fixture>>, quotedPrice: VideoPrice) {
		const quote = await createVideoQuoteRecord(
			{
				...f.input,
				price: quotedPrice,
				maximumInputBytes: limits.maximumInputBytes,
			},
			client,
		);
		return {
			...f,
			quote,
			input: {
				...f.input,
				quoteId: quote.quoteId,
				price: quotedPrice,
				paidFundingPolicy: quotedPrice.paidFundingPolicy,
			},
		};
	}
	async function operatorFixture() {
		const f = await fixture(1000n);
		const validUntil = new Date(Date.now() + 60_000).toISOString();
		const operatorPrice = applyVideoInternalFunding(
			{
				...price,
				paidFundingPolicy,
				pricingDetails: { validUntil, creditFloorMicros: "21944", profitMicros: "100000" },
			},
			{ userId: f.ownerId, role: "admin" },
			{
				VIDEO_V1_ACCESS: "internal",
				VIDEO_INTERNAL_FUNDING: JSON.stringify({
					userIds: [f.ownerId],
					validUntil,
					reason: "Explicit isolated test authorization",
				}),
			},
		);
		return requote(f, operatorPrice);
	}
	async function paidSubscriptionGrant(
		ownerId: string,
		accountId: string,
		options: {
			paid: bigint;
			priceMicros?: bigint;
			refunded?: bigint;
			credits?: bigint;
			periods?: number;
			currency?: string;
			stripeMinorUnits?: boolean;
		},
	) {
		const id = crypto.randomUUID();
		const provider = options.stripeMinorUnits ? "stripe" : "paypal";
		const credits = options.credits ?? 100n;
		const plan = await client.billingPlan.create({
			data: {
				provider,
				providerPriceId: `video-paid-test-${id}`,
				name: "ISOLATED_PAID_FUNDING_FIXTURE",
				creditsPerPeriod: credits,
				priceMicros: options.priceMicros ?? 3_000_000n,
				currency: options.currency ?? "USD",
				metadata: {},
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider,
				providerSubscriptionId: `video-paid-test-${id}`,
				planId: plan.id,
				status: "ACTIVE",
			},
		});
		const referenceKey = options.stripeMinorUnits
			? `stripe-invoice:${id}:period:0:grant`
			: `paypal-payment:${id}:period:0:grant`;
		const starts = Date.now() - 1000;
		for (let index = 0; index < (options.periods ?? 1); index++)
			await client.billingPeriod.create({
				data: {
					subscriptionId: subscription.id,
					startsAt: new Date(starts + index * 86_400_000),
					endsAt: new Date(starts + (index + 1) * 86_400_000),
					status: index === 0 ? "ACTIVE" : "PENDING",
					creditAmount: credits,
					grantReferenceKey: index === 0 ? referenceKey : `${referenceKey}:future:${index}`,
					providerInvoiceId: id,
					providerInvoicePaymentId: `${provider}:${id}`,
					paidAmount: options.paid,
					refundedAmount: options.refunded ?? 0n,
				},
			});
		await createCreditGrant({ accountId, amount: credits, referenceKey }, client);
		return referenceKey;
	}
	async function currentAnnualSubscriptionGrant(
		ownerId: string,
		accountId: string,
		selection: {
			provider: "paypal" | "waffo";
			planId: "creator" | "ultimate" | "studio";
			priceMicros: bigint;
			monthlyCredits: bigint;
		},
	) {
		const id = crypto.randomUUID();
		const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
		const startsAt = new Date(clock!.now);
		startsAt.setUTCDate(1);
		startsAt.setUTCHours(0, 0, 0, 0);
		const boundary = (index: number) => {
			const date = new Date(startsAt);
			date.setUTCMonth(date.getUTCMonth() + index);
			return date;
		};
		const plan = await client.billingPlan.create({
			data: {
				provider: selection.provider,
				providerPriceId: `video-current-annual-test-${id}`,
				name: selection.planId,
				productKind: "PLAN",
				version: 1,
				creditsPerPeriod: selection.monthlyCredits,
				priceMicros: selection.priceMicros,
				currency: "USD",
				metadata: {
					planId: selection.planId,
					interval: "year",
					version: 1,
					billingPricingVersion: "2026-09-15.1",
					providerEnvironment: selection.provider === "paypal" ? "live" : "prod",
				},
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: selection.provider,
				providerSubscriptionId: `video-current-annual-test-${id}`,
				planId: plan.id,
				status: "ACTIVE",
				currentPeriodStart: startsAt,
				currentPeriodEnd: boundary(12),
			},
		});
		const referenceKey = `${selection.provider}-payment:${id}:period:0:grant`;
		await client.billingPeriod.createMany({
			data: Array.from({ length: 12 }, (_, index) => ({
				subscriptionId: subscription.id,
				startsAt: boundary(index),
				endsAt: boundary(index + 1),
				status: index === 0 ? ("ACTIVE" as const) : ("PENDING" as const),
				creditAmount: selection.monthlyCredits,
				grantReferenceKey: index === 0 ? referenceKey : `${referenceKey}:future:${index}`,
				providerInvoiceId: id,
				providerInvoicePaymentId: `${selection.provider}:${id}`,
				paidAmount: selection.priceMicros,
				refundedAmount: 0n,
			})),
		});
		await createCreditGrant(
			{
				accountId,
				amount: selection.monthlyCredits,
				referenceKey,
				expiresAt: boundary(1),
			},
			client,
		);
		return { subscription, referenceKey };
	}
	async function paidPackGrant(ownerId: string, accountId: string, bonusCredits: bigint) {
		const id = crypto.randomUUID();
		const referenceKey = `credit-pack:${id}:grant:v1`;
		const plan = await client.billingPlan.create({
			data: {
				provider: "paypal",
				providerPriceId: id,
				name: "ISOLATED_PAID_PACK_FIXTURE",
				productKind: "CREDIT_PACK",
				creditsPerPeriod: 100n,
				priceMicros: 3_000_000n,
				currency: "USD",
				metadata: {},
			},
		});
		const intent = await client.paymentCheckoutIntent.create({
			data: {
				provider: "paypal",
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				productKind: "CREDIT_PACK",
				billingPlanId: plan.id,
				planKey: id,
				interval: "one-time",
				idempotencyKey: id,
				status: "COMPLETED",
				creditPackCatalogVersion: "isolated-fixture",
				creditPackPricingVersion: "isolated-fixture",
				creditPackSubscriberEligibilityVersion: "isolated-fixture",
				creditPackBaseCredits: 100n,
				creditPackBonusCredits: bonusCredits,
				creditPackTotalCredits: 100n + bonusCredits,
				creditPackExpiryMonths: 6,
				creditPackSubscriberBonusEligible: true,
				creditPackSubscriberSubscriptionId: `fixture-subscription-${id}`,
				creditPackSubscriberPlanKey: "fixture",
				creditPackEligibilityEvaluatedAt: new Date(),
			},
		});
		await client.creditPackFulfillment.create({
			data: {
				id,
				checkoutIntentId: intent.id,
				billingPlanId: plan.id,
				ownerType: "USER",
				ownerId,
				provider: "paypal",
				providerOrderId: id,
				providerPaymentId: id,
				paidAmountMicros: 3_000_000n,
				currency: "USD",
				baseCredits: 100n,
				bonusCredits,
				grantedCredits: 100n + bonusCredits,
				grantReferenceKey: referenceKey,
				paidAt: new Date(),
				expiresAt: new Date(Date.now() + 86_400_000),
			},
		});
		await createCreditGrant({ accountId, amount: 100n + bonusCredits, referenceKey }, client);
		return referenceKey;
	}
	it("atomic submit commits quote, job, reservation and start intent in one transaction", async () => {
		const f = await fixture();
		const input = { ...f.input, expectedCredits: "7", expectedPricing: null };
		const transaction = vi.spyOn(client, "$transaction");
		let accepted;
		try {
			accepted = await submitVideoJobRecord(input, client);
			expect(transaction).toHaveBeenCalledTimes(1);
		} finally {
			transaction.mockRestore();
		}
		expect(accepted.kind).toBe("created");
		if (accepted.kind !== "created") throw new Error("EXPECTED_CREATED");
		const job = await client.generationJob.findUniqueOrThrow({
			where: { id: accepted.jobId },
			include: { reservation: true, videoExecution: true, quote: true },
		});
		expect(job).toMatchObject({
			creditsReserved: 7n,
			reservation: { amount: 7n },
			videoExecution: { stage: "QUEUED", startState: "PENDING" },
		});
		expect(job.quoteId).toBe(videoSubmissionIdentity(input).quoteId);
		expect(job.inputSnapshot).toEqual(job.quote!.inputSnapshot);
		expect(job.quote!.inputFingerprint).toBe(fingerprintGenerationQuoteSecurityPayload(job.quote!));
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
	});
	it("atomic submit concurrent duplicate responses and retries reserve exactly once", async () => {
		const f = await fixture();
		const input = { ...f.input, expectedCredits: "7", expectedPricing: null };
		const results = await Promise.all(
			Array.from({ length: 20 }, () => submitVideoJobRecord(input, client)),
		);
		expect(results.every((result) => result.kind === "created")).toBe(true);
		const ids = results.flatMap((result) => (result.kind === "created" ? [result.jobId] : []));
		expect(new Set(ids).size).toBe(1);
		// A lost browser response retries its immutable intent against current state.
		expect(await findExistingVideoSubmission(input, client)).toMatchObject({ id: ids[0] });
		expect(
			await submitVideoJobRecord({ ...input, price: { ...price, credits: 99n } }, client),
		).toMatchObject({ kind: "created", jobId: ids[0], replayed: true });
		expect(
			await client.generationQuote.count({
				where: { ownerId: f.ownerId, id: { startsWith: "video_submit_" } },
			}),
		).toBe(1);
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(1);
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: f.account.id, type: "RESERVE" } }),
		).toBe(1);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
	});
	it("atomic submit freezes and binds the sealed private input before releasing its lock", async () => {
		const f = await modelQuoteFixture(
			modelModeSelections.find((selection) => selection.mode === "image-to-video")!,
		);
		const input = { ...f.input, expectedCredits: "7", expectedPricing: null };
		const result = await submitVideoJobRecord(input, client);
		if (result.kind !== "created") throw new Error("EXPECTED_CREATED");
		const job = await client.generationJob.findUniqueOrThrow({
			where: { id: result.jobId },
			include: { assets: true },
		});
		expect(job.inputSnapshot).toMatchObject({
			inputIdentity: {
				assetId: input.request.inputAssetId,
				checksum: "a".repeat(64),
				verificationGeneration: 0,
			},
		});
		expect(job.assets).toEqual([
			expect.objectContaining({
				role: "INPUT",
				assetId: input.request.inputAssetId,
				assetChecksum: "a".repeat(64),
			}),
		]);
		const other = await fixture();
		await expect(
			submitVideoJobRecord({ ...input, ownerId: other.ownerId }, client),
		).rejects.toThrow("VIDEO_INPUT_NOT_AVAILABLE");
		expect(await client.creditReservation.count({ where: { accountId: other.account.id } })).toBe(
			0,
		);
	});
	it.each(["request", "consent"])(
		"atomic submit rejects changed %s with an accepted key",
		async (change) => {
			const f = await fixture();
			const input = { ...f.input, expectedCredits: "7", expectedPricing: null };
			await submitVideoJobRecord(input, client);
			const changed =
				change === "request"
					? { ...input, request: { ...request, prompt: "A different instruction" } }
					: { ...input, expectedCredits: "6" };
			await expect(submitVideoJobRecord(changed, client)).rejects.toThrow("IDEMPOTENCY_CONFLICT");
			expect(
				await client.creditLedgerEntry.count({
					where: { accountId: f.account.id, type: "RESERVE" },
				}),
			).toBe(1);
		},
	);
	it("atomic submit keeps changed prices uncharged, including repeated or concurrent retries", async () => {
		const f = await fixture();
		const input = { ...f.input, expectedCredits: "6", expectedPricing: null };
		const results = await Promise.all(
			Array.from({ length: 5 }, () => submitVideoJobRecord(input, client)),
		);
		const result = results[0]!;
		expect(results.every((value) => JSON.stringify(value) === JSON.stringify(result))).toBe(true);
		expect(result).toMatchObject({ kind: "quote_only", quote: { credits: "7" } });
		expect(
			await submitVideoJobRecord({ ...input, price: { ...price, credits: 6n } }, client),
		).toEqual(result);
		await expect(
			submitVideoJobRecord(
				{ ...input, request: { ...request, prompt: "Changed before acceptance" } },
				client,
			),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
		if (result.kind !== "quote_only") throw new Error("EXPECTED_QUOTE_ONLY");
		const confirmation = {
			...f.input,
			quoteId: result.quote.quoteId,
			idempotencyKey: "confirmed-changed-price",
		};
		await expect(
			createVideoJobRecord({ ...confirmation, price: { ...price, credits: 8n } }, client),
		).rejects.toThrow("PRICE_CHANGED");
		await createVideoJobRecord(confirmation, client);
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: f.account.id, type: "RESERVE" } }),
		).toBe(1);
	});
	it("atomic submit compares the entire displayed pricing, even if credits match", async () => {
		const f = await fixture();
		const result = await submitVideoJobRecord(
			{
				...f.input,
				expectedCredits: "7",
				expectedPricing: {
					policyVersion: "displayed-version",
					audience: "annual",
					credits: "7",
					standardCredits: "10",
					annualCredits: "7",
					savedCredits: "3",
					annualSavingsCredits: "3",
				},
			},
			client,
		);
		expect(result.kind).toBe("quote_only");
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
	});
	it("atomic submit isolates the same key across two owners", async () => {
		const [a, b] = await Promise.all([fixture(), fixture()]);
		const key = "same-client-key";
		const [first, second] = await Promise.all(
			[a, b].map((f) =>
				submitVideoJobRecord(
					{ ...f.input, idempotencyKey: key, expectedCredits: "7", expectedPricing: null },
					client,
				),
			),
		);
		expect(first.kind).toBe("created");
		expect(second.kind).toBe("created");
		if (first.kind !== "created" || second.kind !== "created") throw new Error("EXPECTED_CREATED");
		expect(first.jobId).not.toBe(second.jobId);
		await expect(getVideoJobRecord(b.ownerId, first.jobId, client)).rejects.toThrow("NOT_FOUND");
	});
	it("atomic submit rolls back its new quote and all reservations when admission fails", async () => {
		const f = await fixture(0n);
		const input = { ...f.input, expectedCredits: "7", expectedPricing: null };
		await expect(submitVideoJobRecord(input, client)).rejects.toThrow("INSUFFICIENT_CREDITS");
		expect(
			await client.generationQuote.findUnique({
				where: { id: videoSubmissionIdentity(input).quoteId },
			}),
		).toBeNull();
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
		expect(await client.storageUsageReservation.count({ where: { ownerId: f.ownerId } })).toBe(0);
	});
	it("atomic submit never turns an expired changed quote into a reservation", async () => {
		const f = await fixture();
		const firstInput = { ...f.input, expectedCredits: "6", expectedPricing: null };
		await submitVideoJobRecord(firstInput, client);
		const stored = await client.generationQuote.findUniqueOrThrow({
			where: { id: videoSubmissionIdentity(firstInput).quoteId },
		});
		const input = { ...firstInput, idempotencyKey: "expired-pending-submission" };
		const identity = videoSubmissionIdentity(input);
		const { id: _id, createdAt: _createdAt, ...fields } = stored;
		const expired = {
			...fields,
			expiresAt: new Date(Date.now() - 1000),
			inputSnapshot: {
				...(fields.inputSnapshot as Prisma.JsonObject),
				submissionFingerprint: identity.fingerprint,
			},
		};
		await client.generationQuote.create({
			data: {
				...expired,
				id: identity.quoteId,
				inputSnapshot: expired.inputSnapshot as Prisma.InputJsonObject,
				pricingSnapshot: fields.pricingSnapshot as Prisma.InputJsonObject,
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(expired),
			},
		});
		await expect(submitVideoJobRecord(input, client)).rejects.toThrow("QUOTE_EXPIRED");
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
	});
	it("ignores a retired past price deadline through quote, paid admission and claim, keeping quote TTL", async () => {
		const f = await fixture(1n);
		await paidSubscriptionGrant(f.ownerId, f.account.id, { paid: 3_000_000n });
		const selection = { ...request, productKey: "video-kling-2-6-v1", resolution: "default" };
		const afterPreviousDeadline = new Date("2026-10-13T00:00:00.000Z");
		const clock = vi.spyOn(Date, "now").mockReturnValue(afterPreviousDeadline.getTime());
		let approvedPrice: VideoPrice;
		try {
			approvedPrice = resolveVideoModelPrice(selection, {
				VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
				VIDEO_PRICE_BASIS: "isolated non-expiring approval fixture only",
				VIDEO_PRICE_VALID_UNTIL: "2000-01-01T00:00:00.000Z",
				VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
				VIDEO_COST_VISUAL_POLICY_VERSION: visualSafetyProfile.policyVersion,
				VIDEO_COST_TEXT_RULE_VERSION: createVideoTextSafetyProfile().ruleVersion,
				VIDEO_COST_MODERATION_BASE_MICROS: "10000",
				VIDEO_COST_MODERATION_PER_SECOND_MICROS: "5000",
				VIDEO_COST_RUNTIME_MICROS: "5000",
				VIDEO_COST_STORAGE_MICROS: "5000",
				VIDEO_COST_PAYMENT_FIXED_MICROS: "2000",
				VIDEO_COST_PAYMENT_FEE_BPS: "500",
				VIDEO_COST_NONBILLABLE_FAILURE_BPS: "1000",
			});
		} finally {
			clock.mockRestore();
		}
		const quote = await createVideoQuoteRecord(
			{
				...f.input,
				request: selection,
				price: approvedPrice,
				maximumInputBytes: limits.maximumInputBytes,
			},
			client,
		);
		const input = {
			...f.input,
			request: selection,
			quoteId: quote.quoteId,
			price: approvedPrice,
			paidFundingPolicy: approvedPrice.paidFundingPolicy,
		};
		const expiredQuote = await quoteWithExpiry(quote.quoteId, new Date(0));
		await expect(
			createVideoJobRecord({ ...input, quoteId: expiredQuote.id }, client),
		).rejects.toThrow("QUOTE_EXPIRED");
		const accepted = await createVideoJobRecord(input, client);
		const stored = await getVideoJobRecord(f.ownerId, accepted.jobId, client);
		expect(stored.pricingSnapshot).toMatchObject({
			pricingDetails: { priceApprovalExpiryMode: "none", validUntil: null },
			paidFundingPolicy: { minimumUsdMicrosPerCredit: "21944" },
		});
		const textSafetyProfile = createVideoTextSafetyProfile();
		const ruleVersion = "isolated-price-approval-test";
		await runWithDatabaseClient(client, () =>
			recordVideoInputReview(stored.id, {
				status: "ALLOW",
				ruleVersion,
				textSafetyProfile,
				textDecision: {
					decision: "ALLOW",
					reasonCode: "WAFFO_PROMPT_ALLOWED",
					ruleVersion: textSafetyProfile.ruleVersion,
					evidence: {
						requestId: `price-approval-${stored.id}`,
						models: ["waffo-prompt-sift"],
						operations: 1,
						scores: {},
						waffo: {
							requestId: `price-approval-${stored.id}`,
							action: "allow",
							semanticStatus: "scored",
							matchedCategories: [],
						},
					},
				},
				requestFingerprint: fingerprintVideoRequest(f.ownerId, selection),
				validUntil: new Date(Date.now() + 60_000).toISOString(),
			}),
		);
		const claim = await runWithDatabaseClient(client, () =>
			claimVideoProviderSubmission({
				jobId: stored.id,
				callbackTokenHash: crypto.randomUUID().replaceAll("-", "").repeat(2),
				providerModelId: "kling-2.6/text-to-video",
				ruleVersion,
			}),
		);
		if ("deferred" in claim) throw new Error("Unexpected provider capacity wait");
		expect(claim).toMatchObject({ claimed: true });
		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: f.account.id } }),
		).toMatchObject({
			reservedCredits: approvedPrice.credits,
		});
	});
	it("template credit snapshot separates free credits without creating an account or changing the ledger", async () => {
		const unknown = crypto.randomUUID();
		expect(await getVideoTemplateCreditBalance(unknown, paidFundingPolicy, client)).toEqual({
			totalCredits: "0",
			eligibleCredits: "0",
		});
		expect(await client.creditAccount.count({ where: { ownerId: unknown } })).toBe(0);
		const f = await fixture(391n);
		const before = await client.creditAccount.findUniqueOrThrow({ where: { id: f.account.id } });
		const ledgerCount = await client.creditLedgerEntry.count({
			where: { accountId: f.account.id },
		});
		expect(await getVideoTemplateCreditBalance(f.ownerId, paidFundingPolicy, client)).toEqual({
			totalCredits: "391",
			eligibleCredits: "0",
		});
		expect(await getVideoTemplateCreditBalance(f.ownerId, undefined, client)).toEqual({
			totalCredits: "391",
			eligibleCredits: "391",
		});
		expect(await client.creditAccount.findUniqueOrThrow({ where: { id: f.account.id } })).toEqual(
			before,
		);
		expect(await client.creditLedgerEntry.count({ where: { accountId: f.account.id } })).toBe(
			ledgerCount,
		);
	});
	it("template credit snapshot excludes expired funding and blocks availability with credit debt", async () => {
		const f = await fixture();
		const ref = await paidSubscriptionGrant(f.ownerId, f.account.id, { paid: 3_000_000n });
		expect(await getVideoTemplateCreditBalance(f.ownerId, paidFundingPolicy, client)).toEqual({
			totalCredits: "200",
			eligibleCredits: "100",
		});
		await client.creditLot.update({
			where: { accountId_grantReferenceKey: { accountId: f.account.id, grantReferenceKey: ref } },
			data: { expiresAt: new Date(Date.now() - 1000) },
		});
		expect(await getVideoTemplateCreditBalance(f.ownerId, paidFundingPolicy, client)).toEqual({
			totalCredits: "100",
			eligibleCredits: "0",
		});
		await client.creditAccount.update({ where: { id: f.account.id }, data: { creditDebt: 1n } });
		expect(await getVideoTemplateCreditBalance(f.ownerId, undefined, client)).toEqual({
			totalCredits: "100",
			eligibleCredits: "0",
		});
		await client.creditAccount.update({ where: { id: f.account.id }, data: { creditDebt: 0n } });
	});
	it.each(
		[
			{ planId: "creator" as const, priceMicros: 114_000_000n, monthlyCredits: 700n },
			{ planId: "ultimate" as const, priceMicros: 294_000_000n, monthlyCredits: 1_800n },
			{ planId: "studio" as const, priceMicros: 474_000_000n, monthlyCredits: 3_000n },
		].flatMap((tier) =>
			(["paypal", "waffo"] as const).flatMap((provider) =>
				([5, 10] as const).map((duration) => ({ ...tier, provider, duration })),
			),
		),
	)(
		"new $provider $planId annual receipts fund $duration-second ordinary video at the unchanged approved annual debit",
		async (selection) => {
			const f = await fixture(0n);
			const annual = await currentAnnualSubscriptionGrant(f.ownerId, f.account.id, selection);
			const periods = await client.billingPeriod.findMany({
				where: { subscriptionId: annual.subscription.id },
				orderBy: { startsAt: "asc" },
			});
			expect(periods).toHaveLength(12);
			expect(periods.every((period) => period.paidAmount === selection.priceMicros)).toBe(true);
			expect(periods.reduce((sum, period) => sum + period.creditAmount, 0n)).toBe(
				selection.monthlyCredits * 12n,
			);
			expect(new Set(periods.map((period) => period.providerInvoicePaymentId)).size).toBe(1);
			expect(await getVideoTemplateCreditBalance(f.ownerId, paidFundingPolicy, client)).toEqual({
				totalCredits: selection.monthlyCredits.toString(),
				eligibleCredits: "0",
			});
			const eligibility = await resolveVideoRetailEligibility(f.ownerId, client);
			expect(eligibility).toMatchObject({
				audience: "annual",
				ownerId: f.ownerId,
				subscriptionId: annual.subscription.id,
				planKey: selection.planId,
				validUntil: annual.subscription.currentPeriodEnd!.toISOString(),
			});
			// Exact operating assumptions of the frozen approved retail matrix, not live provider evidence.
			const approvedEnvironment = {
				VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
				VIDEO_RETAIL_PRICE_ACCEPTED_VERSION: VIDEO_RETAIL_PRICE_VERSION,
				VIDEO_PRICE_BASIS: "APPROVED_RETAIL_MATRIX_HISTORICAL_COST_FIXTURE",
				VIDEO_PRICE_VALID_UNTIL: "none",
				VIDEO_COST_VISUAL_POLICY_VERSION: visualSafetyProfile.policyVersion,
				VIDEO_COST_TEXT_RULE_VERSION: createVideoTextSafetyProfile().ruleVersion,
				VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
				VIDEO_COST_MODERATION_BASE_MICROS: "5100",
				VIDEO_COST_MODERATION_PER_SECOND_MICROS: "200",
				VIDEO_COST_RUNTIME_MICROS: "100000",
				VIDEO_COST_STORAGE_MICROS: "10000",
				VIDEO_COST_PAYMENT_FIXED_MICROS: "0",
				VIDEO_COST_PAYMENT_FEE_BPS: "654",
				VIDEO_COST_NONBILLABLE_FAILURE_BPS: "1000",
			};
			const selectedRequest = {
				...request,
				productKey: "video-seedance-2-mini",
				resolution: "720p",
				duration: selection.duration,
			};
			const selectedProfile = createVideoVisualSafetyProfile("seeapi", selection.duration);
			const matrixRow = approvedVideoRetail.rows.find(
				({ selection: option }) =>
					option.productKey === selectedRequest.productKey &&
					option.mode === selectedRequest.mode &&
					option.duration === selectedRequest.duration &&
					option.resolution === selectedRequest.resolution &&
					option.sound === selectedRequest.sound,
			);
			expect(matrixRow).toBeDefined();
			const standard = resolveVideoModelPrice(selectedRequest, approvedEnvironment);
			const annualPrice = resolveVideoModelPrice(selectedRequest, approvedEnvironment, {
				audience: eligibility.audience,
				eligibility,
			});
			expect(standard.credits.toString()).toBe(matrixRow!.standardCredits);
			expect(annualPrice.credits.toString()).toBe(matrixRow!.annualCredits);
			expect(annualPrice.credits).toBeLessThan(standard.credits);
			const ordinaryPrice = applyVideoSharedFunding(annualPrice);
			expect(ordinaryPrice.paidFundingPolicy).toBeUndefined();
			expect(ordinaryPrice.pricingDetails).toMatchObject({
				paidRevenueQualified: false,
				funding: { mode: "shared-media-credits-v1" },
				retailReference: { creditFloorMicros: "21944" },
				retail: {
					display: {
						standardCredits: matrixRow!.standardCredits,
						annualCredits: matrixRow!.annualCredits,
						credits: matrixRow!.annualCredits,
						audience: "annual",
					},
				},
			});
			const quote = await createVideoQuoteRecord(
				{
					...f.input,
					request: selectedRequest,
					visualSafetyProfile: selectedProfile,
					price: ordinaryPrice,
					maximumInputBytes: limits.maximumInputBytes,
				},
				client,
			);
			const input = {
				...f.input,
				request: selectedRequest,
				visualSafetyProfile: selectedProfile,
				idempotencyKey: crypto.randomUUID(),
				quoteId: quote.quoteId,
				price: ordinaryPrice,
				paidFundingPolicy: undefined,
			};
			// Admission rechecks the real annual proof after locking the account, then reserves shared lots.
			const accepted = await createVideoJobRecord(input, client);
			await expect(createVideoJobRecord(input, client)).resolves.toEqual({
				...accepted,
				replayed: true,
			});
			const stored = await client.generationJob.findUniqueOrThrow({
				where: { id: accepted.jobId },
				include: { reservation: { include: { allocations: { include: { lot: true } } } } },
			});
			expect(stored.creditsReserved).toBe(ordinaryPrice.credits);
			expect(stored.pricingSnapshot).not.toHaveProperty("paidFundingPolicy");
			expect(stored.pricingSnapshot).toMatchObject({
				pricingDetails: ordinaryPrice.pricingDetails,
			});
			expect(stored.reservation!.allocations).toHaveLength(1);
			expect(stored.reservation!.allocations[0]).toMatchObject({
				amount: ordinaryPrice.credits,
				lot: {
					grantReferenceKey: annual.referenceKey,
					remainingAmount: selection.monthlyCredits - ordinaryPrice.credits,
					reservedAmount: ordinaryPrice.credits,
				},
			});
			expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
			const reserves = await client.creditLedgerEntry.findMany({
				where: { accountId: f.account.id, type: "RESERVE" },
			});
			expect(reserves).toHaveLength(1);
			expect(reserves[0]!.metadata).not.toHaveProperty("command.metadata.paidFundingPolicy");
			expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
		},
	);
	it.each([
		{ label: "gift only", gifted: 7n, paid: 0n },
		{ label: "paid only below the former revenue floor", gifted: 0n, paid: 7n },
		{ label: "mixed gift and paid", gifted: 3n, paid: 4n },
	])(
		"shared ordinary video reserves $label credits with its quoted cost snapshot",
		async (funds) => {
			const f = await requote(await fixture(funds.gifted), sharedPrice);
			const expectedAllocations: Record<string, bigint> = {};
			if (funds.gifted > 0n) expectedAllocations[`test:${f.ownerId}`] = funds.gifted;
			if (funds.paid > 0n) {
				const paidRef = await paidSubscriptionGrant(f.ownerId, f.account.id, {
					paid: 1n,
					credits: funds.paid,
				});
				expectedAllocations[paidRef] = funds.paid;
			}
			const accepted = await createVideoJobRecord(f.input, client);
			const job = await client.generationJob.findUniqueOrThrow({
				where: { id: accepted.jobId },
				include: { reservation: { include: { allocations: { include: { lot: true } } } } },
			});
			expect(job.pricingSnapshot).toMatchObject({
				credits: "7",
				providerCostMicros: "2",
				moderationCostMicros: "1",
				pricingDetails: sharedPrice.pricingDetails,
			});
			expect(job.pricingSnapshot).not.toHaveProperty("paidFundingPolicy");
			expect(
				Object.fromEntries(
					job.reservation!.allocations.map((allocation) => [
						allocation.lot.grantReferenceKey,
						allocation.amount,
					]),
				),
			).toEqual(expectedAllocations);
			expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
				valid: true,
				account: { spendable: 0n, reserved: 7n, debt: 0n },
			});
		},
	);
	it("shared ordinary video excludes expired lots and admits only after valid credits are available", async () => {
		const f = await requote(await fixture(7n), sharedPrice);
		await client.creditLot.updateMany({
			where: { accountId: f.account.id },
			data: { expiresAt: new Date(Date.now() - 1000) },
		});
		await expect(createVideoJobRecord(f.input, client)).rejects.toThrow("INSUFFICIENT_CREDITS");
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
		const activeRef = `test:${f.ownerId}:active`;
		await createCreditGrant(
			{ accountId: f.account.id, amount: 7n, referenceKey: activeRef },
			client,
		);
		const accepted = await createVideoJobRecord(f.input, client);
		const allocations = await client.creditReservationAllocation.findMany({
			where: { reservation: { jobId: accepted.jobId } },
			include: { lot: true },
		});
		expect(allocations).toHaveLength(1);
		expect(allocations[0]!.lot.grantReferenceKey).toBe(activeRef);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
			valid: true,
			account: { spendable: 0n, reserved: 7n, debt: 0n },
			lots: { expiredUnrefunded: 7n },
		});
	});
	it("shared ordinary video competing reservations cannot overspend the same mixed account", async () => {
		const f = await requote(await fixture(3n), sharedPrice);
		await paidSubscriptionGrant(f.ownerId, f.account.id, { paid: 1n, credits: 4n });
		const second = await requote(f, sharedPrice);
		const outcomes = await Promise.allSettled(
			[f.input, { ...second.input, idempotencyKey: crypto.randomUUID() }].map((input) =>
				createVideoJobRecord(
					{ ...input, limits: { ...input.limits, ownerConcurrency: 2 } },
					client,
				),
			),
		);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
			reason: new Error("INSUFFICIENT_CREDITS"),
		});
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(1);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
			valid: true,
			account: { spendable: 0n, reserved: 7n, debt: 0n },
		});
	});
	it("shared ordinary video concurrent replays retain one reservation and one durable start intent", async () => {
		const f = await requote(await fixture(7n), sharedPrice);
		const results = await Promise.all(
			Array.from({ length: 8 }, () => createVideoJobRecord(f.input, client)),
		);
		expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
		expect(results.filter((result) => !result.replayed)).toHaveLength(1);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: f.account.id, type: "RESERVE" } }),
		).toBe(1);
		expect(
			await client.videoExecution.count({
				where: { jobId: results[0]!.jobId, stage: "QUEUED", startState: "PENDING" },
			}),
		).toBe(1);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
	});
	it.each(["paid-policy", "revenue-claim", "unknown-funding"] as const)(
		"shared ordinary video rejects %s policy drift before reservation",
		async (failure) => {
			const rejectedPrice =
				failure === "paid-policy"
					? sharedPrice
					: {
							...sharedPrice,
							pricingDetails: {
								...sharedPrice.pricingDetails,
								...(failure === "revenue-claim"
									? { paidRevenueQualified: true }
									: { funding: { mode: "shared-media-credits-v2" } }),
							},
						};
			const f = await requote(await fixture(7n), rejectedPrice);
			await expect(
				createVideoJobRecord(
					{ ...f.input, ...(failure === "paid-policy" ? { paidFundingPolicy } : {}) },
					client,
				),
			).rejects.toThrow("VIDEO_FUNDING_POLICY_CHANGED");
			expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
		},
	);
	it.each(["settle", "release"] as const)(
		"shared ordinary video %s preserves refund revocations and ledger replay guards",
		async (mode) => {
			const f = await requote(await fixture(3n), sharedPrice);
			const paidRef = await paidSubscriptionGrant(f.ownerId, f.account.id, {
				paid: 1n,
				credits: 4n,
			});
			const accepted = await createVideoJobRecord(f.input, client);
			const reservation = await client.creditReservation.findUniqueOrThrow({
				where: { jobId: accepted.jobId },
			});
			await createCreditGrant(
				{ accountId: f.account.id, amount: 7n, referenceKey: `test:${f.ownerId}:spare` },
				client,
			);
			const refund = {
				accountId: f.account.id,
				grantReferenceKey: paidRef,
				amount: 4n,
				referenceKey: `test:${accepted.jobId}:refund`,
			};
			const refunded = await refundCreditGrant(refund, client);
			await expect(refundCreditGrant(refund, client)).resolves.toEqual(refunded);
			await expect(refundCreditGrant({ ...refund, amount: 3n }, client)).rejects.toThrow(
				"IDEMPOTENCY_CONFLICT",
			);
			expect(
				await client.creditReservationAllocation.findFirstOrThrow({
					where: { reservationId: reservation.id, lot: { grantReferenceKey: paidRef } },
				}),
			).toMatchObject({ amount: 4n, revokedAmount: 4n });
			await expect(
				settleCredits(
					{
						reservationId: reservation.id,
						amount: 8n,
						referenceKey: `test:${accepted.jobId}:over`,
					},
					client,
				),
			).rejects.toThrow("Settlement exceeds reserved credits");
			const mutation = {
				reservationId: reservation.id,
				amount: 7n,
				referenceKey: `test:${accepted.jobId}:${mode}`,
			};
			const finalize = mode === "settle" ? settleCredits : releaseCredits;
			const finalized = await finalize(mutation, client);
			await expect(finalize(mutation, client)).resolves.toEqual(finalized);
			await expect(finalize({ ...mutation, amount: 6n }, client)).rejects.toThrow(
				"IDEMPOTENCY_CONFLICT",
			);
			const otherFinalize = mode === "settle" ? releaseCredits : settleCredits;
			await expect(
				otherFinalize({ ...mutation, referenceKey: `${mutation.referenceKey}:conflict` }, client),
			).rejects.toThrow("IDEMPOTENCY_CONFLICT");
			expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
				valid: true,
				account: {
					spendable: mode === "settle" ? 7n : 10n,
					reserved: 0n,
					debt: mode === "settle" ? 4n : 0n,
				},
				ledger: { settled: mode === "settle" ? 7n : 0n, released: mode === "release" ? 7n : 0n },
			});
			expect(
				await client.creditLedgerEntry.count({
					where: { accountId: f.account.id, type: "REFUND" },
				}),
			).toBe(1);
			if (mode === "settle") {
				const next = await requote(f, sharedPrice);
				await expect(
					createVideoJobRecord(
						{
							...next.input,
							idempotencyKey: crypto.randomUUID(),
							limits: { ...limits, ownerConcurrency: 2 },
						},
						client,
					),
				).rejects.toThrow("CREDIT_DEBT_OUTSTANDING");
				expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(
					1,
				);
			}
		},
	);
	it("shared ordinary video release never restores a lot that expired during execution", async () => {
		const f = await requote(await fixture(7n), sharedPrice);
		const accepted = await createVideoJobRecord(f.input, client);
		const reservation = await client.creditReservation.findUniqueOrThrow({
			where: { jobId: accepted.jobId },
		});
		await client.creditLot.updateMany({
			where: { accountId: f.account.id },
			data: { expiresAt: new Date(Date.now() - 1000) },
		});
		await releaseCredits(
			{ reservationId: reservation.id, referenceKey: `test:${accepted.jobId}:expired-release` },
			client,
		);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
			valid: true,
			account: { spendable: 0n, reserved: 0n, debt: 0n },
			lots: { expiredUnrefunded: 7n },
			ledger: { released: 7n },
		});
	});
	it("accepted paid video replay preserves its original funding snapshot after shared credit rollout", async () => {
		const f = await requote(await fixture(0n), { ...price, paidFundingPolicy });
		await paidSubscriptionGrant(f.ownerId, f.account.id, { paid: 3_000_000n });
		const accepted = await createVideoJobRecord(f.input, client);
		const before = await client.generationJob.findUniqueOrThrow({ where: { id: accepted.jobId } });
		await expect(
			createVideoJobRecord(
				{ ...f.input, price: sharedPrice, paidFundingPolicy: undefined },
				client,
			),
		).resolves.toEqual({ ...accepted, replayed: true });
		const after = await client.generationJob.findUniqueOrThrow({ where: { id: accepted.jobId } });
		expect(after.pricingSnapshot).toEqual(before.pricingSnapshot);
		expect(after.pricingSnapshot).toMatchObject({
			paidFundingPolicy: { minimumUsdMicrosPerCredit: "21944" },
		});
		const reserveLedger = await client.creditLedgerEntry.findMany({
			where: { accountId: f.account.id, type: "RESERVE" },
		});
		expect(reserveLedger).toHaveLength(1);
		expect(reserveLedger[0]!.metadata).toMatchObject({
			command: { metadata: { paidFundingPolicy: { minimumUsdMicrosPerCredit: "21944" } } },
		});
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
	});
	it("explicit operator funding reserves genuine ordinary lots once and settles the actual debit", async () => {
		const f = await operatorFixture();
		const results = await Promise.all(
			Array.from({ length: 20 }, () => createVideoJobRecord(f.input, client)),
		);
		expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
		expect(results.filter((result) => !result.replayed)).toHaveLength(1);
		const job = await client.generationJob.findUniqueOrThrow({
			where: { id: results[0]!.jobId },
			include: { reservation: true },
		});
		expect(job.pricingSnapshot).toMatchObject({
			pricingDetails: {
				paidRevenueQualified: false,
				funding: { mode: "operator-funded-internal-v1", authorizedOwnerId: f.ownerId },
				retailReference: { profitMicros: "100000" },
			},
		});
		expect(await client.creditAccount.findUnique({ where: { id: f.account.id } })).toMatchObject({
			spendableCredits: 993n,
			reservedCredits: 7n,
		});
		const allocations = await client.creditReservationAllocation.findMany({
			where: { reservationId: job.reservation!.id },
			include: { lot: true },
		});
		expect(allocations).toHaveLength(1);
		expect(allocations[0]!.lot.grantReferenceKey).toBe(`test:${f.ownerId}`);
		expect(
			await client.creditLedgerEntry.count({
				where: { reservationId: job.reservation!.id, type: "RESERVE" },
			}),
		).toBe(1);
		expect(
			await client.billingPeriod.count({ where: { subscription: { ownerId: f.ownerId } } }),
		).toBe(0);
		expect(await client.creditPackFulfillment.count({ where: { ownerId: f.ownerId } })).toBe(0);
		await settleCredits(
			{ reservationId: job.reservation!.id, amount: 7n, referenceKey: `test:${job.id}:settle` },
			client,
		);
		expect(await client.creditAccount.findUnique({ where: { id: f.account.id } })).toMatchObject({
			spendableCredits: 993n,
			reservedCredits: 0n,
		});
		await expect(
			createVideoJobRecord({ ...f.input, price, paidFundingPolicy }, client),
		).resolves.toMatchObject({ jobId: job.id, replayed: true });
		expect(
			(await client.generationJob.findUniqueOrThrow({ where: { id: job.id } })).pricingSnapshot,
		).toEqual(job.pricingSnapshot);
	});
	it("requires a new quote when operator authorization changes or is removed", async () => {
		const f = await operatorFixture();
		const funding = f.input.price.pricingDetails!.funding as Record<string, string>;
		for (const changedPrice of [
			{ ...price, paidFundingPolicy },
			{
				...f.input.price,
				pricingDetails: {
					...f.input.price.pricingDetails,
					funding: { ...funding, reason: "different authorization" },
				},
			},
		]) {
			await expect(
				createVideoJobRecord({ ...f.input, price: changedPrice }, client),
			).rejects.toThrow("PRICE_CHANGED");
		}
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
	});
	it.each(["expired", "wrong-owner", "paid-policy"] as const)(
		"rejects %s operator funding at the transaction boundary before reserving",
		async (failure) => {
			let f = await operatorFixture();
			if (failure !== "paid-policy") {
				const funding = f.input.price.pricingDetails!.funding as Record<string, string>;
				f = await requote(f, {
					...f.input.price,
					pricingDetails: {
						...f.input.price.pricingDetails,
						funding: {
							...funding,
							...(failure === "expired"
								? { validUntil: new Date(Date.now() - 1000).toISOString() }
								: { authorizedOwnerId: "other-admin" }),
						},
					},
				});
			}
			await expect(
				createVideoJobRecord(
					{ ...f.input, ...(failure === "paid-policy" ? { paidFundingPolicy } : {}) },
					client,
				),
			).rejects.toThrow("VIDEO_FUNDING_POLICY_CHANGED");
			expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
		},
	);
	it("binds new paid funding quotes to the exact policy and forbids omission or downgrade", async () => {
		const f = await requote(await fixture(), { ...price, paidFundingPolicy });
		await expect(
			createVideoJobRecord({ ...f.input, paidFundingPolicy: undefined }, client),
		).rejects.toThrow("VIDEO_FUNDING_POLICY_CHANGED");
		await expect(
			createVideoJobRecord(
				{ ...f.input, paidFundingPolicy: { minimumUsdMicrosPerCredit: 1n } },
				client,
			),
		).rejects.toThrow("VIDEO_FUNDING_POLICY_CHANGED");
		await expect(createVideoJobRecord({ ...f.input, price }, client)).rejects.toThrow(
			"PRICE_CHANGED",
		);
		await expect(
			createVideoJobRecord(
				{ ...f.input, price: sharedPrice, paidFundingPolicy: undefined },
				client,
			),
		).rejects.toThrow("PRICE_CHANGED");
		await expect(createVideoJobRecord(f.input, client)).rejects.toThrow(
			"INSUFFICIENT_PAID_CREDITS",
		);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
	});
	it("paid video policy rejects free grants while the default ledger path remains unchanged", async () => {
		const f = await fixture();
		await expect(createVideoJobRecord({ ...f.input, paidFundingPolicy }, client)).rejects.toThrow(
			"INSUFFICIENT_PAID_CREDITS",
		);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
		await expect(createVideoJobRecord(f.input, client)).resolves.toMatchObject({ replayed: false });
	});
	it("paid video allocation skips earlier free grants and audits the revenue floor", async () => {
		const f = await fixture();
		const paidRef = await paidSubscriptionGrant(f.ownerId, f.account.id, { paid: 3_000_000n });
		const result = await createVideoJobRecord({ ...f.input, paidFundingPolicy }, client);
		expect(await getVideoTemplateCreditBalance(f.ownerId, paidFundingPolicy, client)).toEqual({
			totalCredits: "193",
			eligibleCredits: "93",
		});
		const allocations = await client.creditReservationAllocation.findMany({
			where: { reservation: { jobId: result.jobId } },
			include: { lot: true },
		});
		expect(allocations).toHaveLength(1);
		expect(allocations[0]!.lot.grantReferenceKey).toBe(paidRef);
		expect(
			await client.creditLot.findUnique({
				where: {
					accountId_grantReferenceKey: {
						accountId: f.account.id,
						grantReferenceKey: `test:${f.ownerId}`,
					},
				},
			}),
		).toMatchObject({ remainingAmount: 100n });
		const ledger = await client.creditLedgerEntry.findFirstOrThrow({
			where: { accountId: f.account.id, type: "RESERVE" },
		});
		expect(ledger.metadata).toMatchObject({
			command: { metadata: { paidFundingPolicy: { minimumUsdMicrosPerCredit: "21944" } } },
		});
	});
	it.each([
		{ plan: "creator", credits: 700n, oldAnnualUsd: 190n, annualUsd: 114n },
		{ plan: "ultimate", credits: 1_800n, oldAnnualUsd: 490n, annualUsd: 294n },
		{ plan: "studio", credits: 3_000n, oldAnnualUsd: 790n, annualUsd: 474n },
	])(
		"reserves only historical qualified $plan annual credits and never falls back to the cheaper new annual lot",
		async (tier) => {
			const f = await fixture(0n);
			const cheaperRef = await paidSubscriptionGrant(f.ownerId, f.account.id, {
				paid: tier.annualUsd * 1_000_000n,
				priceMicros: tier.annualUsd * 1_000_000n,
				credits: tier.credits,
				periods: 12,
			});
			expect(await getVideoTemplateCreditBalance(f.ownerId, paidFundingPolicy, client)).toEqual({
				totalCredits: tier.credits.toString(),
				eligibleCredits: "0",
			});
			const historicalRef = await paidSubscriptionGrant(f.ownerId, f.account.id, {
				paid: tier.oldAnnualUsd * 1_000_000n,
				priceMicros: tier.oldAnnualUsd * 1_000_000n,
				credits: tier.credits,
				periods: 12,
			});
			const qualified = await requote(f, { ...price, paidFundingPolicy });
			const result = await createVideoJobRecord(qualified.input, client);
			const allocations = await client.creditReservationAllocation.findMany({
				where: { reservation: { jobId: result.jobId } },
				include: { lot: true },
			});
			expect(allocations).toHaveLength(1);
			expect(allocations[0]!.lot.grantReferenceKey).toBe(historicalRef);
			expect(allocations[0]!.amount).toBe(price.credits);
			expect(await getVideoTemplateCreditBalance(f.ownerId, paidFundingPolicy, client)).toEqual({
				totalCredits: (tier.credits * 2n - price.credits).toString(),
				eligibleCredits: (tier.credits - price.credits).toString(),
			});

			// Total balance is sufficient, but eligible historical receipts are one credit short.
			const blocked = await requote(f, {
				...price,
				credits: tier.credits - price.credits + 1n,
				paidFundingPolicy,
			});
			await expect(
				createVideoJobRecord(
					{
						...blocked.input,
						idempotencyKey: crypto.randomUUID(),
					},
					client,
				),
			).rejects.toThrow("INSUFFICIENT_PAID_CREDITS");
			expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
			expect(
				await client.creditLot.findUniqueOrThrow({
					where: {
						accountId_grantReferenceKey: { accountId: f.account.id, grantReferenceKey: cheaperRef },
					},
				}),
			).toMatchObject({ remainingAmount: tier.credits, reservedAmount: 0n });
		},
	);
	it.each([
		{ label: "discount below floor", paid: 1_000_000n },
		{ label: "non-USD funding", paid: 3_000_000n, currency: "EUR" },
		{ label: "net refund below floor", paid: 3_000_000n, refunded: 2_000_000n },
		{ label: "annual payment spread over all periods", paid: 3_000_000n, periods: 12 },
	])("rejects $label without a reservation", async (options) => {
		const f = await fixture();
		await paidSubscriptionGrant(f.ownerId, f.account.id, options);
		expect(await getVideoTemplateCreditBalance(f.ownerId, paidFundingPolicy, client)).toEqual({
			totalCredits: "200",
			eligibleCredits: "0",
		});
		await expect(createVideoJobRecord({ ...f.input, paidFundingPolicy }, client)).rejects.toThrow(
			"INSUFFICIENT_PAID_CREDITS",
		);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
	});
	it("legacy Stripe invoice minor units are converted once to micro-USD", async () => {
		const f = await fixture();
		await paidSubscriptionGrant(f.ownerId, f.account.id, { paid: 300n, stripeMinorUnits: true });
		expect(await getVideoTemplateCreditBalance(f.ownerId, paidFundingPolicy, client)).toEqual({
			totalCredits: "200",
			eligibleCredits: "100",
		});
		await expect(
			createVideoJobRecord({ ...f.input, paidFundingPolicy }, client),
		).resolves.toMatchObject({ replayed: false });
	});
	it("credit pack bonus credits reduce the revenue per entire grant", async () => {
		const low = await fixture();
		await paidPackGrant(low.ownerId, low.account.id, 100n);
		expect(await getVideoTemplateCreditBalance(low.ownerId, paidFundingPolicy, client)).toEqual({
			totalCredits: "300",
			eligibleCredits: "0",
		});
		await expect(createVideoJobRecord({ ...low.input, paidFundingPolicy }, client)).rejects.toThrow(
			"INSUFFICIENT_PAID_CREDITS",
		);
		const valid = await fixture();
		await paidPackGrant(valid.ownerId, valid.account.id, 20n);
		expect(await getVideoTemplateCreditBalance(valid.ownerId, paidFundingPolicy, client)).toEqual({
			totalCredits: "220",
			eligibleCredits: "120",
		});
		await expect(
			createVideoJobRecord({ ...valid.input, paidFundingPolicy }, client),
		).resolves.toMatchObject({ replayed: false });
	});
	it("concurrent paid reservations cannot fall back to free balance after the paid lot is used", async () => {
		const f = await fixture();
		await paidSubscriptionGrant(f.ownerId, f.account.id, { paid: 1_000_000n, credits: 7n });
		const second = await createVideoQuoteRecord(
			{
				ownerId: f.ownerId,
				request,
				price,
				visualSafetyProfile,
				textSafetyProfile: createVideoTextSafetyProfile(),
				audioSafetyPolicy: createVideoAudioSafetyPolicy(),
				maximumInputBytes: limits.maximumInputBytes,
			},
			client,
		);
		const outcomes = await Promise.allSettled(
			[f.input, { ...f.input, quoteId: second.quoteId, idempotencyKey: crypto.randomUUID() }].map(
				(entry) =>
					createVideoJobRecord(
						{ ...entry, paidFundingPolicy, limits: { ...entry.limits, ownerConcurrency: 2 } },
						client,
					),
			),
		);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
			reason: new Error("INSUFFICIENT_PAID_CREDITS"),
		});
		expect(await client.creditAccount.findUnique({ where: { id: f.account.id } })).toMatchObject({
			reservedCredits: 7n,
			spendableCredits: 100n,
		});
	});
	it("20 simultaneous copies reserve exactly once and persist one stable start intent without Outbox", async () => {
		const { input, account } = await fixture();
		const results = await Promise.all(
			Array.from({ length: 20 }, () => createVideoJobRecord(input, client)),
		);
		expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
		expect(await client.creditReservation.count({ where: { accountId: account.id } })).toBe(1);
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: account.id, type: "RESERVE" } }),
		).toBe(1);
		const jobId = results[0]!.jobId;
		expect(
			await client.storageUsageReservation.findMany({ where: { ownerId: input.ownerId } }),
		).toEqual([
			expect.objectContaining({
				referenceKey: `video-output:${jobId}`,
				bytes: 104857600n,
				status: "ACTIVE",
			}),
		]);
		expect(await client.outboxEvent.count({ where: { aggregateId: jobId } })).toBe(0);
		expect(await client.videoExecution.findUnique({ where: { jobId } })).toMatchObject({
			workflowInstanceId: `video-v1-${jobId}`,
			startState: "PENDING",
			stage: "QUEUED",
		});
	});
	it.each([1n, 104857599n])(
		"rejects admission with only %s output bytes before creating any paid graph",
		async (available) => {
			const f = await fixture();
			await expect(
				createVideoJobRecord(
					{ ...f.input, limits: { ...limits, maximumStorageBytes: available } },
					client,
				),
			).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
			expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
			expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
			expect(await client.storageUsageReservation.count({ where: { ownerId: f.ownerId } })).toBe(0);
		},
	);
	it("atomically reserves the entire output maximum before provider submission", async () => {
		const f = await fixture();
		const result = await createVideoJobRecord(
			{ ...f.input, limits: { ...limits, maximumStorageBytes: 104857600n } },
			client,
		);
		expect(
			await client.storageUsageReservation.findUnique({
				where: { referenceKey: `video-output:${result.jobId}` },
			}),
		).toMatchObject({ ownerId: f.ownerId, status: "ACTIVE", bytes: 104857600n });
	});
	it("subscribers exceed aggregate quota while retaining the full video output reservation", async () => {
		const f = await fixture();
		await withStorageSubscription(client, f.ownerId, async () => {
			const accepted = await createVideoJobRecord(
				{ ...f.input, limits: { ...limits, maximumStorageBytes: 1n } },
				client,
			);
			const job = await client.generationJob.findUniqueOrThrow({ where: { id: accepted.jobId } });
			expect(job.pricingSnapshot).toMatchObject({
				aggregateStoragePolicy: { schemaVersion: 1, maximumBytes: null },
			});
			expect(job.creditsReserved).toBe(price.credits);
			expect(
				await client.storageUsageReservation.findUnique({
					where: { referenceKey: `video-output:${job.id}` },
				}),
			).toMatchObject({ bytes: 104857600n, status: "ACTIVE" });
			const quote = await client.generationQuote.findUniqueOrThrow({ where: { id: job.quoteId } });
			expect(quote.inputFingerprint).toBe(fingerprintGenerationQuoteSecurityPayload(quote));
		});
	});
	it("serializes video admissions racing for the final complete output budget", async () => {
		const f = await fixture();
		const second = await createVideoQuoteRecord(
			{ ...f.input, maximumInputBytes: limits.maximumInputBytes },
			client,
		);
		const capacityLimits = { ...limits, ownerConcurrency: 2, maximumStorageBytes: 104857600n };
		const outcomes = await Promise.allSettled([
			createVideoJobRecord({ ...f.input, limits: capacityLimits }, client),
			createVideoJobRecord(
				{
					...f.input,
					quoteId: second.quoteId,
					idempotencyKey: crypto.randomUUID(),
					limits: capacityLimits,
				},
				client,
			),
		]);
		expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect(
			(outcomes.find((item) => item.status === "rejected") as PromiseRejectedResult).reason.message,
		).toBe("STORAGE_QUOTA_EXCEEDED");
		expect(
			await client.storageUsageReservation.count({
				where: { ownerId: f.ownerId, status: "ACTIVE" },
			}),
		).toBe(1);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
	});
	it("shares the owner storage lock with uploads racing for the final byte", async () => {
		const f = await fixture();
		const suffix = crypto.randomUUID();
		const outcomes = await Promise.allSettled([
			createVideoJobRecord(
				{ ...f.input, limits: { ...limits, maximumStorageBytes: 104857600n } },
				client,
			),
			createMediaUploadSessionTransaction(
				{
					ownerType: "USER",
					ownerId: f.ownerId,
					assetId: `storage-race-${suffix}`,
					sessionId: suffix,
					kind: "INPUT",
					objectKey: `input/${suffix}`,
					stagingObjectKey: `staging/${suffix}`,
					mimeType: "image/png",
					expectedBytes: 1n,
					tokenHash: suffix,
					multipartUploadId: null,
					expiresAt: new Date(Date.now() + 60_000),
					limits: { maximumActiveSessions: 5, maximumReservedBytes: 104857600n },
				},
				client,
			),
		]);
		expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect(
			(outcomes.find((item) => item.status === "rejected") as PromiseRejectedResult).reason.message,
		).toBe("STORAGE_QUOTA_EXCEEDED");
		const usage = await client.storageUsageReservation.aggregate({
			where: { ownerId: f.ownerId, status: "ACTIVE" },
			_sum: { bytes: true },
		});
		expect(usage._sum.bytes! <= 104857600n).toBe(true);
	});
	it("does not discard expired non-temporary upload/output capacity", async () => {
		const f = await fixture();
		await client.storageUsageReservation.create({
			data: {
				ownerType: "USER",
				ownerId: f.ownerId,
				referenceKey: `generation-output:${crypto.randomUUID()}`,
				bytes: 1n,
				expiresAt: new Date(0),
			},
		});
		await expect(
			createVideoJobRecord(
				{ ...f.input, limits: { ...limits, maximumStorageBytes: 104857600n } },
				client,
			),
		).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
	});
	it("same key with different prompt, ratio, or image conflicts without a second reservation", async () => {
		const { input, account } = await fixture();
		await createVideoJobRecord(input, client);
		for (const changed of [
			{ ...request, prompt: "Different prompt" },
			{ ...request, aspectRatio: "9:16" as const },
			{
				mode: "image-to-video" as const,
				prompt: request.prompt,
				duration: 5 as const,
				sound: false as const,
				inputAssetId: "other-image",
			},
		]) {
			await expect(createVideoJobRecord({ ...input, request: changed }, client)).rejects.toThrow(
				"IDEMPOTENCY_CONFLICT",
			);
		}
		await expect(
			createVideoJobRecord({ ...input, idempotencyKey: crypto.randomUUID() }, client),
		).rejects.toThrow("VIDEO_QUOTE_ALREADY_USED");
		expect(await client.creditReservation.count({ where: { accountId: account.id } })).toBe(1);
	});
	it("expired quote cannot reserve and stored quote security fields reject tampering", async () => {
		const { input, account } = await fixture();
		const expired = await quoteWithExpiry(input.quoteId, new Date(Date.now() - 1000));
		await expect(createVideoJobRecord({ ...input, quoteId: expired.id }, client)).rejects.toThrow(
			"QUOTE_EXPIRED",
		);
		await expect(
			client.generationQuote.update({ where: { id: input.quoteId }, data: { credits: 1n } }),
		).rejects.toThrow("immutable");
		expect(await client.creditReservation.count({ where: { accountId: account.id } })).toBe(0);
	});
	it("accepted replay remains stable after quote expiry", async () => {
		const { input } = await fixture();
		const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
		const shortLived = await quoteWithExpiry(input.quoteId, new Date(clock!.now.getTime() + 1000));
		const acceptedInput = { ...input, quoteId: shortLived.id };
		const first = await createVideoJobRecord(acceptedInput, client);
		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect(await createVideoJobRecord(acceptedInput, client)).toEqual({ ...first, replayed: true });
	});
	it("rejects an unaccepted old-effect retail quote but replays its accepted frozen receipt without another reservation", async () => {
		const { input, account } = await fixture();
		const original = await client.generationQuote.findUniqueOrThrow({
			where: { id: input.quoteId },
		});
		const eligibility = await resolveVideoRetailEligibility(input.ownerId, client);
		const oldPrice = {
			...input.price,
			pricingDetails: {
				retail: {
					version: "video-effect-retail-2026-10-08.1",
					eligibility,
					display: { audience: eligibility.audience },
				},
			},
		};
		const { id: _id, createdAt: _createdAt, ...fields } = original;
		const frozenQuote = {
			...fields,
			inputSnapshot: fields.inputSnapshot as never,
			pricingSnapshot: {
				...(fields.pricingSnapshot as Prisma.InputJsonObject),
				pricingDetails: oldPrice.pricingDetails,
			},
		};
		const quote = await client.generationQuote.create({
			data: {
				...frozenQuote,
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(frozenQuote),
			},
		});
		const replayInput = { ...input, quoteId: quote.id, price: oldPrice };
		await expect(createVideoJobRecord(replayInput, client)).rejects.toThrow("PRICE_CHANGED");
		expect(await client.creditReservation.count({ where: { accountId: account.id } })).toBe(0);
		expect(await client.generationJob.count({ where: { ownerId: input.ownerId } })).toBe(0);
		// Reproduce a pre-cutover acceptance with INSERTs; immutable receipts are never rewritten.
		const historical = await client.$transaction(async (tx) => {
			const job = await tx.generationJob.create({
				data: {
					ownerType: "USER",
					ownerId: input.ownerId,
					submittedByUserId: input.ownerId,
					quoteId: quote.id,
					idempotencyKey: input.idempotencyKey,
					productKey: quote.productKey,
					catalogVersion: quote.catalogVersion,
					pricingVersion: quote.pricingVersion,
					creditsReserved: quote.credits,
					executionEngine: "video-workflow-v1",
					inputSnapshot: quote.inputSnapshot as never,
					pricingSnapshot: quote.pricingSnapshot as never,
				},
			});
			await reserveCreditsInTransaction(
				{
					accountId: account.id,
					jobId: job.id,
					amount: quote.credits,
					referenceKey: `job:${job.id}:reserve`,
				},
				tx,
			);
			await tx.videoExecution.create({
				data: {
					jobId: job.id,
					workflowInstanceId: `video-v1-${job.id}`,
					modelContractVersion: quote.catalogVersion,
					stage: "QUEUED",
					startState: "PENDING",
				},
			});
			return job;
		});
		await expect(createVideoJobRecord(replayInput, client)).resolves.toEqual({
			jobId: historical.id,
			replayed: true,
		});
		expect(await client.generationJob.findUniqueOrThrow({ where: { id: historical.id } })).toEqual(
			historical,
		);
		expect(await client.creditReservation.count({ where: { accountId: account.id } })).toBe(1);
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: account.id, type: "RESERVE" } }),
		).toBe(1);
		expect(await client.videoExecution.count({ where: { jobId: historical.id } })).toBe(1);
		expect(await client.generationAttempt.count({ where: { jobId: historical.id } })).toBe(0);
	});
	it.each(["lite", "fast", "quality"] as const)(
		"replays an immutable bridge-compatible %s admission after quote expiry",
		async (veoTier) => {
			const f = await modelQuoteFixture({
				productKey: "video-veo-3-1",
				mode: "text-to-video",
				duration: 4,
				resolution: "1080p",
				aspectRatio: "16:9",
				sound: true,
				veoTier,
			});
			const futureRequest = f.input.request;
			const { veoTier: _tier, ...missingTierRequest } = futureRequest;
			expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
			// Insert a future-producer accepted fixture; never rewrite an existing immutable snapshot.
			const quote = await client.generationQuote.findUniqueOrThrow({
				where: { id: f.quote.quoteId },
			});
			const { id: _id, createdAt: _createdAt, ...fields } = quote;
			const futureVersion = "video-models-2026-10-08.1";
			const futureSnapshot = {
				...(quote.inputSnapshot as Record<string, unknown>),
				...futureRequest,
				modelContractVersion: futureVersion,
				requestFingerprint: fingerprintVideoRequest(f.ownerId, futureRequest),
				resolutionPolicy: { schemaVersion: 1, kind: "minimum-short-edge", minimumShortEdge: 1080 },
			};
			const frozen = {
				...fields,
				catalogVersion: futureVersion,
				inputSnapshot: futureSnapshot,
				expiresAt: new Date(Date.now() - 60_000),
			};
			const futureQuote = await client.generationQuote.create({
				data: {
					...frozen,
					inputSnapshot: futureSnapshot as never,
					pricingSnapshot: fields.pricingSnapshot as never,
					inputFingerprint: fingerprintGenerationQuoteSecurityPayload(frozen),
				},
			});
			const accepted = await client.$transaction(async (tx) => {
				const job = await tx.generationJob.create({
					data: {
						ownerType: "USER",
						ownerId: f.ownerId,
						submittedByUserId: f.ownerId,
						quoteId: futureQuote.id,
						idempotencyKey: f.input.idempotencyKey,
						productKey: futureQuote.productKey,
						catalogVersion: futureVersion,
						pricingVersion: futureQuote.pricingVersion,
						creditsReserved: futureQuote.credits,
						executionEngine: "video-workflow-v1",
						inputSnapshot: futureSnapshot as never,
						pricingSnapshot: futureQuote.pricingSnapshot as never,
					},
				});
				await reserveCreditsInTransaction(
					{
						accountId: f.account.id,
						jobId: job.id,
						amount: futureQuote.credits,
						referenceKey: `job:${job.id}:reserve`,
					},
					tx,
				);
				await tx.videoExecution.create({
					data: {
						jobId: job.id,
						workflowInstanceId: `video-v1-${job.id}`,
						modelContractVersion: futureVersion,
						stage: "QUEUED",
						startState: "PENDING",
					},
				});
				return job;
			});
			const replay = { ...f.input, quoteId: futureQuote.id, request: futureRequest };
			await expect(createVideoJobRecord(replay, client)).resolves.toEqual({
				jobId: accepted.id,
				replayed: true,
			});
			await expect(
				createVideoJobRecord({ ...replay, request: missingTierRequest }, client),
			).rejects.toThrow("IDEMPOTENCY_CONFLICT");
			await expect(
				createVideoJobRecord(
					{
						...replay,
						request: { ...futureRequest, veoTier: veoTier === "lite" ? "quality" : "lite" },
					},
					client,
				),
			).rejects.toThrow("IDEMPOTENCY_CONFLICT");
			expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
			expect(
				(await client.generationJob.findUniqueOrThrow({ where: { id: accepted.id } }))
					.inputSnapshot,
			).toEqual(futureSnapshot);
		},
	);
	it("freezes the full visual profile in the quote and job while accepted replay ignores a new provider", async () => {
		const { input, account } = await fixture();
		const quote = await client.generationQuote.findUniqueOrThrow({ where: { id: input.quoteId } });
		expect(quote.inputSnapshot).toMatchObject({
			visualSafetyProfile,
			textSafetyProfile: createVideoTextSafetyProfile(),
			audioSafetyPolicy: createVideoAudioSafetyPolicy(),
		});
		await expect(
			client.generationQuote.update({
				where: { id: quote.id },
				data: {
					inputSnapshot: {
						...(quote.inputSnapshot as object),
						visualSafetyProfile: createVideoVisualSafetyProfile("sightengine", 5),
					},
				},
			}),
		).rejects.toThrow("immutable");
		const accepted = await createVideoJobRecord(input, client);
		expect((await getVideoJobRecord(input.ownerId, accepted.jobId, client)).inputSnapshot).toEqual(
			quote.inputSnapshot,
		);
		await expect(
			createVideoJobRecord(
				{ ...input, visualSafetyProfile: createVideoVisualSafetyProfile("sightengine", 5) },
				client,
			),
		).resolves.toEqual({ ...accepted, replayed: true });
		expect(await client.creditReservation.count({ where: { accountId: account.id } })).toBe(1);
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: account.id, type: "RESERVE" } }),
		).toBe(1);
	});
	it("rejects provider, policy and sampling drift before any credit reservation", async () => {
		const { input, account } = await fixture();
		await expect(
			createVideoJobRecord(
				{ ...input, visualSafetyProfile: createVideoVisualSafetyProfile("sightengine", 5) },
				client,
			),
		).rejects.toThrow("VIDEO_SAFETY_PROFILE_CHANGED");
		for (const profile of [
			{ ...visualSafetyProfile, policyVersion: "unrecognized-future-policy" },
			{
				...visualSafetyProfile,
				sampling: { ...visualSafetyProfile.sampling, thresholdOffset: 1 },
			},
		])
			await expect(
				createVideoJobRecord(
					{ ...input, visualSafetyProfile: profile as typeof visualSafetyProfile },
					client,
				),
			).rejects.toThrow();
		expect(await client.creditReservation.count({ where: { accountId: account.id } })).toBe(0);
		expect(await client.creditAccount.findUnique({ where: { id: account.id } })).toMatchObject({
			spendableCredits: 100n,
			reservedCredits: 0n,
		});
	});
	it("requires explicit Waffo and not-requested audio policies for every new quote", async () => {
		const { input, account } = await fixture();
		for (const override of [
			{ textSafetyProfile: undefined },
			{ textSafetyProfile: { ...createVideoTextSafetyProfile(), semantic: "shadow" } },
			{ audioSafetyPolicy: undefined },
			{ audioSafetyPolicy: { schemaVersion: 1, mode: "required" } },
		])
			await expect(
				createVideoQuoteRecord(
					{ ...input, maximumInputBytes: limits.maximumInputBytes, ...override } as Parameters<
						typeof createVideoQuoteRecord
					>[0],
					client,
				),
			).rejects.toThrow(/SAFETY/);
		expect(await client.creditReservation.count({ where: { accountId: account.id } })).toBe(0);
	});
	it("rejects prompt or audio policy drift before reservation but preserves accepted replay", async () => {
		const { input, account } = await fixture();
		for (const override of [
			{ textSafetyProfile: undefined },
			{ textSafetyProfile: { ...createVideoTextSafetyProfile(), provider: "retired" } },
			{
				textSafetyProfile: { ...createVideoTextSafetyProfile(), ruleVersion: "future-unconfirmed" },
			},
			{ audioSafetyPolicy: undefined },
			{ audioSafetyPolicy: { schemaVersion: 1, mode: "required" } },
		])
			await expect(
				createVideoJobRecord({ ...input, ...override } as typeof input, client),
			).rejects.toThrow(/SAFETY/);
		expect(await client.creditReservation.count({ where: { accountId: account.id } })).toBe(0);
		const accepted = await createVideoJobRecord(input, client);
		await expect(
			createVideoJobRecord(
				{
					...input,
					textSafetyProfile: undefined,
					audioSafetyPolicy: undefined,
				} as unknown as typeof input,
				client,
			),
		).resolves.toEqual({ ...accepted, replayed: true });
		expect(await client.creditReservation.count({ where: { accountId: account.id } })).toBe(1);
	});
	it.each(["textSafetyProfile", "audioSafetyPolicy"] as const)(
		"requires a new quote when an unaccepted historical quote lacks %s",
		async (missingField) => {
			const { input, account } = await fixture();
			const original = await client.generationQuote.findUniqueOrThrow({
				where: { id: input.quoteId },
			});
			const { id: _id, createdAt: _at, ...fields } = original;
			const snapshot = { ...(fields.inputSnapshot as Record<string, unknown>) };
			delete snapshot[missingField];
			const legacy = {
				...fields,
				inputSnapshot: snapshot as never,
				pricingSnapshot: fields.pricingSnapshot as never,
			};
			const quote = await client.generationQuote.create({
				data: { ...legacy, inputFingerprint: fingerprintGenerationQuoteSecurityPayload(legacy) },
			});
			await expect(createVideoJobRecord({ ...input, quoteId: quote.id }, client)).rejects.toThrow(
				missingField === "textSafetyProfile"
					? "VIDEO_TEXT_SAFETY_PROFILE_CHANGED"
					: "VIDEO_AUDIO_SAFETY_POLICY_CHANGED",
			);
			expect(await client.creditReservation.count({ where: { accountId: account.id } })).toBe(0);
		},
	);
	it("cannot create a new quote through the legacy profile fallback", async () => {
		const { ownerId } = await fixture();
		await expect(
			createVideoQuoteRecord(
				{ ownerId, request, price, maximumInputBytes: limits.maximumInputBytes } as Parameters<
					typeof createVideoQuoteRecord
				>[0],
				client,
			),
		).rejects.toThrow("VIDEO_SAFETY_PROFILE_REQUIRED");
	});
	it("requires re-quoting an old profileless quote but preserves an already accepted legacy replay", async () => {
		const { input, account } = await fixture();
		const quote = await client.generationQuote.findUniqueOrThrow({ where: { id: input.quoteId } });
		const { id: _id, createdAt: _createdAt, ...fields } = quote;
		const {
			visualSafetyProfile: _profile,
			textSafetyProfile: _text,
			audioSafetyPolicy: _audio,
			...inputSnapshot
		} = quote.inputSnapshot as Record<string, unknown>;
		const legacy = { ...fields, inputSnapshot: inputSnapshot as never };
		const legacyQuote = await client.generationQuote.create({
			data: {
				...legacy,
				pricingSnapshot: fields.pricingSnapshot as never,
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(legacy),
			},
		});
		const legacyInput = { ...input, quoteId: legacyQuote.id };
		await expect(createVideoJobRecord(legacyInput, client)).rejects.toThrow(
			"VIDEO_SAFETY_PROFILE_CHANGED",
		);
		expect(await client.creditReservation.count({ where: { accountId: account.id } })).toBe(0);
		// Simulate a pre-cutover accepted row without mutating any existing snapshot.
		const historical = await client.$transaction(async (tx) => {
			const job = await tx.generationJob.create({
				data: {
					ownerType: "USER",
					ownerId: input.ownerId,
					submittedByUserId: input.ownerId,
					quoteId: legacyQuote.id,
					idempotencyKey: input.idempotencyKey,
					productKey: legacyQuote.productKey,
					catalogVersion: legacyQuote.catalogVersion,
					pricingVersion: legacyQuote.pricingVersion,
					creditsReserved: legacyQuote.credits,
					executionEngine: "video-workflow-v1",
					inputSnapshot: legacyQuote.inputSnapshot as never,
					pricingSnapshot: legacyQuote.pricingSnapshot as never,
				},
			});
			await reserveCreditsInTransaction(
				{
					accountId: account.id,
					jobId: job.id,
					amount: legacyQuote.credits,
					referenceKey: `job:${job.id}:reserve`,
				},
				tx,
			);
			await tx.videoExecution.create({
				data: {
					jobId: job.id,
					workflowInstanceId: `video-v1-${job.id}`,
					modelContractVersion: legacyQuote.catalogVersion,
					stage: "QUEUED",
					startState: "PENDING",
				},
			});
			return job;
		});
		await expect(createVideoJobRecord(legacyInput, client)).resolves.toEqual({
			jobId: historical.id,
			replayed: true,
		});
		expect(await client.creditReservation.count({ where: { accountId: account.id } })).toBe(1);
	});
	it("admits both owners beyond the retired global slot and reserves each request once", async () => {
		const first = await fixture();
		const second = await fixture();
		const outcomes = await Promise.allSettled(
			[first, second].map(({ input }) =>
				createVideoJobRecord({ ...input, limits: { ...limits, globalConcurrency: 1 } }, client),
			),
		);
		expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(2);
		expect(
			await client.creditReservation.count({
				where: { accountId: { in: [first.account.id, second.account.id] } },
			}),
		).toBe(2);
	});
	it("admits 32 different funded owners without executing provider work", async () => {
		const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
		// Seed each ledger independently; the admission race below remains concurrent.
		for (let index = 0; index < 32; index += 1) fixtures.push(await fixture());
		const outcomes = await Promise.all(
			fixtures.map(({ input }) =>
				createVideoJobRecord(
					{
						...input,
						limits: {
							...limits,
							ownerConcurrency: 1,
							globalConcurrency: 1,
							providerConcurrency: 1,
						},
					},
					client,
				),
			),
		);
		expect(outcomes.every((outcome) => !outcome.replayed)).toBe(true);
		expect(
			await client.creditReservation.count({
				where: { accountId: { in: fixtures.map(({ account }) => account.id) }, status: "ACTIVE" },
			}),
		).toBe(32);
	}, 30_000);
	it("admits two funded videos for one owner despite legacy concurrency fields", async () => {
		const { input, account } = await fixture();
		const second = await createVideoQuoteRecord(
			{
				ownerId: input.ownerId,
				request,
				price,
				visualSafetyProfile,
				textSafetyProfile: createVideoTextSafetyProfile(),
				audioSafetyPolicy: createVideoAudioSafetyPolicy(),
				maximumInputBytes: limits.maximumInputBytes,
			},
			client,
		);
		const outcomes = await Promise.all(
			[input, { ...input, quoteId: second.quoteId, idempotencyKey: crypto.randomUUID() }].map(
				(entry) =>
					createVideoJobRecord(
						{
							...entry,
							limits: {
								...limits,
								ownerConcurrency: 1,
								globalConcurrency: 1,
								providerConcurrency: 1,
								maximumStorageBytes: BigInt(VIDEO_OUTPUT_MAX_BYTES) * 3n,
							},
						},
						client,
					),
			),
		);
		expect(outcomes.every((outcome) => !outcome.replayed)).toBe(true);
		expect(
			await client.creditReservation.count({ where: { accountId: account.id, status: "ACTIVE" } }),
		).toBe(2);
		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: account.id } }),
		).toMatchObject({ reservedCredits: 14n, spendableCredits: 86n });
	});

	it("same owner racing the final credits cannot overspend or retain a losing reservation", async () => {
		const { input, account } = await fixture(7n);
		const second = await createVideoQuoteRecord(
			{
				ownerId: input.ownerId,
				request,
				price,
				visualSafetyProfile,
				textSafetyProfile: createVideoTextSafetyProfile(),
				audioSafetyPolicy: createVideoAudioSafetyPolicy(),
				maximumInputBytes: limits.maximumInputBytes,
			},
			client,
		);
		const outcomes = await Promise.allSettled(
			[input, { ...input, quoteId: second.quoteId, idempotencyKey: crypto.randomUUID() }].map(
				(entry) =>
					createVideoJobRecord(
						{
							...entry,
							limits: { ...limits, maximumStorageBytes: BigInt(VIDEO_OUTPUT_MAX_BYTES) * 3n },
						},
						client,
					),
			),
		);
		expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.find((result) => result.status === "rejected")).toMatchObject({
			reason: { message: "INSUFFICIENT_CREDITS" },
		});
		expect(await client.creditAccount.findUnique({ where: { id: account.id } })).toMatchObject({
			reservedCredits: 7n,
			spendableCredits: 0n,
		});
		expect(await client.creditReservation.count({ where: { accountId: account.id } })).toBe(1);
	});
	it("quotes bind only sealed owned images and detect later content changes", async () => {
		const { ownerId, account } = await fixture();
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "VERIFYING",
				verificationEngine: "video-workflow-v1",
				objectKey: `test/${crypto.randomUUID()}.png`,
				mimeType: "image/png",
				byteSize: 100n,
				width: 100,
				height: 100,
				checksum: "a".repeat(64),
				finalizedAt: new Date(),
			},
		});
		const imageRequest = {
			mode: "image-to-video" as const,
			prompt: request.prompt,
			duration: 5 as const,
			sound: false as const,
			inputAssetId: asset.id,
		};
		await expect(
			createVideoQuoteRecord(
				{
					ownerId: "other-owner",
					request: imageRequest,
					price,
					visualSafetyProfile,
					textSafetyProfile: createVideoTextSafetyProfile(),
					audioSafetyPolicy: createVideoAudioSafetyPolicy(),
					maximumInputBytes: limits.maximumInputBytes,
				},
				client,
			),
		).rejects.toThrow("VIDEO_INPUT_NOT_AVAILABLE");
		const quote = await createVideoQuoteRecord(
			{
				ownerId,
				request: imageRequest,
				price,
				visualSafetyProfile,
				textSafetyProfile: createVideoTextSafetyProfile(),
				audioSafetyPolicy: createVideoAudioSafetyPolicy(),
				maximumInputBytes: limits.maximumInputBytes,
			},
			client,
		);
		expect(await client.generationQuote.findUnique({ where: { id: quote.quoteId } })).toMatchObject(
			{ moderationDecision: "PENDING_VIDEO_WORKFLOW" },
		);
		await client.mediaAsset.update({ where: { id: asset.id }, data: { checksum: "b".repeat(64) } });
		await expect(
			createVideoJobRecord(
				{
					ownerId,
					quoteId: quote.quoteId,
					idempotencyKey: crypto.randomUUID(),
					request: imageRequest,
					price,
					visualSafetyProfile,
					textSafetyProfile: createVideoTextSafetyProfile(),
					audioSafetyPolicy: createVideoAudioSafetyPolicy(),
					limits,
				},
				client,
			),
		).rejects.toThrow("ASSET_CONTENT_CHANGED");
		expect(await client.creditReservation.count({ where: { accountId: account.id } })).toBe(0);
	});
	it("reads and pagination remain owner scoped, including cursor ownership", async () => {
		const first = await fixture();
		const second = await fixture();
		const created = await createVideoJobRecord(first.input, client);
		await expect(getVideoJobRecord(second.ownerId, created.jobId, client)).rejects.toThrow(
			"NOT_FOUND",
		);
		await expect(
			listVideoJobRecords(second.ownerId, { cursor: created.jobId }, client),
		).rejects.toThrow("NOT_FOUND");
		expect(
			(await listVideoJobRecords(first.ownerId, { limit: 20 }, client)).rows.map((row) => row.id),
		).toEqual([created.jobId]);
	});
	it("Unicode prompt normalization fingerprints trimmed equivalent requests identically", () => {
		expect(fingerprintVideoRequest("owner", { ...request, prompt: `  ${request.prompt}  ` })).toBe(
			fingerprintVideoRequest("owner", request),
		);
	});
	it("multi-model quotes bind every selected option and preserve the chosen public product", async () => {
		const f = await fixture();
		const selection = { ...request, productKey: "video-kling-2-6-v1", resolution: "default" };
		const multiPrice = {
			...price,
			pricingDetails: { creditFloorMicros: "21944", costPolicy: { version: "fixture-1" } },
		};
		const quote = await createVideoQuoteRecord(
			{
				ownerId: f.ownerId,
				request: selection,
				price: multiPrice,
				visualSafetyProfile,
				textSafetyProfile: createVideoTextSafetyProfile(),
				audioSafetyPolicy: createVideoAudioSafetyPolicy(),
				maximumInputBytes: limits.maximumInputBytes,
			},
			client,
		);
		const input = { ...f.input, quoteId: quote.quoteId, request: selection, price: multiPrice };
		await expect(
			createVideoJobRecord({ ...input, request: { ...selection, duration: 10 } }, client),
		).rejects.toThrow("VIDEO_QUOTE_INPUT_MISMATCH");
		await expect(
			createVideoJobRecord({ ...input, request: { ...selection, sound: true } }, client),
		).rejects.toThrow("VIDEO_QUOTE_INPUT_MISMATCH");
		await expect(
			createVideoJobRecord(
				{ ...input, price: { ...multiPrice, pricingDetails: { creditFloorMicros: "1" } } },
				client,
			),
		).rejects.toThrow("PRICE_CHANGED");
		const accepted = await createVideoJobRecord(input, client);
		const stored = await getVideoJobRecord(f.ownerId, accepted.jobId, client);
		expect(stored.productKey).toBe(selection.productKey);
		expect(stored.inputSnapshot).toMatchObject(selection);
		expect(stored.pricingSnapshot).toMatchObject({ pricingDetails: multiPrice.pricingDetails });
		await expect(createVideoJobRecord(input, client)).resolves.toEqual({
			jobId: accepted.jobId,
			replayed: true,
		});
		await expect(
			createVideoJobRecord({ ...input, request: { ...selection, duration: 10 } }, client),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
	});
	it.each(modelModeSelections)(
		"persists pending quote and admission for implemented $productKey $mode",
		async (selection) => {
			const f = await modelQuoteFixture(selection);
			const quote = await client.generationQuote.findUniqueOrThrow({
				where: { id: f.quote.quoteId },
			});
			expect(quote).toMatchObject({
				productKey: selection.productKey,
				catalogVersion: VIDEO_MODEL_CATALOG_VERSION,
				moderationDecision: "PENDING_VIDEO_WORKFLOW",
				moderationProvider: "video-workflow-v1",
				moderationReasonCode: "PENDING_VIDEO_WORKFLOW",
			});
			expect(quote.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
			const accepted = await createVideoJobRecord(f.input, client);
			expect(
				await client.generationJob.findUnique({ where: { id: accepted.jobId } }),
			).toMatchObject({
				productKey: selection.productKey,
				executionEngine: "video-workflow-v1",
				inputSnapshot: selection,
			});
			expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
			await expect(createVideoJobRecord(f.input, client)).resolves.toEqual({
				...accepted,
				replayed: true,
			});
		},
	);
	it("Seedance Mini 4s 480p silent quote admits through the real pending-evidence constraint", async () => {
		const selection = {
			productKey: "video-seedance-2-mini",
			mode: "text-to-video" as const,
			duration: 4,
			resolution: "480p",
			aspectRatio: "16:9",
			sound: false,
		};
		const f = await modelQuoteFixture(selection);
		const accepted = await createVideoJobRecord(f.input, client);
		expect(await client.generationJob.findUnique({ where: { id: accepted.jobId } })).toMatchObject({
			productKey: selection.productKey,
			inputSnapshot: selection,
			creditsReserved: price.credits,
		});
	});
	it("refuses a new retired Seedance 1.5 quote before creating a job or reserving credits", async () => {
		const f = await fixture();
		await expect(
			createVideoQuoteRecord(
				{
					...f.input,
					request: {
						...request,
						productKey: "video-seedance-1-5-pro",
						duration: 4,
						resolution: "480p",
					},
					maximumInputBytes: limits.maximumInputBytes,
				},
				client,
			),
		).rejects.toThrow("VIDEO_MODEL_SELECTION_UNSUPPORTED");
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
		expect(await client.creditAccount.findUnique({ where: { id: f.account.id } })).toMatchObject({
			spendableCredits: 100n,
			reservedCredits: 0n,
		});
	});
	it("Veo 3.1 Fast 4s 720p native-audio quote admits and reserves only once", async () => {
		const selection = {
			productKey: "video-veo-3-1-fast",
			mode: "text-to-video" as const,
			duration: 4,
			resolution: "720p",
			aspectRatio: "16:9",
			sound: true,
		};
		const f = await modelQuoteFixture(selection);
		expect(
			await client.generationQuote.findUnique({ where: { id: f.quote.quoteId } }),
		).toMatchObject({
			productKey: selection.productKey,
			catalogVersion: VIDEO_MODEL_CATALOG_VERSION,
			moderationDecision: "PENDING_VIDEO_WORKFLOW",
			moderationProvider: "video-workflow-v1",
			moderationReasonCode: "PENDING_VIDEO_WORKFLOW",
			inputSnapshot: selection,
		});
		const accepted = await createVideoJobRecord(f.input, client);
		expect(await client.generationJob.findUnique({ where: { id: accepted.jobId } })).toMatchObject({
			productKey: selection.productKey,
			executionEngine: "video-workflow-v1",
			inputSnapshot: selection,
			creditsReserved: price.credits,
		});
		await expect(createVideoJobRecord(f.input, client)).resolves.toEqual({
			...accepted,
			replayed: true,
		});
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
		expect(await client.creditAccount.findUnique({ where: { id: f.account.id } })).toMatchObject({
			spendableCredits: 100n - price.credits,
			reservedCredits: price.credits,
		});
	});
	it.each([
		{ label: "image product", productKey: "image-gpt-image-1-5" },
		{ label: "unknown video", productKey: "video-not-implemented" },
		...VIDEO_MODEL_CATALOG.filter((model) => model.status === "blocked").map((model) => ({
			label: model.productKey,
			productKey: model.productKey,
		})),
	])("database rejects pending-video evidence for $label", async ({ productKey }) => {
		const f = await fixture();
		await expect(insertQuoteEvidenceVariant(f.quote.quoteId, { productKey })).rejects.toThrow(
			"generation_quote_moderation_decision_check",
		);
	});
	it.each([
		{ label: "wrong provider", moderationProvider: "legacy" },
		{ label: "wrong reason", moderationReasonCode: "ALLOW" },
		{ label: "short fingerprint", inputFingerprint: "a".repeat(63) },
		{ label: "non-hex fingerprint", inputFingerprint: "g".repeat(64) },
	])(
		"database preserves pending-video $label evidence rejection",
		async ({ label: _label, ...evidence }) => {
			const f = await fixture();
			await expect(
				insertQuoteEvidenceVariant(f.quote.quoteId, {
					productKey: "video-seedance-1-5-pro",
					...evidence,
				}),
			).rejects.toThrow("generation_quote_moderation_decision_check");
		},
	);
	it("preserves image ALLOW, BYPASS and legacy decisions and their independent fingerprint guards", async () => {
		const f = await fixture();
		for (const moderationDecision of ["ALLOW", "BYPASS", "LEGACY_UNREVIEWED"]) {
			const evidence = {
				productKey: "image-gpt-image-1-5",
				moderationDecision,
				moderationProvider: "legacy",
				moderationReasonCode:
					moderationDecision === "BYPASS"
						? "MODERATION_TECHNICAL_FAILURE_BYPASS"
						: moderationDecision,
				inputFingerprint: moderationDecision === "LEGACY_UNREVIEWED" ? "" : "a".repeat(64),
			};
			await expect(insertQuoteEvidenceVariant(f.quote.quoteId, evidence)).resolves.toBe(1);
			if (moderationDecision !== "LEGACY_UNREVIEWED") {
				await expect(
					insertQuoteEvidenceVariant(f.quote.quoteId, { ...evidence, inputFingerprint: "" }),
				).rejects.toThrow(
					moderationDecision === "ALLOW"
						? "generation_quote_approved_fingerprint_check"
						: "generation_quote_bypass_fingerprint_check",
				);
			}
		}
	});
});
