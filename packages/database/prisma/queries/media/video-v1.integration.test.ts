import { PrismaPg } from "@prisma/adapter-pg";
import { createVideoAudioSafetyPolicy } from "@repo/config/video-output";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { createCreditGrant, releaseCredits, reserveCreditsInTransaction } from "./credits";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";
import {
	createVideoJobRecord,
	createVideoQuoteRecord,
	getVideoJobRecord,
	listVideoJobRecords,
	fingerprintVideoRequest,
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
	maximumStorageBytes: 100_000_000n,
	maximumInputBytes: 10_000_000,
};

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
	const paidFundingPolicy = { minimumUsdMicrosPerCredit: 21_944n };
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
		await expect(createVideoJobRecord({ ...f.input, paidFundingPolicy }, client)).rejects.toThrow(
			"INSUFFICIENT_PAID_CREDITS",
		);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
	});
	it("legacy Stripe invoice minor units are converted once to micro-USD", async () => {
		const f = await fixture();
		await paidSubscriptionGrant(f.ownerId, f.account.id, { paid: 300n, stripeMinorUnits: true });
		await expect(
			createVideoJobRecord({ ...f.input, paidFundingPolicy }, client),
		).resolves.toMatchObject({ replayed: false });
	});
	it("credit pack bonus credits reduce the revenue per entire grant", async () => {
		const low = await fixture();
		await paidPackGrant(low.ownerId, low.account.id, 100n);
		await expect(createVideoJobRecord({ ...low.input, paidFundingPolicy }, client)).rejects.toThrow(
			"INSUFFICIENT_PAID_CREDITS",
		);
		const valid = await fixture();
		await paidPackGrant(valid.ownerId, valid.account.id, 20n);
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
		expect(await client.outboxEvent.count({ where: { aggregateId: jobId } })).toBe(0);
		expect(await client.videoExecution.findUnique({ where: { jobId } })).toMatchObject({
			workflowInstanceId: `video-v1-${jobId}`,
			startState: "PENDING",
			stage: "QUEUED",
		});
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
});
