import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PaidCreditFundingPostgresPort } from "../../../test-support/paid-credit-funding-postgres-port";
import { findPaidFundedCreditLotIds } from "./paid-credit-funding";

const database = new PaidCreditFundingPostgresPort();
const policy = { minimumUsdMicrosPerCredit: 21_944n };
const accountId = "paid-funding-regression";
const tiers = [
	{ plan: "creator", monthlyCredits: 700n, monthlyUsd: 19n, oldAnnualUsd: 190n, annualUsd: 114n },
	{
		plan: "ultimate",
		monthlyCredits: 1_800n,
		monthlyUsd: 49n,
		oldAnnualUsd: 490n,
		annualUsd: 294n,
	},
	{ plan: "studio", monthlyCredits: 3_000n, monthlyUsd: 79n, oldAnnualUsd: 790n, annualUsd: 474n },
];

beforeAll(() => database.initialize());
beforeEach(async () => {
	await database.reset();
	await database.rows(`INSERT INTO ${database.table("credit_account")} VALUES ($1, 'USER', $1)`, [
		accountId,
	]);
});
afterAll(() => database.close());

describe("approved template receipt floor after annual catalog repricing", () => {
	// Removing the all-promised-period denominator would wrongly admit the new annual lots.
	it.each(tiers)(
		"keeps historical and monthly $plan receipts eligible, excluding its new annual receipts on both channels",
		async (tier) => {
			const expected = new Set<string>();
			for (const provider of ["paypal", "waffo"] as const) {
				const historical = await subscriptionLot(
					provider,
					tier.oldAnnualUsd * 1_000_000n,
					tier.monthlyCredits,
					12,
				);
				const monthly = await subscriptionLot(
					provider,
					tier.monthlyUsd * 1_000_000n,
					tier.monthlyCredits,
				);
				await subscriptionLot(provider, tier.annualUsd * 1_000_000n, tier.monthlyCredits, 12);
				expected.add(historical.lotId);
				expected.add(monthly.lotId);
			}
			expect(await eligible()).toEqual(expected);
		},
	);

	it("rechecks actual annual receipts net of the largest recorded refund across all twelve promised periods", async () => {
		const safe = await subscriptionLot("paypal", 190_000_000n, 700n, 12, 5_000_000n);
		const refunded = await subscriptionLot("paypal", 190_000_000n, 700n, 12);
		// A refund can arrive before every sibling monthly row has been projected.
		await database.rows(
			`UPDATE ${database.table("billing_period")} SET "refundedAmount"=$1 WHERE id=$2`,
			[6_000_000n, refunded.lastPeriodId],
		);
		expect(await eligible()).toEqual(new Set([safe.lotId]));
	});

	// Ignoring bonus credits or subtracting refunds only after qualification admits these bad lots.
	it("preserves qualifying packs and rejects bonus dilution or refunds below the same funding threshold", async () => {
		const safe = await packLot(59_000_000n, 0n, 1_500n, 300n);
		await packLot(39_000_000n, 0n, 1_500n, 300n);
		await packLot(59_000_000n, 20_000_000n, 1_500n, 300n);
		expect(await eligible()).toEqual(new Set([safe]));
	});
});

function eligible() {
	return database.read((tx) => findPaidFundedCreditLotIds(accountId, policy, tx));
}

async function subscriptionLot(
	provider: "paypal" | "waffo",
	paid: bigint,
	credits: bigint,
	periods = 1,
	refunded = 0n,
) {
	const id = randomUUID();
	const lotId = `lot-${id}`;
	const grantReferenceKey = `${provider}-payment:${id}:period:0:grant`;
	await database.rows(`INSERT INTO ${database.table("billing_plan")} VALUES ($1, $2, 'USD')`, [
		id,
		provider,
	]);
	await database.rows(
		`INSERT INTO ${database.table("subscription")} VALUES ($1, $1, $2, 'USER', $3)`,
		[id, provider, accountId],
	);
	for (let index = 0; index < periods; index++) {
		await database.rows(
			`INSERT INTO ${database.table("billing_period")} VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			[
				`period-${id}-${index}`,
				id,
				index === 0 ? grantReferenceKey : `${grantReferenceKey}:future:${index}`,
				credits,
				index === 0 ? "ACTIVE" : "PENDING",
				`payment-${id}`,
				paid,
				refunded,
			],
		);
	}
	await database.rows(`INSERT INTO ${database.table("credit_lot")} VALUES ($1,$2,$3,$4,$4)`, [
		lotId,
		accountId,
		grantReferenceKey,
		credits,
	]);
	return { lotId, lastPeriodId: `period-${id}-${periods - 1}` };
}

async function packLot(paid: bigint, refunded: bigint, base: bigint, bonus: bigint) {
	const id = randomUUID();
	const grantReferenceKey = `credit-pack:${id}:grant:v1`;
	await database.rows(
		`INSERT INTO ${database.table("credit_pack_fulfillment")} VALUES ($1,$2,'USER',$3,'USD',$4,$5,$6,$7,$8,$9)`,
		[
			id,
			grantReferenceKey,
			accountId,
			refunded ? "PARTIALLY_REFUNDED" : "FULFILLED",
			paid,
			refunded,
			base + bonus,
			base,
			bonus,
		],
	);
	await database.rows(`INSERT INTO ${database.table("credit_lot")} VALUES ($1,$2,$3,$4,$4)`, [
		id,
		accountId,
		grantReferenceKey,
		base + bonus,
	]);
	return id;
}
