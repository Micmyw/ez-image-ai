import { call } from "@orpc/server";
import { PrismaPg } from "@prisma/adapter-pg";
import {
	VIDEO_EFFECT_RETAIL_PRICE_VERSION,
	HOTEL_LOBBY_LONG_TEMPLATE_VERSION,
	RAINDANCE_LONG_TEMPLATE_VERSION,
} from "@repo/config/video-effects";
import {
	HOTEL_LOBBY_PRICE_VERSION,
	HOTEL_LOBBY_TEMPLATE_VERSION,
	RAINDANCE_TEMPLATE_VERSION,
	HOTEL_LOBBY_SAFETY_POLICY_VERSION,
} from "@repo/config/video-effects.server";
import { VIDEO_MODEL_CATALOG_VERSION } from "@repo/config/video-models";
import {
	VIDEO_RETAIL_PRICE_VERSION,
	VIDEO_SUPPLIER_PRICE_VERSION,
} from "@repo/config/video-pricing.server";
import {
	createCreditGrant,
	releaseCredits,
	fingerprintGenerationQuoteSecurityPayload,
} from "@repo/database";
import { runWithDatabaseClient } from "@repo/database/client";
import { PrismaClient } from "@repo/database/generated-client";
import { resolveVideoRetailEligibility } from "@repo/database/video-retail-eligibility";
import { createVideoTemplateJobRecord } from "@repo/database/video-template";
import { createVideoJobRecord } from "@repo/database/video-v1";
import { requireVideoAdmission } from "@repo/jobs/video-v1/admission";
import { requireVideoTemplateAdmission } from "@repo/jobs/video-v1/template-admission";
import { applyStripeBillingFact } from "@repo/payments";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { isExplicitVideoVerificationTarget } from "../../../../tests/load/video-verification-target";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/jobs/video-v1/workflow-binding", () => ({
	getVideoWorkflowBinding: () => undefined,
	getVideoWorkflowReadinessBindings: () => ({
		workflow: true,
		r2: true,
		hyperdrive: true,
		uploadCors: true,
	}),
}));
import { auth } from "@repo/auth";

import { videoEffectsRouter } from "../video-effects/router";
import { videoV1Router } from "./router";

// Entirely synthetic billing, provider and safety evidence; no external requests.
const environment = {
	VIDEO_V1_ENABLED: "true",
	VIDEO_V1_ACCESS: "authenticated",
	MEDIA_GENERATION_ENABLED: "true",
	KIE_API_KEY: "fixture-only",
	KIE_WEBHOOK_SECRET: "fixture-only",
	NEXT_PUBLIC_SAAS_URL: "https://video.example.test",
	VIDEO_V1_CALLBACK_BASE_URL: "https://video.example.test",
	VIDEO_V1_MODERATION_CALLBACK_CONFIGURED: "true",
	VIDEO_V1_MODERATION_WEBHOOK_SECRET: "casec_fixture-only",
	VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
	VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
	VIDEO_V1_IMAGE_SAFETY_ADAPTER: "seeapi",
	VIDEO_COST_VISUAL_POLICY_VERSION: "seeapi-video-policy-2026-10-04.1",
	VIDEO_COST_TEXT_RULE_VERSION: "waffo-prompt-safety-2026-10-04.1",
	SEEAPI_API_KEY: "fixture-only",
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
		whkey_test: "whsec_local_test_signing_secret_20261004",
	}),
	VIDEO_SEEAPI_CALLBACK_SECRET: "local-video-seeapi-callback-secret-20261004",
	WAFFO_MERCHANT_ID: "fixture-only",
	WAFFO_PRIVATE_KEY: "fixture-only",
	VIDEO_V1_PROVIDER_CONCURRENCY: "5",
	VIDEO_V1_OUTPUT_ALLOWED_HOSTS: "cdn.example.test",
	VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
	VIDEO_RETAIL_PRICE_ACCEPTED_VERSION: VIDEO_RETAIL_PRICE_VERSION,
	VIDEO_PRICE_BASIS: "HISTORICAL_RETAIL_TEST_BUDGET_ONLY",
	VIDEO_PRICE_VALID_UNTIL: "none",
	VIDEO_COST_MODERATION_BASE_MICROS: "5100",
	VIDEO_COST_MODERATION_PER_SECOND_MICROS: "200",
	VIDEO_COST_RUNTIME_MICROS: "100000",
	VIDEO_COST_STORAGE_MICROS: "10000",
	VIDEO_COST_PAYMENT_FIXED_MICROS: "0",
	VIDEO_COST_PAYMENT_FEE_BPS: "654",
	VIDEO_COST_NONBILLABLE_FAILURE_BPS: "1000",
};
const request = {
	productKey: "video-seedance-2-mini",
	mode: "text-to-video" as const,
	prompt: "A sailboat crosses a calm lake",
	duration: 5,
	resolution: "720p",
	aspectRatio: "16:9",
	sound: false,
};
const ctx = { context: { headers: new Headers() } };
const bindings = { workflow: true, r2: true, hyperdrive: true, uploadCors: true };
let client: PrismaClient;
let ownerId: string;
let accountId: string;
let subscriptionId: string;
let planId: string;
let periodId: string;
const periodEnd = () => new Date(Date.now() + 86_400_000);
function signIn(id: string) {
	vi.mocked(auth.api.getSession).mockResolvedValue({
		user: { id, role: "user", isAnonymous: false },
		session: { id: "test-session" },
	} as never);
}
beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url || !isExplicitVideoVerificationTarget(new URL(url)))
		throw new Error("ISOLATED_VIDEO_TEST_DATABASE_REQUIRED");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
});
beforeEach(async () => {
	for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
	ownerId = `retail-pricing-test-${crypto.randomUUID()}`;
	signIn(ownerId);
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	accountId = account.id;
	const id = crypto.randomUUID();
	const plan = await client.billingPlan.create({
		data: {
			provider: "paypal",
			providerPriceId: id,
			name: "Creator annual fixture",
			creditsPerPeriod: 1000n,
			priceMicros: 300_000_000n,
			currency: "USD",
			metadata: { planId: "creator", interval: "year" },
		},
	});
	planId = plan.id;
	const subscription = await client.subscription.create({
		data: {
			ownerType: "USER",
			ownerId,
			provider: "paypal",
			providerSubscriptionId: id,
			planId,
			status: "ACTIVE",
			currentPeriodStart: new Date(Date.now() - 1000),
			currentPeriodEnd: periodEnd(),
		},
	});
	subscriptionId = subscription.id;
	const referenceKey = `paypal-payment:${id}:period:0:grant`;
	const period = await client.billingPeriod.create({
		data: {
			subscriptionId,
			startsAt: new Date(Date.now() - 1000),
			endsAt: periodEnd(),
			status: "ACTIVE",
			creditAmount: 1000n,
			grantReferenceKey: referenceKey,
			providerInvoiceId: id,
			providerInvoicePaymentId: `paypal:${id}`,
			paidAmount: 300_000_000n,
			refundedAmount: 0n,
		},
	});
	periodId = period.id;
	await createCreditGrant({ accountId, amount: 1000n, referenceKey }, client);
});
afterEach(async () => {
	for (const reservation of await client.creditReservation.findMany({
		where: { accountId, status: "ACTIVE" },
	}))
		await releaseCredits(
			{
				reservationId: reservation.id,
				amount: reservation.amount,
				referenceKey: `cleanup:${reservation.id}`,
			},
			client,
		);
	await client.videoExecution.updateMany({
		where: { job: { ownerId } },
		data: { stage: "FAILED" },
	});
	await client.generationJob.updateMany({
		where: { ownerId },
		data: { status: "FAILED", terminalAt: new Date() },
	});
	vi.unstubAllEnvs();
});
afterAll(async () => {
	await client?.$disconnect();
});
const scoped = <T>(action: () => Promise<T>) => runWithDatabaseClient(client, action);
const quote = () => scoped(() => call(videoV1Router.quote, request, ctx));
async function create(quoteId: string, idempotencyKey = crypto.randomUUID()) {
	return scoped(() => call(videoV1Router.jobs.create, { request, quoteId, idempotencyKey }, ctx));
}

async function addPaidPackBalance() {
	const id = crypto.randomUUID();
	const grantReferenceKey = `credit-pack:${id}:grant:v1`;
	const plan = await client.billingPlan.create({
		data: {
			provider: "paypal",
			providerPriceId: id,
			name: "ISOLATED_PAID_PACK_FIXTURE",
			productKind: "CREDIT_PACK",
			creditsPerPeriod: 1000n,
			priceMicros: 100_000_000n,
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
			creditPackBaseCredits: 1000n,
			creditPackBonusCredits: 0n,
			creditPackTotalCredits: 1000n,
			creditPackExpiryMonths: 6,
			creditPackSubscriberBonusEligible: false,
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
			paidAmountMicros: 100_000_000n,
			currency: "USD",
			baseCredits: 1000n,
			bonusCredits: 0n,
			grantedCredits: 1000n,
			grantReferenceKey,
			paidAt: new Date(),
			expiresAt: periodEnd(),
		},
	});
	await createCreditGrant(
		{ accountId, amount: 1000n, referenceKey: grantReferenceKey, expiresAt: periodEnd() },
		client,
	);
	return grantReferenceKey;
}

describe("ordinary and annual video pricing through protected RPC and PostgreSQL", () => {
	it("uses one owner-scoped qualification for catalog and quote; exposes only public prices", async () => {
		const catalog = await scoped(() => call(videoV1Router.catalog, undefined, ctx));
		const option = catalog.models
			.find((model) => model.productKey === request.productKey)!
			.options.find(
				(option) =>
					option.mode === request.mode &&
					option.duration === 5 &&
					option.resolution === "720p" &&
					!option.sound,
			)!;
		const quoted = await quote();
		expect(option.credits).toBe("66");
		expect(quoted.credits).toBe("66");
		expect(quoted.pricing).toEqual(option.pricing);
		expect(catalog.pricingValidUntil).toBe(
			(
				await client.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })
			).currentPeriodEnd!.toISOString(),
		);
		expect(quoted.pricing).toMatchObject({
			audience: "annual",
			standardCredits: "96",
			annualCredits: "66",
			savedCredits: "30",
		});
		expect(JSON.stringify(catalog)).not.toMatch(/subscriptionId|providerCost|MarkupBps|costPolicy/);
		signIn(`other-${ownerId}`);
		const other = await quote();
		expect(other.credits).toBe("96");
		expect(other.pricing?.audience).toBe("standard");
		await expect(create(quoted.quoteId)).rejects.toThrow("INVALID_VIDEO_QUOTE");
	});
	it.each([
		"month",
		"missing",
		"unknown-plan",
		"pack",
		"unpaid",
		"pending",
		"expired",
		"refunded",
		"refund-pending",
		"other-owner",
	])("does not infer annual access from %s", async (kind) => {
		if (kind === "month" || kind === "missing" || kind === "unknown-plan")
			await client.billingPlan.update({
				where: { id: planId },
				data: {
					metadata:
						kind === "missing"
							? { planId: "creator" }
							: {
									planId: kind === "unknown-plan" ? "free" : "creator",
									interval: kind === "month" ? "month" : "year",
								},
				},
			});
		if (kind === "pack")
			await client.billingPlan.update({
				where: { id: planId },
				data: { productKind: "CREDIT_PACK" },
			});
		if (kind === "unpaid")
			await client.billingPeriod.update({ where: { id: periodId }, data: { paidAmount: 0n } });
		if (kind === "pending")
			await client.subscription.update({
				where: { id: subscriptionId },
				data: { status: "PENDING" },
			});
		if (kind === "expired")
			await client.subscription.update({
				where: { id: subscriptionId },
				data: { currentPeriodEnd: new Date(0) },
			});
		if (kind === "refunded")
			await client.billingPeriod.update({
				where: { id: periodId },
				data: { refundedAmount: 300_000_000n },
			});
		if (kind === "refund-pending")
			await client.subscription.update({
				where: { id: subscriptionId },
				data: { refundTerminationRequestedAt: new Date() },
			});
		if (kind === "other-owner")
			await client.subscription.update({
				where: { id: subscriptionId },
				data: { ownerType: "ORGANIZATION" },
			});
		expect((await quote()).credits).toBe("96");
	});
	it("retains paid canceled and valid grace terms, then expires at the exact server boundary", async () => {
		await client.subscription.update({
			where: { id: subscriptionId },
			data: { status: "CANCELED" },
		});
		expect((await quote()).credits).toBe("66");
		const end = periodEnd();
		await client.subscription.update({
			where: { id: subscriptionId },
			data: { status: "PAST_DUE", graceEndsAt: end },
		});
		expect((await quote()).credits).toBe("66");
		expect(
			(await resolveVideoRetailEligibility(ownerId, client, new Date(end.getTime() - 1))).audience,
		).toBe("annual");
		expect((await resolveVideoRetailEligibility(ownerId, client, end)).audience).toBe("standard");
	});
	it.each([
		{ fullRefund: true, status: "ACTIVE" as const },
		{ fullRefund: false, status: "ACTIVE" as const },
		{ fullRefund: true, status: "PAST_DUE" as const },
		{ fullRefund: false, status: "PAST_DUE" as const },
	])(
		"uses the real Stripe annual payment/refund in month two with paid-pack funding ($status, full: $fullRefund)",
		async ({ fullRefund, status }) => {
			const now = new Date();
			const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
			const month = (offset: number) =>
				new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1));
			const invoiceId = `stripe_annual_${crypto.randomUUID()}`;
			const chargeId = `ch_${crypto.randomUUID()}`;
			const customerId = `cus_${crypto.randomUUID()}`;
			const providerSubscriptionId = `sub_${crypto.randomUUID()}`;
			await client.user.create({
				data: {
					id: ownerId,
					name: "Annual refund video fixture",
					email: `${ownerId}@example.test`,
					emailVerified: true,
					paymentsCustomerId: customerId,
					createdAt: now,
					updatedAt: now,
				},
			});
			const plan = await client.billingPlan.update({
				where: { id: planId },
				data: { provider: "stripe" },
			});
			const purchase = await client.purchase.create({
				data: {
					userId: ownerId,
					type: "SUBSCRIPTION",
					customerId,
					subscriptionId: providerSubscriptionId,
					priceId: plan.providerPriceId,
					status: "active",
				},
			});
			await client.billingPeriod.delete({ where: { id: periodId } });
			await client.subscription.update({
				where: { id: subscriptionId },
				data: {
					provider: "stripe",
					providerSubscriptionId,
					purchaseId: purchase.id,
					currentPeriodStart: null,
					currentPeriodEnd: null,
				},
			});
			const paidInvoice = {
				kind: "PAID_INVOICE",
				billingReason: "SUBSCRIPTION_CYCLE",
				providerInvoiceId: invoiceId,
				providerSubscriptionId,
				customerId,
				providerInvoicePaymentId: `ip_${invoiceId}`,
				providerChargeId: chargeId,
				providerPaymentIntentId: null,
				priceId: plan.providerPriceId,
				amountPaid: 30_000n,
				currency: "USD",
				periodStart: start,
				periodEnd: month(12),
				context: { origin: "WEBHOOK", changeAt: start, changeId: `evt_${crypto.randomUUID()}` },
			} as const;
			// The actual reducer creates 12 projections and grants the relevant month.
			// Replay in month two is the supported reconciliation path as time advances.
			for (const operationNow of [new Date(start.getTime() + 1000), now]) {
				await client.$transaction((tx) =>
					applyStripeBillingFact(paidInvoice, tx, { now: operationNow }),
				);
			}
			expect(await client.billingPeriod.count({ where: { subscriptionId } })).toBe(12);
			const packReference = await addPaidPackBalance();
			const quotedBeforeRefund = await quote();
			expect(quotedBeforeRefund.credits).toBe("66");
			const acceptedQuote = await quote();
			const acceptedKey = crypto.randomUUID();
			const accepted = await create(acceptedQuote.quoteId, acceptedKey);
			await client.$transaction((tx) =>
				applyStripeBillingFact(
					{
						kind: "REFUND",
						providerRefundId: `re_${crypto.randomUUID()}`,
						providerChargeId: chargeId,
						providerPaymentIntentId: null,
						amount: fullRefund ? 30_000n : 15_000n,
						currency: "USD",
						status: "SUCCEEDED",
						providerCreatedAt: now,
						context: { origin: "WEBHOOK", changeAt: now, changeId: `evt_${crypto.randomUUID()}` },
					},
					tx,
					{ now },
				),
			);
			const currentPeriod = await client.billingPeriod.findUniqueOrThrow({
				where: { subscriptionId_startsAt: { subscriptionId, startsAt: month(1) } },
			});
			expect(currentPeriod).toMatchObject({
				status: "REFUNDED",
				refundedAmount: 0n,
				paidAmount: 30_000n,
			});
			if (status === "PAST_DUE")
				await client.subscription.update({
					where: { id: subscriptionId },
					data: { status, graceEndsAt: periodEnd() },
				});
			const refreshedCatalog = await scoped(() => call(videoV1Router.catalog, undefined, ctx));
			const option = refreshedCatalog.models
				.find((model) => model.productKey === request.productKey)!
				.options.find(
					(option) =>
						option.mode === request.mode &&
						option.duration === request.duration &&
						option.resolution === request.resolution &&
						!option.sound,
				)!;
			const repriced = await quote();
			expect(repriced.credits).toBe(fullRefund ? "96" : "66");
			expect(repriced.pricing?.audience).toBe(fullRefund ? "standard" : "annual");
			expect(option.pricing).toEqual(repriced.pricing);
			if (fullRefund) {
				await expect(create(quotedBeforeRefund.quoteId)).rejects.toThrow("PRICE_CHANGED");
			}
			const replayed = await create(acceptedQuote.quoteId, acceptedKey);
			expect(replayed.jobId).toBe(accepted.jobId);
			expect(replayed.pricing).toEqual(acceptedQuote.pricing);
			expect(await client.creditLedgerEntry.count({ where: { accountId, type: "RESERVE" } })).toBe(
				1,
			);
			await client.generationJob.update({
				where: { id: accepted.jobId },
				data: { status: "FAILED", terminalAt: now },
			});
			await client.videoExecution.updateMany({
				where: { jobId: accepted.jobId },
				data: { stage: "FAILED" },
			});
			const next = await create(repriced.quoteId);
			expect(next.credits).toBe(fullRefund ? "96" : "66");
			const pack = await client.creditLot.findFirstOrThrow({
				where: { accountId, grantReferenceKey: packReference },
			});
			expect(pack.remainingAmount).toBeLessThan(1000n);
			expect(pack.remainingAmount).toBeGreaterThan(0n);
		},
	);
	it("requotes an unaccepted price after qualification changes without reserving credits", async () => {
		const quoted = await quote();
		await client.subscription.update({
			where: { id: subscriptionId },
			data: { status: "EXPIRED" },
		});
		await expect(create(quoted.quoteId)).rejects.toThrow("PRICE_CHANGED");
		expect(await client.creditReservation.count({ where: { accountId } })).toBe(0);
		expect((await quote()).credits).toBe("96");
	});
	it("freezes annual evidence and saved credits; parallel duplicate clicks and later expiry retain one charge", async () => {
		const quoted = await quote();
		const key = crypto.randomUUID();
		const replies = await Promise.all(Array.from({ length: 8 }, () => create(quoted.quoteId, key)));
		expect(new Set(replies.map((item) => item.jobId)).size).toBe(1);
		expect(await client.creditLedgerEntry.count({ where: { accountId, type: "RESERVE" } })).toBe(1);
		const job = await client.generationJob.findUniqueOrThrow({ where: { id: replies[0]!.jobId } });
		expect(job.creditsReserved).toBe(66n);
		expect(job.pricingSnapshot).toMatchObject({
			pricingDetails: {
				retail: {
					eligibility: { ownerId, subscriptionId, audience: "annual" },
					baselineProductKey: "video-seedance-2-mini",
					standardMarkupBps: "32500",
					annualMarkupBps: "21750",
					display: { standardCredits: "96", annualCredits: "66", savedCredits: "30" },
				},
			},
		});
		await client.subscription.update({
			where: { id: subscriptionId },
			data: { status: "EXPIRED" },
		});
		vi.stubEnv("VIDEO_V1_ENABLED", "false");
		const replay = await create(quoted.quoteId, key);
		expect(replay.jobId).toBe(job.id);
		expect(replay.pricing).toEqual(quoted.pricing);
		expect(await client.creditLedgerEntry.count({ where: { accountId, type: "RESERVE" } })).toBe(1);
		expect(
			(await client.generationJob.findUniqueOrThrow({ where: { id: job.id } })).pricingSnapshot,
		).toEqual(job.pricingSnapshot);
	});
	it("rejects an expired frozen quote and client-supplied discount claims", async () => {
		const quoted = await quote();
		const stored = await client.generationQuote.findUniqueOrThrow({
			where: { id: quoted.quoteId },
		});
		const { id: _id, createdAt: _createdAt, ...fields } = stored;
		const expired = { ...fields, expiresAt: new Date(0) };
		const copied = await client.generationQuote.create({
			data: {
				...expired,
				inputSnapshot: fields.inputSnapshot as never,
				pricingSnapshot: fields.pricingSnapshot as never,
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(expired),
			},
		});
		await expect(create(copied.id)).rejects.toThrow("QUOTE_EXPIRED");
		await expect(
			scoped(() =>
				call(videoV1Router.quote, { ...request, annual: true, credits: "1" } as never, ctx),
			),
		).rejects.toThrow();
		expect(await client.creditReservation.count({ where: { accountId } })).toBe(0);
	});
	it("rechecks annual eligibility after a concurrent refund holds the account lock", async () => {
		const quoted = await quote();
		const eligibility = await resolveVideoRetailEligibility(ownerId, client);
		const admitted = requireVideoAdmission({ userId: ownerId }, environment, bindings, request, {
			audience: eligibility.audience,
			eligibility,
		});
		let unlock!: () => void;
		let locked!: () => void;
		const gate = new Promise<void>((resolve) => {
			unlock = resolve;
		});
		const acquired = new Promise<void>((resolve) => {
			locked = resolve;
		});
		const refund = client.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT "id" FROM "credit_account" WHERE "id" = ${accountId} FOR UPDATE`;
			locked();
			await gate;
			await tx.subscription.update({
				where: { id: subscriptionId },
				data: { refundTerminationRequestedAt: new Date() },
			});
		});
		await acquired;
		const admission = createVideoJobRecord(
			{
				ownerId,
				request,
				quoteId: quoted.quoteId,
				idempotencyKey: crypto.randomUUID(),
				...admitted,
				paidFundingPolicy: admitted.price.paidFundingPolicy,
				limits: {
					ownerConcurrency: 1,
					globalConcurrency: 5,
					providerConcurrency: 5,
					maximumStorageBytes: 1_000_000_000n,
					maximumInputBytes: 10_000_000,
				},
			},
			client,
		);
		const outcome = admission.then(
			() => "accepted",
			(error) => error.message,
		);
		try {
			let waiting = false;
			for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
				const rows = await client.$queryRaw<
					Array<{ waiting: boolean }>
				>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%credit_account%FOR UPDATE%') AS "waiting"`;
				waiting = rows[0]?.waiting === true;
				if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(waiting).toBe(true);
		} finally {
			unlock();
			await refund;
		}
		expect(await outcome).toBe("PRICE_CHANGED");
		expect(await client.creditReservation.count({ where: { accountId } })).toBe(0);
	});
});

const effectPolicy = {
	...environment,
	MEDIA_ENABLED_PROVIDERS: "kie",
	MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
	VIDEO_EFFECT_RETAIL_PRICE_ACCEPTED_VERSION: VIDEO_EFFECT_RETAIL_PRICE_VERSION,
	HOTEL_LOBBY_DUO_ENABLED: "true",
	HOTEL_LOBBY_DUO_ACCESS: "authenticated",
	HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION: HOTEL_LOBBY_TEMPLATE_VERSION,
	HOTEL_LOBBY_DUO_ACCEPTED_LONG_TEMPLATE_VERSION: HOTEL_LOBBY_LONG_TEMPLATE_VERSION,
	RAINDANCE_ENABLED: "true",
	RAINDANCE_ACCESS: "authenticated",
	RAINDANCE_ACCEPTED_TEMPLATE_VERSION: RAINDANCE_TEMPLATE_VERSION,
	RAINDANCE_ACCEPTED_LONG_TEMPLATE_VERSION: RAINDANCE_LONG_TEMPLATE_VERSION,
	HOTEL_LOBBY_DUO_PRICE_VERSION: HOTEL_LOBBY_PRICE_VERSION,
	HOTEL_LOBBY_DUO_PRICE_BASIS: "SYNTHETIC_TEST_BUDGET_ONLY",
	HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: "2099-01-01T00:00:00Z",
	HOTEL_LOBBY_DUO_COST_POLICY_VERSION: HOTEL_LOBBY_SAFETY_POLICY_VERSION,
	HOTEL_LOBBY_DUO_PAYMENT_COST_BASIS: "SYNTHETIC_TEST_BUDGET_ONLY",
	HOTEL_LOBBY_DUO_TEXT_COST_RULE_VERSION: "waffo-prompt-safety-2026-10-04.1",
	HOTEL_LOBBY_DUO_TEXT_COST_BASIS: "SYNTHETIC_TEST_BUDGET_ONLY",
	HOTEL_LOBBY_DUO_TEXT_REVIEW_COST_MICROS: "0",
	HOTEL_LOBBY_DUO_SCENE_PROVIDER_COST_MICROS: "20000",
	HOTEL_LOBBY_DUO_INPUT_REVIEW_COST_MICROS: "5100",
	HOTEL_LOBBY_DUO_SCENE_REVIEW_COST_MICROS: "5100",
	HOTEL_LOBBY_DUO_ADDITIONAL_RUNTIME_COST_MICROS: "100000",
	HOTEL_LOBBY_DUO_ADDITIONAL_STORAGE_COST_MICROS: "10000",
};
async function effectFixture(
	effectId: "hotel-lobby-duo" | "raindance-solo" | "raindance-duo" = "hotel-lobby-duo",
) {
	for (const [key, value] of Object.entries(effectPolicy)) vi.stubEnv(key, value);
	const asset = await client.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			verificationEngine: "video-workflow-v1",
			objectKey: `users/${ownerId}/fixture.template-source.template-input.png`,
			mimeType: "image/png",
			byteSize: 1000n,
			width: 720,
			height: 1280,
			checksum: "a".repeat(64),
			storageEtag: "fixture",
			finalizedAt: new Date(),
		},
	});
	return {
		effectId,
		presetKey: "standard" as const,
		duration: 10 as const,
		inputs: { leftAssetId: asset.id, rightAssetId: asset.id },
	};
}
describe("effect duration and annual qualification through protected RPC and PostgreSQL", () => {
	it.each(["hotel-lobby-duo", "raindance-solo", "raindance-duo"] as const)(
		"%s shows both prices before uploads and freezes one ten-second annual order",
		async (effectId) => {
			const input = await effectFixture(effectId);
			const access = await scoped(() => call(videoEffectsRouter.access, { effectId }, ctx));
			expect(access.available).toBe(true);
			expect(
				access.durationOptions?.map((item) => [
					item.duration,
					item.credits,
					item.pricing?.standardCredits,
					item.pricing?.annualCredits,
				]),
			).toEqual([
				[5, "69", "69", "69"],
				[10, "101", "116", "101"],
			]);
			expect(JSON.stringify(access)).not.toMatch(
				/subscriptionId|providerCost|MarkupBps|costPolicy/,
			);
			const q = await scoped(() => call(videoEffectsRouter.quote, input, ctx));
			expect(q.credits).toBe("101");
			expect(q.pricing).toMatchObject({
				audience: "annual",
				savedCredits: "15",
				standardCredits: "116",
			});
			const key = crypto.randomUUID();
			const accept = () =>
				scoped(() =>
					call(
						videoEffectsRouter.jobs.create,
						{ request: input, quoteId: q.quoteId, idempotencyKey: key },
						ctx,
					),
				);
			const replies = await Promise.all(Array.from({ length: 4 }, accept));
			expect(new Set(replies.map((item) => item.jobId)).size).toBe(1);
			expect(replies[0]).toMatchObject({ duration: 10, credits: "101" });
			await client.subscription.update({
				where: { id: subscriptionId },
				data: { status: "EXPIRED" },
			});
			vi.stubEnv("HOTEL_LOBBY_DUO_ENABLED", "false");
			vi.stubEnv("RAINDANCE_ENABLED", "false");
			expect((await accept()).jobId).toBe(replies[0]!.jobId);
			expect(await client.creditLedgerEntry.count({ where: { accountId, type: "RESERVE" } })).toBe(
				1,
			);
		},
	);
	it("rejects a stale annual effect quote after refund even when a separate paid pack can fund it", async () => {
		const input = await effectFixture();
		await addPaidPackBalance();
		const q = await scoped(() => call(videoEffectsRouter.quote, input, ctx));
		await client.subscription.update({
			where: { id: subscriptionId },
			data: { refundTerminationRequestedAt: new Date() },
		});
		await expect(
			scoped(() =>
				call(
					videoEffectsRouter.jobs.create,
					{ request: input, quoteId: q.quoteId, idempotencyKey: crypto.randomUUID() },
					ctx,
				),
			),
		).rejects.toThrow("QUOTE_EXPIRED_OR_CHANGED");
		expect(await client.creditReservation.count({ where: { accountId } })).toBe(0);
		const refreshed = await scoped(() => call(videoEffectsRouter.quote, input, ctx));
		expect(refreshed).toMatchObject({
			credits: "116",
			pricing: { audience: "standard", savedCredits: "0", annualCredits: "101" },
		});
	});
	it("rechecks the effect annual proof inside the refund account lock", async () => {
		const input = await effectFixture();
		const q = await scoped(() => call(videoEffectsRouter.quote, input, ctx));
		const eligibility = await resolveVideoRetailEligibility(ownerId, client);
		const admitted = requireVideoTemplateAdmission(
			{ userId: ownerId },
			effectPolicy,
			bindings,
			input,
			{ audience: eligibility.audience, eligibility },
		);
		let unlock!: () => void;
		let locked!: () => void;
		const gate = new Promise<void>((resolve) => {
			unlock = resolve;
		});
		const acquired = new Promise<void>((resolve) => {
			locked = resolve;
		});
		const refund = client.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT "id" FROM "credit_account" WHERE "id" = ${accountId} FOR UPDATE`;
			locked();
			await gate;
			await tx.subscription.update({
				where: { id: subscriptionId },
				data: { refundTerminationRequestedAt: new Date() },
			});
		});
		await acquired;
		const outcome = createVideoTemplateJobRecord(
			{
				ownerId,
				request: input,
				quoteId: q.quoteId,
				idempotencyKey: crypto.randomUUID(),
				...admitted,
				paidFundingPolicy: admitted.price.paidFundingPolicy,
				limits: {
					ownerConcurrency: 1,
					globalConcurrency: 5,
					providerConcurrency: 5,
					maximumStorageBytes: 1_000_000_000n,
					maximumInputBytes: 10_000_000,
				},
			},
			client,
		).then(
			() => "accepted",
			(error) => error.message,
		);
		try {
			let waiting = false;
			for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
				const rows = await client.$queryRaw<
					Array<{ waiting: boolean }>
				>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%credit_account%FOR UPDATE%') AS "waiting"`;
				waiting = rows[0]?.waiting === true;
				if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(waiting).toBe(true);
		} finally {
			unlock();
			await refund;
		}
		expect(await outcome).toBe("PRICE_CHANGED");
		expect(await client.creditReservation.count({ where: { accountId } })).toBe(0);
	});
});
