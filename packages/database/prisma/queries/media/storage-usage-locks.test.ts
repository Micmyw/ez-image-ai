import { getTableConfig as getMySqlTableConfig } from "drizzle-orm/mysql-core";
import { getTableConfig as getPostgresTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	isStorageFreshReadEnabled as isDrizzleStorageFreshReadEnabled,
	lockOwnerStorageUsage as lockDrizzleOwnerStorageUsage,
} from "../../../drizzle/queries/media-storage-locks";
import { mediaOwnerStorageFence as mysqlFence } from "../../../drizzle/schema/mysql";
import { mediaOwnerStorageFence as postgresFence } from "../../../drizzle/schema/postgres";
import { mediaOwnerStorageFence as sqliteFence } from "../../../drizzle/schema/sqlite";
import type { Prisma } from "../../generated/client";
import { isStorageFreshReadEnabled, lockOwnerStorageUsage } from "./storage-usage-locks";

afterEach(() => vi.unstubAllEnvs());

describe("owner storage isolation fence", () => {
	it.each([undefined, "", "false", "TRUE", "1", "true "])(
		"keeps fresh-read isolation disabled for %s",
		(value) => {
			vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", value);
			expect(isStorageFreshReadEnabled()).toBe(false);
			expect(isDrizzleStorageFreshReadEnabled()).toBe(false);
		},
	);

	it("enables fresh-read isolation only with explicit true", () => {
		vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "true");
		expect(isStorageFreshReadEnabled()).toBe(true);
		expect(isDrizzleStorageFreshReadEnabled()).toBe(true);
	});

	it("waits for the advisory lock before writing the fence even while fresh reads are disabled", async () => {
		vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "false");
		let release!: () => void;
		const lock = new Promise<void>((resolve) => {
			release = resolve;
		});
		const execute = vi
			.fn()
			.mockImplementationOnce(() => lock)
			.mockResolvedValue(1);
		const operation = lockOwnerStorageUsage({ ownerType: "USER", ownerId: "owner-1" }, {
			$executeRaw: execute,
		} as unknown as Prisma.TransactionClient);
		expect(execute).toHaveBeenCalledTimes(1);
		release();
		await operation;
		expect(execute).toHaveBeenCalledTimes(2);
		const [statement, ...values] = execute.mock.calls[1]!;
		expect((statement as TemplateStringsArray).join("?")).toContain(
			"DO UPDATE SET revision = media_owner_storage_fence.revision + 1",
		);
		expect(values).toEqual(["USER", "owner-1"]);
	});

	it("propagates the fence serialization failure so the entire admission can retry", async () => {
		const conflict = new Error("serialization conflict");
		const execute = vi.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(conflict);
		await expect(
			lockOwnerStorageUsage({ ownerType: "USER", ownerId: "owner-1" }, {
				$executeRaw: execute,
			} as unknown as Prisma.TransactionClient),
		).rejects.toBe(conflict);
	});

	it("keeps the alternate PostgreSQL writer on the same advisory and row fences", async () => {
		const execute = vi.fn().mockResolvedValue({ rowCount: 1 });
		await lockDrizzleOwnerStorageUsage({ ownerType: "ORGANIZATION", ownerId: "owner-'1" }, {
			execute,
		} as unknown as Parameters<typeof lockDrizzleOwnerStorageUsage>[1]);
		const dialect = new PgDialect();
		const statements = execute.mock.calls.map(([query]) => dialect.sqlToQuery(query));
		expect(statements).toHaveLength(2);
		expect(statements[0]?.params).toEqual(["media-owner-storage-usage:ORGANIZATION:owner-'1"]);
		expect(statements[1]?.params).toEqual(["ORGANIZATION", "owner-'1"]);
		expect(statements[1]?.sql).toContain(
			"DO UPDATE SET revision = media_owner_storage_fence.revision + 1",
		);
	});

	it("keeps the composite identity and revision in all maintained schema variants", () => {
		for (const config of [
			getPostgresTableConfig(postgresFence),
			getMySqlTableConfig(mysqlFence),
			getSqliteTableConfig(sqliteFence),
		]) {
			expect(config.name).toBe("media_owner_storage_fence");
			expect(config.primaryKeys).toHaveLength(1);
			expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
				"ownerType",
				"ownerId",
			]);
			expect(config.columns.every((column) => column.notNull)).toBe(true);
			expect(config.columns.find((column) => column.name === "revision")?.default).toBe(0n);
		}
	});
});
