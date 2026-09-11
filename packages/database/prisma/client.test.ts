import { afterEach, describe, expect, it, vi } from "vitest";

import { db, runWithDatabaseClient, createRuntimeDatabaseClient } from "./client";
import type { PrismaClient } from "./generated/client";
import { getMediaDatabaseClient } from "./queries/media/types";

function client(label: string) {
	const value = {
		user: { findMany: vi.fn(async () => [label]) },
		$transaction: vi.fn(function (this: unknown) {
			return this;
		}),
	};
	return value as unknown as PrismaClient;
}

afterEach(() => vi.unstubAllEnvs());

describe("database runtime scope", () => {
	it("routes overlapping asynchronous requests to their own clients", async () => {
		const first = client("first");
		const second = client("second");
		let release!: () => void;
		const ready = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = runWithDatabaseClient(first, async () => {
			await ready;
			expect(getMediaDatabaseClient()).toBe(first);
			return db.user.findMany();
		});
		await runWithDatabaseClient(second, async () => {
			expect(await db.user.findMany()).toEqual(["second"]);
			expect(getMediaDatabaseClient()).toBe(second);
			release();
		});
		expect(await pending).toEqual(["first"]);
	});

	it("restores the outer scope after nested failure and binds client methods", async () => {
		const outer = client("outer");
		const inner = client("inner");
		await runWithDatabaseClient(outer, async () => {
			await expect(
				runWithDatabaseClient(inner, async () => {
					expect(getMediaDatabaseClient()).toBe(inner);
					throw new Error("nested failure");
				}),
			).rejects.toThrow("nested failure");
			expect(getMediaDatabaseClient()).toBe(outer);
			expect(db.$transaction([])).toBe(outer);
			expect(getMediaDatabaseClient(inner)).toBe(inner);
		});
	});

	it("fails closed outside a Workers request even when a Node URL exists", () => {
		vi.stubEnv("EZPIC_RUNTIME", "workers");
		vi.stubEnv("DATABASE_URL", "postgresql://unused:unused@localhost/unused");
		expect(() => db.user.findMany()).toThrow("DATABASE_REQUEST_SCOPE_REQUIRED");
		expect(() => getMediaDatabaseClient()).toThrow("DATABASE_REQUEST_SCOPE_REQUIRED");
	});

	it("constructs separate request clients without opening connections", async () => {
		const url = "postgresql://unused:unused@localhost/unused";
		const first = createRuntimeDatabaseClient(url);
		const second = createRuntimeDatabaseClient(url);
		expect(first).not.toBe(second);
		await Promise.all([first.$disconnect(), second.$disconnect()]);
	});
});
