import { getTableConfig as getMySqlTableConfig } from "drizzle-orm/mysql-core";
import { getTableConfig as getPostgresTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { purchase as mySqlPurchase } from "./schema/mysql";
import { purchase as postgresPurchase } from "./schema/postgres";
import { purchase as sqlitePurchase } from "./schema/sqlite";
import { PurchaseInsertSchema, PurchaseSchema } from "./zod";

const purchase = {
	id: "purchase_1",
	organizationId: null,
	userId: null,
	type: "SUBSCRIPTION",
	customerId: "cus_1",
	subscriptionId: null,
	priceId: "price_1",
	status: null,
	createdAt: new Date("2026-08-23T00:00:00.000Z"),
	updatedAt: null,
} as const;

describe("Drizzle purchase owner contracts", () => {
	it("requires exactly one owner for new purchase inserts", () => {
		expect(PurchaseInsertSchema.safeParse({ ...purchase, userId: "user_1" }).success).toBe(true);
		expect(PurchaseInsertSchema.safeParse(purchase).success).toBe(false);
		expect(
			PurchaseInsertSchema.safeParse({
				...purchase,
				organizationId: "organization_1",
				userId: "user_1",
			}).success,
		).toBe(false);
	});

	it("keeps selected historical purchase rows tolerant of invalid owner combinations", () => {
		expect(PurchaseSchema.safeParse(purchase).success).toBe(true);
	});

	it("declares one-owner checks for PostgreSQL, MySQL, and SQLite schemas", () => {
		for (const checks of [
			getPostgresTableConfig(postgresPurchase).checks,
			getMySqlTableConfig(mySqlPurchase).checks,
			getSqliteTableConfig(sqlitePurchase).checks,
		]) {
			expect(checks.map((check) => check.name)).toContain("purchase_exactly_one_owner");
		}
	});
});
