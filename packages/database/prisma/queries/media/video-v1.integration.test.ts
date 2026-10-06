import { PrismaPg } from "@prisma/adapter-pg";
import { applyVideoInternalFunding } from "@repo/config/video-internal-funding";
import {
	VIDEO_MODEL_CATALOG,
	VIDEO_MODEL_CATALOG_VERSION,
	type VideoModelSelection,
} from "@repo/config/video-models";
import { createVideoAudioSafetyPolicy } from "@repo/config/video-output";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { createMediaUploadSessionTransaction } from "./assets";
import {
	createCreditGrant,
	releaseCredits,
	reserveCreditsInTransaction,
	settleCredits,
} from "./credits";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";
import { getVideoTemplateCreditBalance } from "./video-template-credits";
import {
	createVideoJobRecord,
	createVideoQuoteRecord,
	getVideoJobRecord,
	listVideoJobRecords,
	fingerprintVideoRequest,
	type VideoPrice,
} from "./video-v1";

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
	(model) => model.status === "implemented",
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
		// Other serial integration suites retain active image fixtures. Preserve their
		// shared Kie occupancy while giving this suite exactly five additional slots.
		limits.providerConcurrency =
			(await client.generationJob.count({
				where: {
					executionEngine: "legacy",
					terminalAt: null,
					status: { notIn: ["SUCCEEDED", "FAILED", "CANCELED"] },
				},
			})) + 5;
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
	afterAll(async () => client?.$disconnect());
	async function fixture(credits = 100n) {
		const ownerId = `video-admission-test-${crypto.randomUUID()}`;
		owners.push(ownerId);
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
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
	const paidFundingPolicy = { minimumUsdMicrosPerCredit: 21_944n };
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
				priceMicros: 3_000_000n,
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
	it("two owners racing the final global slot leave one reservation", async () => {
		const first = await fixture();
		const second = await fixture();
		const outcomes = await Promise.allSettled(
			[first, second].map(({ input }) =>
				createVideoJobRecord({ ...input, limits: { ...limits, globalConcurrency: 1 } }, client),
			),
		);
		expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(
			await client.creditReservation.count({
				where: { accountId: { in: [first.account.id, second.account.id] } },
			}),
		).toBe(1);
	});
	it("same owner racing the final credits/slot cannot overspend or retain a losing reservation", async () => {
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
				(entry) => createVideoJobRecord(entry, client),
			),
		);
		expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
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
	it("Seedance 1.5 Pro 4s 480p silent quote admits through the real pending-evidence constraint", async () => {
		const selection = {
			productKey: "video-seedance-1-5-pro",
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
