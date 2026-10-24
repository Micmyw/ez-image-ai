import { call } from "@orpc/server";
import { PrismaPg } from "@prisma/adapter-pg";
import { BILLING_PRICING_VERSION, DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import {
	createCreditGrant,
	getCreditInvariantReport,
	refundCreditGrant,
	releaseCredits,
} from "@repo/database";
import { runWithDatabaseClient } from "@repo/database/client";
import { PrismaClient } from "@repo/database/generated-client";
import { getVideoTemplateCreditBalance } from "@repo/database/video-template";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureFreePlanCreditsForUser } from "./lib/free-plan-credits";
import { ensureFreePlanCreditsForGeneration } from "./lib/free-plan-credits";
import { loadUserPlanEntitlement } from "./lib/plan-entitlement";
import { createGenerationForUser } from "./procedures/create-generation";
import { createQuoteForUser } from "./procedures/create-quote";
import { getCreditAccount } from "./procedures/get-credit-account";

const authentication = vi.hoisted(() => ({ ownerId: "" }));
vi.mock("@repo/auth", () => ({
	auth: {
		api: {
			getSession: async () => ({
				user: { id: authentication.ownerId, isAnonymous: false },
				session: { id: "isolated-session" },
			}),
		},
	},
}));

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
const sunburstInput = {
	productKey: "image-gpt-image-2-5-sunburst",
	fundingSource: "CREDITS",
	input: {
		kind: "text-to-image",
		prompt: "An original watercolor landscape with a sailboat on a calm lake",
		skuKey: "gpt-image-2-5-sunburst-1k",
		aspectRatio: "1:1",
	},
} as const;
const freeInput = {
	...sunburstInput,
	productKey: "image-nano-banana-2-lite",
	input: { ...sunburstInput.input, skuKey: "nano-banana-2-lite-1k" },
} as const;
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
	vi.stubEnv("MEDIA_GPT_IMAGE_2_5_SUNBURST_ENABLED", "true");
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

async function nonSubscriberFixture(amount: bigint) {
	const ownerId = `shared-image-${crypto.randomUUID()}`;
	owners.push(ownerId);
	await client.user.create({
		data: {
			id: ownerId,
			name: "Isolated shared-credit image admission",
			email: `${ownerId}@example.test`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	// Record real promotional history so preflight cannot replenish the test balance.
	await runWithDatabaseClient(client, () => ensureFreePlanCreditsForUser(ownerId));
	const account = await client.creditAccount.findUniqueOrThrow({
		where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
	});
	for (const grant of await client.creditLedgerEntry.findMany({
		where: { accountId: account.id, type: "GRANT" },
	}))
		await refundCreditGrant(
			{
				accountId: account.id,
				grantReferenceKey: grant.referenceKey,
				amount: grant.amount,
				referenceKey: `${ownerId}:promotional-refund:${grant.id}`,
			},
			client,
		);
	const referenceKey = `${ownerId}:compensation-grant`;
	await createCreditGrant(
		{
			accountId: account.id,
			amount,
			expiresAt: new Date(Date.now() + 60 * 60_000),
			referenceKey,
		},
		client,
	);
	expect(await client.subscription.count({ where: { ownerType: "USER", ownerId } })).toBe(0);
	expect(await getCreditInvariantReport(account.id, client)).toMatchObject({
		valid: true,
		account: { spendable: amount, reserved: 0n, debt: 0n },
	});
	return { ownerId, accountId: account.id, referenceKey };
}

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

describe("shared-credit image admission without a subscription", () => {
	it("grants ten lifetime credits once, admits exactly two basic generations and never refills monthly", async () => {
		const ownerId = `welcome-image-${crypto.randomUUID()}`;
		owners.push(ownerId);
		authentication.ownerId = ownerId;
		await client.user.create({
			data: {
				id: ownerId,
				name: "Two-generation welcome allowance",
				email: `${ownerId}@example.test`,
				emailVerified: true,
				isAnonymous: false,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		await runWithDatabaseClient(client, async () => {
			const readBalance = () =>
				call(getCreditAccount, undefined, { context: { headers: new Headers() } });
			await expect(readBalance()).resolves.toMatchObject({
				spendableCredits: "10",
				reservedCredits: "0",
			});
			for (let index = 0; index < 2; index++) {
				const quote = await createQuoteForUser(ownerId, freeInput);
				await expect(
					createGenerationForUser(ownerId, {
						quoteId: quote.id,
						idempotencyKey: `${ownerId}:${index}`,
						fundingSource: "CREDITS",
					}),
				).resolves.toMatchObject({ replayed: false, job: { creditsReserved: 5n } });
			}
			await ensureFreePlanCreditsForGeneration(ownerId, new Date("2026-11-01T00:00:00Z"));
			await expect(readBalance()).resolves.toMatchObject({
				spendableCredits: "0",
				reservedCredits: "10",
			});
			await expect(createQuoteForUser(ownerId, freeInput)).rejects.toThrow("INSUFFICIENT_CREDITS");
			const account = await client.creditAccount.findUniqueOrThrow({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
			});
			expect(
				await client.creditLedgerEntry.count({ where: { accountId: account.id, type: "GRANT" } }),
			).toBe(1);
			expect(
				await client.creditLedgerEntry.count({
					where: { referenceKey: { startsWith: `free-plan:user:${ownerId}:` } },
				}),
			).toBe(0);
			expect(await getCreditInvariantReport(account.id, client)).toMatchObject({
				valid: true,
				account: { spendable: 0n, reserved: 10n, debt: 0n },
			});
		});
	});
	it("rejects premium image quotation despite 377 valid compensation credits", async () => {
		const { ownerId, accountId } = await nonSubscriberFixture(377n);
		await runWithDatabaseClient(client, async () => {
			await expect(createQuoteForUser(ownerId, sunburstInput)).rejects.toThrow(
				"ENTITLEMENT_REQUIRED",
			);
			expect(await client.generationQuote.count({ where: { ownerId } })).toBe(0);
			expect(await client.generationJob.count({ where: { ownerId } })).toBe(0);
			expect(await client.creditReservation.count({ where: { accountId } })).toBe(0);
			expect(await getCreditInvariantReport(accountId, client)).toMatchObject({
				valid: true,
				account: { spendable: 377n, reserved: 0n, debt: 0n },
			});
		});
	});
	it("quotes and reserves Nano Banana 2 Lite 1K from 377 compensation credits once", async () => {
		const { ownerId, accountId, referenceKey } = await nonSubscriberFixture(377n);
		await runWithDatabaseClient(client, async () => {
			expect((await loadUserPlanEntitlement(ownerId)).id).toBe("free");
			const quote = await createQuoteForUser(ownerId, freeInput);
			expect(quote).toMatchObject({
				credits: 5n,
				fundingSource: "CREDITS",
				imagePassUnits: 0,
				pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
			});
			expect(quote.pricingSnapshot).not.toHaveProperty("paidFundingPolicy");
			expect(
				await client.generationQuote.findUniqueOrThrow({ where: { id: quote.id } }),
			).toMatchObject({
				productKey: freeInput.productKey,
				credits: 5n,
				costMicros: 20_000n,
				inputSnapshot: freeInput.input,
				moderationDecision: "ALLOW",
				moderationProvider: "test",
			});
			const request = {
				quoteId: quote.id,
				idempotencyKey: ownerId,
				fundingSource: "CREDITS" as const,
			};
			const created = await createGenerationForUser(ownerId, request);
			expect(created).toMatchObject({
				replayed: false,
				job: { creditsReserved: 5n, fundingSource: "CREDITS", imagePassUnits: 0 },
			});
			await expect(createGenerationForUser(ownerId, request)).resolves.toMatchObject({
				replayed: true,
				job: { id: created.job.id, creditsReserved: 5n, fundingSource: "CREDITS" },
			});
			expect(
				await client.creditReservation.findUniqueOrThrow({ where: { jobId: created.job.id } }),
			).toMatchObject({
				accountId,
				amount: 5n,
				status: "ACTIVE",
			});
			const allocations = await client.creditReservationAllocation.findMany({
				where: { reservation: { jobId: created.job.id } },
				include: { lot: true },
			});
			expect(allocations).toHaveLength(1);
			expect(allocations[0]).toMatchObject({
				amount: 5n,
				lot: { grantReferenceKey: referenceKey, remainingAmount: 372n, reservedAmount: 5n },
			});
			expect(await getCreditInvariantReport(accountId, client)).toMatchObject({
				valid: true,
				account: { spendable: 372n, reserved: 5n, debt: 0n },
			});
			expect(await client.generationJob.count({ where: { ownerId } })).toBe(1);
			expect(await client.creditLedgerEntry.count({ where: { accountId, type: "RESERVE" } })).toBe(
				1,
			);
			expect(
				await client.outboxEvent.count({ where: { aggregateId: created.job.id } }),
			).toBeGreaterThan(0);
			expect(await client.generationAttempt.count({ where: { jobId: created.job.id } })).toBe(0);
		});
	});
	it.each(["quote", "generation"] as const)(
		"rejects four shared credits before %s without creating image work",
		async (stage) => {
			const { ownerId, accountId, referenceKey } = await nonSubscriberFixture(
				stage === "quote" ? 4n : 377n,
			);
			await runWithDatabaseClient(client, async () => {
				if (stage === "quote") {
					await expect(createQuoteForUser(ownerId, freeInput)).rejects.toThrow(
						"INSUFFICIENT_CREDITS",
					);
				} else {
					const quote = await createQuoteForUser(ownerId, freeInput);
					await refundCreditGrant(
						{
							accountId,
							grantReferenceKey: referenceKey,
							amount: 373n,
							referenceKey: `${ownerId}:refund-after-quote`,
						},
						client,
					);
					await expect(
						createGenerationForUser(ownerId, {
							quoteId: quote.id,
							idempotencyKey: ownerId,
							fundingSource: "CREDITS",
						}),
					).rejects.toThrow("INSUFFICIENT_CREDITS");
				}
				expect(await client.generationQuote.count({ where: { ownerId } })).toBe(
					stage === "quote" ? 0 : 1,
				);
				expect(await client.generationJob.count({ where: { ownerId } })).toBe(0);
				expect(await client.creditReservation.count({ where: { accountId } })).toBe(0);
				expect(
					await client.creditLedgerEntry.count({ where: { accountId, type: "RESERVE" } }),
				).toBe(0);
				expect(await getCreditInvariantReport(accountId, client)).toMatchObject({
					valid: true,
					account: { spendable: 4n, reserved: 0n, debt: 0n },
				});
			});
		},
	);
});
