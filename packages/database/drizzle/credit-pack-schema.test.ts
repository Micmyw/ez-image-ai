import { getTableConfig as getMySqlTableConfig } from "drizzle-orm/mysql-core";
import { getTableConfig as getPostgresTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import * as mySqlSchema from "./schema/mysql";
import * as postgresSchema from "./schema/postgres";
import * as sqliteSchema from "./schema/sqlite";

describe("credit-pack persistence schema parity", () => {
	it("discriminates plans from credit packs in every maintained schema", () => {
		const configs = [
			getPostgresTableConfig(postgresSchema.purchase),
			getPostgresTableConfig(postgresSchema.billingPlan),
			getPostgresTableConfig(postgresSchema.paymentCheckoutIntent),
			getMySqlTableConfig(mySqlSchema.purchase),
			getMySqlTableConfig(mySqlSchema.billingPlan),
			getMySqlTableConfig(mySqlSchema.paymentCheckoutIntent),
			getSqliteTableConfig(sqliteSchema.purchase),
			getSqliteTableConfig(sqliteSchema.billingPlan),
			getSqliteTableConfig(sqliteSchema.paymentCheckoutIntent),
		];

		for (const config of configs) {
			expect(config.columns.map((column) => column.name)).toContain("productKind");
		}
	});

	it("stores fulfillment, adjustment, and frozen checkout evidence in every variant", () => {
		const variants = [
			{
				schema: postgresSchema as Record<string, unknown>,
				getConfig: getPostgresTableConfig as (table: never) => { columns: { name: string }[] },
			},
			{
				schema: mySqlSchema as Record<string, unknown>,
				getConfig: getMySqlTableConfig as (table: never) => { columns: { name: string }[] },
			},
			{
				schema: sqliteSchema as Record<string, unknown>,
				getConfig: getSqliteTableConfig as (table: never) => { columns: { name: string }[] },
			},
		];

		for (const { schema, getConfig } of variants) {
			expect(schema.creditPackFulfillment).toBeDefined();
			expect(schema.creditPackAdjustment).toBeDefined();
			if (!schema.creditPackFulfillment || !schema.creditPackAdjustment) continue;

			const intentColumns = getConfig(schema.paymentCheckoutIntent as never).columns.map(
				(column) => column.name,
			);
			expect(intentColumns).toEqual(
				expect.arrayContaining([
					"creditPackCatalogVersion",
					"creditPackPricingVersion",
					"creditPackSubscriberEligibilityVersion",
					"creditPackBaseCredits",
					"creditPackBonusCredits",
					"creditPackTotalCredits",
					"creditPackExpiryMonths",
					"creditPackSubscriberBonusEligible",
					"creditPackSubscriberSubscriptionId",
					"creditPackSubscriberPlanKey",
					"creditPackEligibilityEvaluatedAt",
				]),
			);
			expect(
				getConfig(schema.creditPackFulfillment as never).columns.map((column) => column.name),
			).toEqual(
				expect.arrayContaining([
					"providerOrderId",
					"providerPaymentId",
					"grantReferenceKey",
					"refundedAmountMicros",
					"refundedCredits",
				]),
			);
			expect(
				getConfig(schema.creditPackAdjustment as never).columns.map((column) => column.name),
			).toEqual(expect.arrayContaining(["providerAdjustmentId", "refundReferenceKey"]));
		}
	});

	it("enforces one fulfillment for each provider order in every variant", () => {
		const variants = [
			getPostgresTableConfig(postgresSchema.creditPackFulfillment),
			getMySqlTableConfig(mySqlSchema.creditPackFulfillment),
			getSqliteTableConfig(sqliteSchema.creditPackFulfillment),
		] as unknown as Array<{
			indexes: Array<{ config: { name: string; unique: boolean } }>;
		}>;

		for (const config of variants) {
			expect(
				config.indexes.some(
					(index) =>
						index.config.name === "credit_pack_fulfillment_provider_order_uidx" &&
						index.config.unique,
				),
			).toBe(true);
		}
	});
});
