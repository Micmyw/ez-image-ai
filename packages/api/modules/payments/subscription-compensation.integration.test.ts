import { createHash } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import {
	bindPaymentCheckoutIntentSession,
	claimSubscriptionCompensationOffer,
	createPaymentCheckoutIntent,
	dismissSubscriptionCompensationOffer,
	getSubscriptionCompensationOffer,
	markPaymentCheckoutIntentProviderCreating,
	runSerializable,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { applyProviderBillingFact } from "../../../payments/provider/lifecycle-reducer";
import { applyProviderRefundFact } from "../../../payments/provider/refund-reducer";

let client: PrismaClient;
beforeAll(() => {
	const connectionString = process.env.TEST_DATABASE_URL;
	if (!connectionString || connectionString === process.env.DATABASE_URL)
		throw new Error("EXPLICIT_TEST_DATABASE_REQUIRED");
	const url = new URL(connectionString);
	if (
		url.hostname !== "127.0.0.1" ||
		url.port !== "55432" ||
		!["/ai_media_foundation_test", "/ezpic_seeapi_verified_test"].includes(url.pathname) ||
		url.search ||
		url.hash
	)
		throw new Error("UNSAFE_TEST_DATABASE");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 6 }) });
});
afterEach(() => vi.unstubAllEnvs());
// Immutable audit/evidence/ledger fixtures stay in this explicitly disposable cluster.
afterAll(async () => {
	await client?.$disconnect();
});

async function technicalFailure(
	code = "RATE_LIMITED",
	options: { anonymous?: boolean; raw?: boolean } = {},
) {
	vi.stubEnv("MEDIA_TECHNICAL_FAILURE_SUBSCRIPTION_BONUS_ENABLED", "true");
	const id = crypto.randomUUID(),
		ownerId = `compensation-${id}`,
		taskId = `task-${id}`;
	await client.user.create({
		data: {
			id: ownerId,
			name: "Compensation fixture",
			email: `${id}@example.test`,
			emailVerified: true,
			isAnonymous: options.anonymous ?? false,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	await client.mediaAsset.create({
		data: {
			id,
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			objectKey: `test/${id}.png`,
			mimeType: "image/png",
			byteSize: 16n,
			checksum: "c".repeat(64),
			finalizedAt: new Date(),
			verificationProvider: "seeapi",
			verificationProviderTaskId: taskId,
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationRuleVersion: "fixture-rule",
			verificationPolicyVersion: "fixture-policy",
		},
	});
	await client.assetModerationResult.create({
		data: {
			assetId: id,
			assetChecksum: "c".repeat(64),
			evidenceKind: "INPUT",
			provider: "seeapi",
			providerTaskId: taskId,
			verificationGeneration: 1,
			attemptNumber: 1,
			ruleVersion: "fixture-rule",
			policyVersion: "fixture-policy",
			status: "ERROR",
			reasonCode: "MODERATION_RATE_LIMITED",
			categories: [],
			rawEnvelope:
				options.raw === false
					? { decision: "ERROR" }
					: {
							decision: "ERROR",
							evidence: {
								requestId: taskId,
								models: ["nsfw-filter-2"],
								seeapiFailure: { taskId, status: "failed", code },
							},
						},
		},
	});
	return { ownerId, assetId: id };
}

async function checkout(
	ownerId: string,
	provider: "paypal" | "waffo",
	interval: "month" | "year",
	daysLater = 0,
) {
	const id = crypto.randomUUID();
	const plan = await client.billingPlan.create({
		data: {
			provider,
			providerPriceId: `comp-${id}`,
			name: "creator",
			priceMicros: interval === "year" ? 190_000_000n : 19_000_000n,
			currency: "USD",
			creditsPerPeriod: 700n,
			metadata: { planId: "creator", interval, version: 1 },
		},
	});
	const { intent } = await createPaymentCheckoutIntent(
		{
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			provider,
			billingPlanId: plan.id,
			planKey: "creator",
			interval,
			idempotencyKey: id,
		},
		client,
	);
	const providerSubscriptionId = `sub-${id}`;
	await markPaymentCheckoutIntentProviderCreating({ intentId: intent.id, provider }, client);
	await bindPaymentCheckoutIntentSession(
		{
			intentId: intent.id,
			provider,
			providerSessionId: providerSubscriptionId,
			providerCheckoutUrl: "https://example.test/checkout",
			expiresAt: null,
		},
		client,
	);
	const startsAt = new Date(Date.now() + daysLater * 86_400_000),
		endsAt = new Date(startsAt);
	endsAt.setUTCMonth(endsAt.getUTCMonth() + (interval === "year" ? 12 : 1));
	const fact = {
		provider,
		providerEventId: `paid-${id}`,
		providerSubscriptionId,
		checkoutIntentId: intent.id,
		providerCustomerId: provider === "waffo" ? `USER:${ownerId}` : `payer-${id}`,
		status: "ACTIVE" as const,
		cancelAtPeriodEnd: false,
		occurredAt: startsAt,
		currentPeriod: { periodStart: startsAt, periodEnd: endsAt },
		payment: {
			providerPaymentId: `pay-${id}`,
			amountMicros: plan.priceMicros,
			currency: "USD",
			periodStart: startsAt,
			periodEnd: endsAt,
		},
	};
	return { fact, plan, intent };
}

describe("technical failure compensation through real PostgreSQL and payment reducers", () => {
	it.each(["RATE_LIMITED", "DETECTION_REPORT_FAILED", "PROVIDER_TIMEOUT"])(
		"issues one lifetime offer from %s and preserves dismissal",
		async (code) => {
			const f = await technicalFailure(code);
			const results = await Promise.all(
				Array.from({ length: 3 }, () => claimSubscriptionCompensationOffer(f, client)),
			);
			expect(results[0]).toMatchObject({ bonusPercent: 10, dismissed: false });
			expect(
				results.every((r) => r?.id === results[0]?.id && r?.expiresAt === results[0]?.expiresAt),
			).toBe(true);
			await dismissSubscriptionCompensationOffer(f.ownerId, client);
			expect(await claimSubscriptionCompensationOffer(f, client)).toMatchObject({
				id: results[0]!.id,
				dismissed: true,
			});
		},
	);
	it("does not issue for unknown errors, missing evidence, anonymous users, other owners or a disabled campaign", async () => {
		for (const f of [
			await technicalFailure("UNKNOWN"),
			await technicalFailure("RATE_LIMITED", { raw: false }),
			await technicalFailure("RATE_LIMITED", { anonymous: true }),
		])
			expect(await claimSubscriptionCompensationOffer(f, client)).toBeNull();
		const a = await technicalFailure(),
			b = await technicalFailure();
		expect(
			await claimSubscriptionCompensationOffer({ ownerId: a.ownerId, assetId: b.assetId }, client),
		).toBeNull();
		vi.stubEnv("MEDIA_TECHNICAL_FAILURE_SUBSCRIPTION_BONUS_ENABLED", "false");
		expect(await claimSubscriptionCompensationOffer(a, client)).toBeNull();
	});
	it.each(["paypal", "waffo"] as const)(
		"%s: verified payment grants once without changing PSP amounts or purchased credits, and partial refund revokes the gift once",
		async (provider) => {
			const f = await technicalFailure();
			await claimSubscriptionCompensationOffer(f, client);
			const c = await checkout(f.ownerId, provider, "month");
			await expect(
				runSerializable(client, (tx) =>
					applyProviderBillingFact(
						{ ...c.fact, payment: { ...c.fact.payment, amountMicros: c.plan.priceMicros - 1n } },
						tx,
					),
				),
			).rejects.toThrow("PAYMENT_PROVIDER_AMOUNT_MISMATCH");
			await Promise.all(
				[1, 2].map(() => runSerializable(client, (tx) => applyProviderBillingFact(c.fact, tx))),
			);
			const account = await client.creditAccount.findUniqueOrThrow({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId: f.ownerId } },
			});
			expect(account.spendableCredits).toBe(770n);
			expect(
				await client.billingPeriod.findFirst({ where: { subscription: { ownerId: f.ownerId } } }),
			).toMatchObject({ creditAmount: 700n, paidAmount: c.plan.priceMicros });
			expect(
				(await client.billingPlan.findUniqueOrThrow({ where: { id: c.plan.id } })).priceMicros,
			).toBe(c.plan.priceMicros);
			expect(await getSubscriptionCompensationOffer(f.ownerId, client)).toBeNull();
			const refund = {
				provider,
				providerEventId: `refund-${f.assetId}`,
				providerPaymentId: c.fact.payment.providerPaymentId,
				providerRefundId: `refund-${f.assetId}`,
				providerSubscriptionId: c.fact.providerSubscriptionId,
				amountMicros: 1_000_000n,
				currency: "USD",
				occurredAt: new Date(),
			};
			await runSerializable(client, (tx) => applyProviderRefundFact(refund, tx));
			const after = await client.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
			await runSerializable(client, (tx) => applyProviderRefundFact(refund, tx));
			expect(
				(await client.creditAccount.findUniqueOrThrow({ where: { id: account.id } }))
					.spendableCredits,
			).toBe(after.spendableCredits);
			expect(
				await client.creditLedgerEntry.findMany({
					where: { accountId: account.id, referenceKey: { endsWith: ":credits:revoked" } },
				}),
			).toHaveLength(1);
		},
	);
	it("annual plan receives only the first month's gift, never changes the twelve scheduled allocations", async () => {
		const f = await technicalFailure();
		await claimSubscriptionCompensationOffer(f, client);
		const c = await checkout(f.ownerId, "paypal", "year");
		await runSerializable(client, (tx) => applyProviderBillingFact(c.fact, tx));
		const periods = await client.billingPeriod.findMany({
			where: { subscription: { ownerId: f.ownerId } },
			orderBy: { startsAt: "asc" },
		});
		expect(periods).toHaveLength(12);
		expect(periods.every((p) => p.creditAmount === 700n)).toBe(true);
		const gift = await client.creditLot.findFirst({
			where: { account: { ownerId: f.ownerId }, grantReferenceKey: { startsWith: "comp_" } },
		});
		expect(gift).toMatchObject({ grantedAmount: 70n, expiresAt: periods[0]!.endsAt });
	});
	it("unpaid activation grants nothing; a later authenticated first payment honors the issued offer even after issuance is disabled", async () => {
		const f = await technicalFailure();
		await claimSubscriptionCompensationOffer(f, client);
		const c = await checkout(f.ownerId, "waffo", "month");
		await runSerializable(client, (tx) =>
			applyProviderBillingFact({ ...c.fact, payment: null }, tx),
		);
		expect(
			await client.creditAccount.findUnique({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId: f.ownerId } },
			}),
		).toBeNull();
		vi.stubEnv("MEDIA_TECHNICAL_FAILURE_SUBSCRIPTION_BONUS_ENABLED", "false");
		await runSerializable(client, (tx) =>
			applyProviderBillingFact(
				{ ...c.fact, providerEventId: `${c.fact.providerEventId}-payment` },
				tx,
			),
		);
		expect(
			await client.creditAccount.findUnique({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId: f.ownerId } },
			}),
		).toMatchObject({ spendableCredits: 770n });
	});
	it("an expired offer cannot bind a new checkout", async () => {
		const f = await technicalFailure();
		const policy = "technical-failure-subscription-bonus-v1";
		const id = `comp_${createHash("sha256")
			.update(JSON.stringify([policy, f.ownerId, "offer"]))
			.digest("hex")}`;
		await client.auditLog.create({
			data: {
				id,
				action: "SUBSCRIPTION_COMPENSATION_OFFERED",
				targetType: "USER",
				targetId: f.ownerId,
				createdAt: new Date("2020-01-01"),
				metadata: { policy, bonusPercent: 10, expiresAt: "2020-01-08T00:00:00.000Z" },
			},
		});
		expect(await getSubscriptionCompensationOffer(f.ownerId, client)).toBeNull();
		const c = await checkout(f.ownerId, "paypal", "month");
		await runSerializable(client, (tx) => applyProviderBillingFact(c.fact, tx));
		expect(
			await client.creditAccount.findUnique({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId: f.ownerId } },
			}),
		).toMatchObject({ spendableCredits: 700n });
	});
	it("honors a bound checkout when the PSP completes after the offer deadline", async () => {
		const f = await technicalFailure();
		await claimSubscriptionCompensationOffer(f, client);
		const c = await checkout(f.ownerId, "paypal", "month", 8);
		await runSerializable(client, (tx) => applyProviderBillingFact(c.fact, tx));
		expect(
			await client.creditAccount.findUnique({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId: f.ownerId } },
			}),
		).toMatchObject({ spendableCredits: 770n });
	});
	it("does not advertise or retrofit compensation onto a pre-existing pending checkout", async () => {
		const f = await technicalFailure();
		const c = await checkout(f.ownerId, "paypal", "month");
		expect(await claimSubscriptionCompensationOffer(f, client)).toBeNull();
		await runSerializable(client, (tx) => applyProviderBillingFact(c.fact, tx));
		expect(
			await client.creditAccount.findUnique({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId: f.ownerId } },
			}),
		).toMatchObject({ spendableCredits: 700n });
	});
	it("existing subscribers are not offered a new acquisition bonus", async () => {
		const f = await technicalFailure();
		const c = await checkout(f.ownerId, "paypal", "month");
		await runSerializable(client, (tx) => applyProviderBillingFact(c.fact, tx));
		expect(await claimSubscriptionCompensationOffer(f, client)).toBeNull();
	});
});
