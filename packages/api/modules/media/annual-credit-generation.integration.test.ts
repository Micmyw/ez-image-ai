import { PrismaPg } from "@prisma/adapter-pg";
import { BILLING_PRICING_VERSION, DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import { createCreditGrant, releaseCredits } from "@repo/database";
import { runWithDatabaseClient } from "@repo/database/client";
import { PrismaClient } from "@repo/database/generated-client";
import { getVideoTemplateCreditBalance } from "@repo/database/video-template";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadUserPlanEntitlement } from "./lib/plan-entitlement";
import { createGenerationForUser } from "./procedures/create-generation";
import { createQuoteForUser } from "./procedures/create-quote";

const scenarios = [
	{ planId: "creator", monthlyCredits: 700n, annualUsd: 114n },
	{ planId: "ultimate", monthlyCredits: 1_800n, annualUsd: 294n },
	{ planId: "studio", monthlyCredits: 3_000n, annualUsd: 474n },
].flatMap((tier) => ["paypal", "waffo"].map((provider) => ({ ...tier, provider })));
const input = {
	productKey: "image-nano-banana-2" as const,
	fundingSource: "CREDITS" as const,
	input: {
		kind: "text-to-image" as const,
		prompt: "An original watercolor landscape with a sailboat on a calm lake",
		skuKey: "nano-banana-2-1k" as const,
		aspectRatio: "1:1" as const,
	},
};
let client: PrismaClient;
const owners: string[] = [];

beforeAll(() => {
	const raw = process.env.TEST_DATABASE_URL;
	if (!raw) throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
	const target = new URL(raw);
	if (
		!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
		!/(^|[_-])test([_-]|$)/.test(target.pathname.slice(1))
	)
		throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString: raw }) });
});
beforeEach(() => {
	vi.stubEnv("NODE_ENV", "test");
	vi.stubEnv("MEDIA_SAFETY_ADAPTER", "test");
	vi.stubEnv("MEDIA_ALLOW_TEST_SAFETY_ADAPTER", "true");
	vi.stubEnv("MEDIA_GENERATION_ENABLED", "true");
	vi.stubEnv("MEDIA_ENABLED_PROVIDERS", "kie");
	vi.stubEnv("MEDIA_NANO_BANANA_2_ENABLED", "true");
	vi.stubEnv("KIE_API_KEY", "isolated-annual-admission-fixture");
});
afterEach(async () => {
	for (const ownerId of owners.splice(0)) {
		for (const reservation of await client.creditReservation.findMany({
			where: { account: { ownerId }, status: "ACTIVE" },
		})) {
			await releaseCredits(
				{
					reservationId: reservation.id,
					amount: reservation.amount,
					referenceKey: `annual-image-cleanup:${reservation.id}`,
				},
				client,
			);
		}
		await client.generationJob.updateMany({
			where: { ownerId },
			data: { status: "FAILED", terminalAt: new Date() },
		});
	}
	vi.unstubAllEnvs();
});
afterAll(async () => client?.$disconnect());

// Real API business functions, catalog quotation, entitlement, SQL admission, ledger and
// allocation. The explicit local safety adapter supplies synthetic review evidence; this
// test stops at durable acceptance and never dispatches provider work or generates media.
describe("new annual receipts fund ordinary image admission", () => {
	it.each(scenarios)(
		"admits $provider $planId annual credits through the unchanged image quote",
		async (tier) => {
			const ownerId = `annual-image-${crypto.randomUUID()}`;
			owners.push(ownerId);
			await client.user.create({
				data: {
					id: ownerId,
					name: "Isolated annual image admission",
					email: `${ownerId}@example.test`,
					emailVerified: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
			const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
			const [clock] = await client.$queryRaw<
				Array<{ now: Date }>
			>`SELECT clock_timestamp() AS "now"`;
			if (!clock) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
			const startsAt = new Date(Date.UTC(clock.now.getUTCFullYear(), clock.now.getUTCMonth(), 1));
			const month = (offset: number) => {
				const date = new Date(startsAt);
				date.setUTCMonth(date.getUTCMonth() + offset);
				return date;
			};
			const plan = await client.billingPlan.create({
				data: {
					provider: tier.provider,
					providerPriceId: `${ownerId}-annual`,
					productKind: "PLAN",
					name: tier.planId,
					creditsPerPeriod: tier.monthlyCredits,
					priceMicros: tier.annualUsd * 1_000_000n,
					currency: "USD",
					metadata: {
						planId: tier.planId,
						interval: "year",
						version: 1,
						billingPricingVersion: BILLING_PRICING_VERSION,
					},
				},
			});
			const subscription = await client.subscription.create({
				data: {
					ownerType: "USER",
					ownerId,
					provider: tier.provider,
					providerSubscriptionId: ownerId,
					planId: plan.id,
					status: "ACTIVE",
					currentPeriodStart: startsAt,
					currentPeriodEnd: month(12),
				},
			});
			const referenceKey = `${tier.provider}-payment:${ownerId}:period:0:grant`;
			for (let index = 0; index < 12; index++) {
				await client.billingPeriod.create({
					data: {
						subscriptionId: subscription.id,
						startsAt: month(index),
						endsAt: month(index + 1),
						status: index === 0 ? "ACTIVE" : "PENDING",
						creditAmount: tier.monthlyCredits,
						grantReferenceKey: index === 0 ? referenceKey : `${referenceKey}:future:${index}`,
						providerInvoiceId: ownerId,
						providerInvoicePaymentId: `${tier.provider}:${ownerId}`,
						paidAmount: tier.annualUsd * 1_000_000n,
						refundedAmount: 0n,
					},
				});
			}
			await createCreditGrant(
				{ accountId: account.id, amount: tier.monthlyCredits, expiresAt: month(1), referenceKey },
				client,
			);
			expect(
				await getVideoTemplateCreditBalance(
					ownerId,
					{ minimumUsdMicrosPerCredit: 21_944n },
					client,
				),
			).toEqual({ totalCredits: tier.monthlyCredits.toString(), eligibleCredits: "0" });
			await runWithDatabaseClient(client, async () => {
				expect((await loadUserPlanEntitlement(ownerId)).id).toBe(tier.planId);
				const quote = await createQuoteForUser(ownerId, input);
				expect(quote.pricingSnapshot).not.toHaveProperty("paidFundingPolicy");
				expect(quote).toMatchObject({
					credits: 9n,
					fundingSource: "CREDITS",
					pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
				});
				const result = await createGenerationForUser(ownerId, {
					quoteId: quote.id,
					idempotencyKey: ownerId,
					fundingSource: "CREDITS",
				});
				expect(result).toMatchObject({
					replayed: false,
					job: { creditsReserved: 9n, fundingSource: "CREDITS" },
				});
				const allocations = await client.creditReservationAllocation.findMany({
					where: { reservation: { jobId: result.job.id } },
					include: { lot: true },
				});
				expect(allocations).toHaveLength(1);
				expect(allocations[0]).toMatchObject({
					amount: 9n,
					lot: {
						grantReferenceKey: referenceKey,
						remainingAmount: tier.monthlyCredits - 9n,
						reservedAmount: 9n,
					},
				});
				expect(
					await client.outboxEvent.count({ where: { aggregateId: result.job.id } }),
				).toBeGreaterThan(0);
				expect(
					await client.billingPeriod.count({ where: { subscriptionId: subscription.id } }),
				).toBe(12);
			});
		},
	);
});
