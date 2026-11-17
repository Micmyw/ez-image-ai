import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PaidCreditFundingPostgresPort } from "../../../test-support/paid-credit-funding-postgres-port";
import { hasSpendablePurchasedImageCredits } from "./image-credit-access";

const database = new PaidCreditFundingPostgresPort();
beforeAll(async () => {
	await database.initialize();
	await database.rows(`ALTER TABLE ${database.table("credit_lot")} ADD COLUMN "expiresAt" timestamptz;
		ALTER TABLE ${database.table("credit_pack_fulfillment")} ADD COLUMN "expiresAt" timestamptz DEFAULT '2099-01-01';`);
});
beforeEach(async () => {
	await database.reset();
	await database.rows(`INSERT INTO ${database.table("credit_account")} VALUES ('account','USER','owner');
		INSERT INTO ${database.table("credit_lot")} VALUES ('lot','account','purchase',500,500,'2099-01-01');`);
});
afterAll(() => database.close());

const access = (ownerId = "owner") =>
	database.read(async (tx) => {
		await tx.$queryRaw`SELECT set_config('search_path', ${database.schema}, true)`;
		return hasSpendablePurchasedImageCredits(ownerId, tx);
	});
async function pack() {
	// A discounted pack with bonus credits has no per-credit revenue threshold.
	await database.rows(`INSERT INTO ${database.table("credit_pack_fulfillment")} VALUES
		('pack','purchase','USER','owner','USD','FULFILLED',1,0,500,400,100,'2099-01-01');`);
}

describe("shared image credit access from actual SQL", () => {
	it("does not treat gifted credits or another owner's purchase as paid model access", async () => {
		expect(await access()).toBe(false);
		await pack();
		expect(await access()).toBe(true);
		expect(await access("another-owner")).toBe(false);
		await database.rows(
			`UPDATE ${database.table("credit_pack_fulfillment")} SET "ownerId"='another-owner'`,
		);
		expect(await access()).toBe(false);
	});
	it.each([
		["credit_lot", '"remainingAmount"=0'],
		["credit_lot", "\"expiresAt\"=clock_timestamp() - interval '1 second'"],
		["credit_pack_fulfillment", "\"expiresAt\"=clock_timestamp() - interval '1 second'"],
		["credit_pack_fulfillment", '"refundedAmountMicros"="paidAmountMicros"'],
		["credit_pack_fulfillment", "status='REFUNDED'"],
	])("rechecks exhausted, expired or refunded %s (%s)", async (table, change) => {
		await pack();
		expect(await access()).toBe(true);
		await database.rows(`UPDATE ${database.table(table)} SET ${change}`);
		expect(await access()).toBe(false);
	});
	it("keeps remaining purchased subscription credits usable and rechecks refunds", async () => {
		await database.rows(`INSERT INTO ${database.table("subscription")} VALUES ('sub','plan','paypal','USER','owner');
			INSERT INTO ${database.table("billing_period")} VALUES ('period','sub','purchase',500,'ACTIVE','payment',100,0);`);
		expect(await access()).toBe(true);
		await database.rows(`UPDATE ${database.table("billing_period")} SET "refundedAmount"=100`);
		expect(await access()).toBe(false);
	});
});
