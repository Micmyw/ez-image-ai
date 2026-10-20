import { readFileSync } from "node:fs";

import {
	type AnyColumn,
	createTableRelationsHelpers,
	extractTablesRelationalConfig,
	getTableName,
	normalizeRelation,
	type SQL,
	type Table,
} from "drizzle-orm";
import { getTableConfig as getMySqlTableConfig, MySqlDialect } from "drizzle-orm/mysql-core";
import { getTableConfig as getPostgresTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { CreditLedgerEntryType, PaymentProductKind } from "./schema";
import * as mySqlSchema from "./schema/mysql";
import * as postgresSchema from "./schema/postgres";
import * as sqliteSchema from "./schema/sqlite";

const prismaSource = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const modelNames = [
	"AdminServiceAccount",
	"AdminApiKey",
	"AdminExecution",
	"AdminBotConfig",
	"AdminBotReceipt",
	"SupportTicket",
	"SupportTicketMessage",
	"AdminRefundRequest",
] as const;
const scalarTypes = new Set([
	"String",
	"String[]",
	"Json",
	"DateTime",
	"Int",
	"BigInt",
	"Boolean",
	"OwnerType",
	"PaymentProductKind",
]);

type TableConfig = {
	name: string;
	columns: AnyColumn[];
	indexes: { config: { unique?: boolean; columns: { name?: string }[] } }[];
	foreignKeys: {
		onDelete?: string;
		onUpdate?: string;
		reference(): {
			columns: AnyColumn[];
			foreignTable: Table;
			foreignColumns: AnyColumn[];
		};
	}[];
};

const variants = [
	{
		name: "PostgreSQL",
		schema: postgresSchema,
		getConfig: getPostgresTableConfig,
		dialect: new PgDialect(),
	},
	{
		name: "MySQL",
		schema: mySqlSchema,
		getConfig: getMySqlTableConfig,
		dialect: new MySqlDialect(),
	},
	{
		name: "SQLite",
		schema: sqliteSchema,
		getConfig: getSqliteTableConfig,
		dialect: new SQLiteSyncDialect(),
	},
];

function declaration(kind: "model" | "enum", name: string) {
	const match = prismaSource.match(new RegExp(`${kind} ${name} \\{([\\s\\S]*?)\\n\\}`));
	if (!match) throw new Error(`Missing Prisma ${kind} ${name}`);
	return match[1]!;
}

function modelFields(name: string) {
	return [
		...declaration("model", name).matchAll(/^[\t ]+(\w+)[\t ]+(\w+(?:\[\]|\?)?)[\t ]*([^\r\n]*)/gm),
	].map(([, fieldName, type, attributes]) => ({
		name: fieldName!,
		type: type!,
		attributes: attributes!,
	}));
}

function tableName(model: string) {
	return declaration("model", model).match(/@@map\("([^"]+)"\)/)?.[1] ?? model;
}

function exportName(model: string) {
	return model[0]!.toLowerCase() + model.slice(1);
}

function enumValues(name: string) {
	return declaration("enum", name).trim().split(/\s+/);
}

function columnNames(columns: { name?: string }[]) {
	return columns.map((column) => column.name).join(":");
}

describe.each(variants)(
	"$name admin persistence contract",
	({ name, schema, getConfig, dialect }) => {
		function config(model: string) {
			const table = (schema as Record<string, unknown>)[exportName(model)];
			expect(table, `${name} is missing ${model}`).toBeDefined();
			return (getConfig as (table: never) => unknown)(table as never) as TableConfig;
		}

		it.each(modelNames)(
			"matches %s scalar fields, nullability, keys, and defaults to Prisma",
			(model) => {
				const actual = config(model);
				const fields = modelFields(model).filter((field) =>
					scalarTypes.has(field.type.replace(/\?$/, "")),
				);
				expect(actual.name).toBe(tableName(model));
				expect(actual.columns.map((column) => column.name).sort()).toEqual(
					fields.map((field) => field.name).sort(),
				);

				for (const field of fields) {
					const column = actual.columns.find((entry) => entry.name === field.name)!;
					const context = `${model}.${field.name}`;
					expect(column.notNull, context).toBe(!field.type.endsWith("?"));
					expect(column.primary, context).toBe(field.attributes.includes("@id"));
					expect(column.isUnique, context).toBe(field.attributes.includes("@unique"));

					const defaultExpression = field.attributes.match(
						/@default\((cuid\(\)|now\(\)|\[\]|"[^"]*"|\d+|true|false)\)/,
					)?.[1];
					const isUpdatedAt = field.attributes.includes("@updatedAt");
					expect(column.hasDefault, context).toBe(Boolean(defaultExpression || isUpdatedAt));

					if (isUpdatedAt) {
						expect(column.onUpdateFn?.(), context).toBeInstanceOf(Date);
					} else {
						expect(column.onUpdateFn, context).toBeUndefined();
					}

					if (defaultExpression === "cuid()") {
						expect(column.defaultFn?.(), context).toEqual(expect.any(String));
						expect(column.defaultFn?.(), context).not.toBe(column.defaultFn?.());
					} else if (defaultExpression === "now()") {
						const defaultSql = dialect.sqlToQuery(column.default as SQL).sql;
						expect(defaultSql, context).toMatch(
							/now\(\)|CURRENT_TIMESTAMP\(3\)|julianday\('now'\)/i,
						);
					} else if (defaultExpression === "[]") {
						if (name === "PostgreSQL") {
							expect(column.default, context).toEqual([]);
						} else {
							expect(dialect.sqlToQuery(column.default as SQL).sql, context).toMatch(
								/JSON_ARRAY\(\)|'\[\]'/,
							);
						}
					} else if (defaultExpression) {
						expect(column.default, context).toEqual(JSON.parse(defaultExpression));
					} else {
						expect(column.default, context).toBeUndefined();
						expect(column.defaultFn, context).toBeUndefined();
					}
				}
			},
		);

		it.each(modelNames)("preserves %s compound indexes and uniqueness", (model) => {
			const actual = config(model);
			const expectedIndexes = [
				...declaration("model", model).matchAll(/@@(index|unique)\(\[([^\]]+)\]\)/g),
			].map(([, kind, columns]) => ({
				unique: kind === "unique",
				columns: columns!
					.split(",")
					.map((column) => column.trim())
					.join(":"),
			}));
			expect(
				actual.indexes.map((index) => ({
					unique: Boolean(index.config.unique),
					columns: columnNames(index.config.columns),
				})),
			).toEqual(expectedIndexes);
		});

		it.each(modelNames)("preserves %s foreign keys and deletion/update behavior", (model) => {
			const expectedReferences = modelFields(model)
				.filter((field) => field.attributes.includes("@relation"))
				.map((field) => {
					const attributes = field.attributes;
					return {
						columns: attributes.match(/fields: \[([^\]]+)\]/)![1]!,
						foreignTable: tableName(field.type.replace(/\?$/, "")),
						foreignColumns: attributes.match(/references: \[([^\]]+)\]/)![1]!,
						onDelete: attributes.match(/onDelete: (\w+)/)![1]!.toLowerCase(),
						onUpdate: "cascade",
					};
				});
			expect(
				config(model).foreignKeys.map((foreignKey) => {
					const reference = foreignKey.reference();
					return {
						columns: columnNames(reference.columns),
						foreignTable: getTableName(reference.foreignTable),
						foreignColumns: columnNames(reference.foreignColumns),
						onDelete: foreignKey.onDelete,
						onUpdate: foreignKey.onUpdate,
					};
				}),
			).toEqual(expectedReferences);
		});

		it("exposes queryable service-account, ticket, user, and organization relations", () => {
			const extracted = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
			for (const model of [...modelNames, "User", "Organization"]) {
				const relationships = modelFields(model).filter((field) =>
					model === "User" || model === "Organization"
						? field.name === "supportTickets"
						: !scalarTypes.has(field.type.replace(/\?$/, "")),
				);
				for (const field of relationships) {
					const relation = extracted.tables[exportName(model)]!.relations[field.name]!;
					expect(relation, `${model}.${field.name}`).toBeDefined();
					expect(relation.referencedTableName).toBe(tableName(field.type.replace(/\[\]|\?$/, "")));
					expect(() =>
						normalizeRelation(extracted.tables, extracted.tableNamesMap, relation),
					).not.toThrow();
				}
			}
		});

		it("stores array permissions and JSON evidence without changing their value shapes", () => {
			const permissions = config("AdminServiceAccount").columns.find(
				(column) => column.name === "permissions",
			)!;
			expect(permissions.dataType).toBe(name === "PostgreSQL" ? "array" : "json");
			const allowed = ["support:read", "payments:read"];
			const stored = permissions.mapToDriverValue(allowed);
			// MySQL drivers decode native JSON before handing rows to Drizzle.
			const returned = name === "MySQL" ? JSON.parse(stored as string) : stored;
			expect(permissions.mapFromDriverValue(returned)).toEqual(allowed);

			for (const model of modelNames) {
				for (const field of modelFields(model).filter((field) => /^Json\??$/.test(field.type))) {
					const column = config(model).columns.find((entry) => entry.name === field.name)!;
					expect(column.dataType, `${model}.${field.name}`).toBe("json");
				}
			}
		});

		it("retains millisecond timestamps and exact bigint refund amounts", () => {
			const instant = new Date("2026-10-20T01:02:03.456Z");
			for (const model of modelNames) {
				for (const field of modelFields(model).filter((field) =>
					/^DateTime\??$/.test(field.type),
				)) {
					const column = config(model).columns.find((entry) => entry.name === field.name)!;
					if (name === "SQLite") {
						expect(column.mapToDriverValue(instant)).toBe(instant.getTime());
					} else {
						expect(column.getSQLType()).toContain("(3)");
					}
				}
			}

			const amount = config("AdminRefundRequest").columns.find(
				(column) => column.name === "amountMicros",
			)!;
			expect(amount.getSQLType()).toMatch(/bigint|integer/);
			expect(amount.mapFromDriverValue("9007199254740993")).toBe(9007199254740993n);
		});

		it("accepts every current owner and payment product kind in refund requests", () => {
			const refund = config("AdminRefundRequest");
			expect(refund.columns.find((column) => column.name === "ownerType")!.enumValues).toEqual(
				enumValues("OwnerType"),
			);
			for (const model of [
				"AdminRefundRequest",
				"Purchase",
				"BillingPlan",
				"PaymentCheckoutIntent",
			]) {
				expect(
					config(model).columns.find((column) => column.name === "productKind")!.enumValues,
				).toEqual(enumValues("PaymentProductKind"));
			}
		});
	},
);

it("exports the full payment product and credit-ledger enum contracts", () => {
	expect(Object.values(PaymentProductKind)).toEqual(enumValues("PaymentProductKind"));
	expect(Object.values(CreditLedgerEntryType)).toEqual(enumValues("CreditLedgerEntryType"));
});
