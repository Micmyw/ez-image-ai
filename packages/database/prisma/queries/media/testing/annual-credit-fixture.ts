import { randomUUID } from "node:crypto";

import { BILLING_PRICING_VERSION } from "@repo/config";

import type { PrismaClient } from "../../../generated/client";
import { createCreditGrant } from "../credits";

export const newAnnualTiers = [
	{ planId: "creator", monthlyCredits: 700n, priceMicros: 114_000_000n },
	{ planId: "ultimate", monthlyCredits: 1_800n, priceMicros: 294_000_000n },
	{ planId: "studio", monthlyCredits: 3_000n, priceMicros: 474_000_000n },
] as const;
export const newAnnualProviders = ["paypal", "waffo"] as const;

/** Real isolated ledger and monthly billing projections; no payment/provider request is sent. */
export async function grantNewAnnualCredits(
	client: PrismaClient,
	ownerId: string,
	selection: (typeof newAnnualTiers)[number] & {
		provider: (typeof newAnnualProviders)[number];
	},
) {
	const account = await client.creditAccount.findUniqueOrThrow({
		where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
	});
	const id = randomUUID();
	const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
	const startsAt = new Date(clock!.now);
	startsAt.setUTCDate(1);
	startsAt.setUTCHours(0, 0, 0, 0);
	const boundary = (index: number) => {
		const value = new Date(startsAt);
		value.setUTCMonth(value.getUTCMonth() + index);
		return value;
	};
	const plan = await client.billingPlan.create({
		data: {
			provider: selection.provider,
			providerPriceId: `shared-template-annual-${id}`,
			productKind: "PLAN",
			name: selection.planId,
			creditsPerPeriod: selection.monthlyCredits,
			priceMicros: selection.priceMicros,
			currency: "USD",
			metadata: {
				planId: selection.planId,
				interval: "year",
				version: 1,
				billingPricingVersion: BILLING_PRICING_VERSION,
				providerEnvironment: selection.provider === "paypal" ? "live" : "prod",
			},
		},
	});
	const subscription = await client.subscription.create({
		data: {
			ownerType: "USER",
			ownerId,
			provider: selection.provider,
			providerSubscriptionId: `shared-template-annual-${id}`,
			planId: plan.id,
			status: "ACTIVE",
			currentPeriodStart: startsAt,
			currentPeriodEnd: boundary(12),
		},
	});
	const grantReferenceKey = `${selection.provider}-payment:${id}:period:0:grant`;
	await client.billingPeriod.createMany({
		data: Array.from({ length: 12 }, (_, index) => ({
			subscriptionId: subscription.id,
			startsAt: boundary(index),
			endsAt: boundary(index + 1),
			status: index === 0 ? ("ACTIVE" as const) : ("PENDING" as const),
			creditAmount: selection.monthlyCredits,
			grantReferenceKey: index === 0 ? grantReferenceKey : `${grantReferenceKey}:future:${index}`,
			providerInvoiceId: id,
			providerInvoicePaymentId: `${selection.provider}:${id}`,
			paidAmount: selection.priceMicros,
			refundedAmount: 0n,
		})),
	});
	await createCreditGrant(
		{
			accountId: account.id,
			amount: selection.monthlyCredits,
			expiresAt: boundary(1),
			referenceKey: grantReferenceKey,
		},
		client,
	);
	return { account, subscription, grantReferenceKey };
}
