import { getTableConfig as getMySqlTableConfig } from "drizzle-orm/mysql-core";
import { getTableConfig as getPostgresTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import {
	paymentCheckoutIntent as mySqlCheckoutIntent,
	paymentCustomer as mySqlPaymentCustomer,
	purchase as mySqlPurchase,
	subscription as mySqlSubscription,
} from "./schema/mysql";
import {
	paymentCheckoutIntent as postgresCheckoutIntent,
	paymentCustomer as postgresPaymentCustomer,
	purchase as postgresPurchase,
	subscription as postgresSubscription,
} from "./schema/postgres";
import {
	paymentCheckoutIntent as sqliteCheckoutIntent,
	paymentCustomer as sqlitePaymentCustomer,
	purchase as sqlitePurchase,
	subscription as sqliteSubscription,
} from "./schema/sqlite";

describe("provider-aware payment schema parity", () => {
	it("scopes purchase and subscription identities by provider in every Drizzle variant", () => {
		const configs = [
			getPostgresTableConfig(postgresPurchase),
			getMySqlTableConfig(mySqlPurchase),
			getSqliteTableConfig(sqlitePurchase),
			getPostgresTableConfig(postgresSubscription),
			getMySqlTableConfig(mySqlSubscription),
			getSqliteTableConfig(sqliteSubscription),
		];

		for (const config of configs) {
			expect(config.columns.map((column) => column.name)).toContain("provider");
			expect(config.indexes.some((index) => index.config.unique)).toBe(true);
		}
	});

	it("declares owner-scoped customer and checkout intent tables in every Drizzle variant", () => {
		const configs = [
			getPostgresTableConfig(postgresPaymentCustomer),
			getMySqlTableConfig(mySqlPaymentCustomer),
			getSqliteTableConfig(sqlitePaymentCustomer),
			getPostgresTableConfig(postgresCheckoutIntent),
			getMySqlTableConfig(mySqlCheckoutIntent),
			getSqliteTableConfig(sqliteCheckoutIntent),
		];

		for (const config of configs) {
			expect(config.columns.map((column) => column.name)).toEqual(
				expect.arrayContaining(["provider", "ownerType", "ownerId"]),
			);
			expect(config.indexes.some((index) => index.config.unique)).toBe(true);
		}
	});
});
