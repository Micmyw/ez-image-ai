import { call } from "@orpc/server";
import { PrismaPg } from "@prisma/adapter-pg";
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
import { createVideoJobRecord } from "@repo/database/video-v1";
import { requireVideoAdmission } from "@repo/jobs/video-v1/admission";
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
