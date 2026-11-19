import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runPortraitPackMigration, type PortraitMigrationCommand } from "./portrait-pack-migration";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const directory = path.join(root, "packages/database/prisma/migrations");
const files = await Promise.all(
	(await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && entry.name <= "20261119133000_portrait_pack_trial")
		.map(async (entry) => ({
			name: entry.name,
			sql: await readFile(path.join(directory, entry.name, "migration.sql"), "utf8"),
		})),
);
const sha = "a".repeat(40);
const secret = "PRIVATE_BUILD_PASSWORD";
const url = `postgresql://ezpic_app:${secret}@db.cresrmesgalqdgbxtyvm.supabase.co:5432/postgres?sslmode=verify-full&schema=public`;
const environment = {
	WORKERS_CI: "1",
	WORKERS_CI_BRANCH: "main",
	WORKERS_CI_COMMIT_SHA: sha,
	WORKERS_CI_WORKER_NAME: "ezimageai-site-production",
	npm_execpath: "/runner/pnpm.cjs",
	CLOUDFLARE_BUILD_PRIVATE: secret,
	NODE_OPTIONS: `--private-${secret}`,
	PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: "1",
};

function harness(fail?: string, failureStatus: number | null = 1) {
	const commands: PortraitMigrationCommand[] = [];
	const logs: string[] = [];
	let bundleReads = 0;
	return {
		commands,
		logs,
		bundleReads: () => bundleReads,
		options: {
			args: ["--apply", "--expected-commit", sha],
			root,
			files,
			gitHead: sha,
			gitClean: true,
			environment,
			loadBundle: () => {
				bundleReads++;
				return `DATABASE_URL=${url}\nOTHER_SECRET=${secret}\n`;
			},
			log: (line: string) => logs.push(line),
			execute: (command: PortraitMigrationCommand) => {
				commands.push(command);
				return {
					status: command.stage === fail ? failureStatus : 0,
					stdout: secret,
					stderr: secret,
				};
			},
		},
	};
}

describe("one-time Portrait Packs migration", () => {
	it("can validate the checked-in plan without accessing even the credential bundle", async () => {
		const h = harness();
		await expect(runPortraitPackMigration({ ...h.options, args: [] })).resolves.toBe("plan");
		expect(h.bundleReads()).toBe(0);
		expect(h.commands).toEqual([]);
	});

	it.each([
		{ args: ["--apply"] },
		{ args: ["--apply", "--expected-commit", sha.slice(0, 7)] },
		{ args: ["--apply", "--expected-commit", sha, "--force"] },
		{ gitHead: "b".repeat(40) },
		{ gitClean: false },
		{ environment: { ...environment, WORKERS_CI: "0" } },
		{ environment: { ...environment, WORKERS_CI_BRANCH: "preview" } },
		{ environment: { ...environment, WORKERS_CI_COMMIT_SHA: "b".repeat(40) } },
		{ environment: { ...environment, WORKERS_CI_WORKER_NAME: "another-worker" } },
	])("rejects unapproved source or action before reading any build secret: %o", async (change) => {
		const h = harness();
		await expect(runPortraitPackMigration({ ...h.options, ...change })).rejects.toThrow(
			/^PORTRAIT_PACK_/,
		);
		expect(h.bundleReads()).toBe(0);
		expect(h.commands).toEqual([]);
	});

	it("refuses changed portrait SQL or migration manifests before accessing the bundle", async () => {
		const h = harness();
		const target = files.find((file) => file.name === "20261119133000_portrait_pack_trial")!;
		for (const changed of [
			files.map((file) => (file === target ? { ...file, sql: target.sql + "-- changed" } : file)),
			[...files, { name: "20261119140000_other_release", sql: "SELECT 1;" }],
			files.slice(1),
		]) {
			await expect(runPortraitPackMigration({ ...h.options, files: changed })).rejects.toThrow(
				"PORTRAIT_PACK_ARTIFACT_MISMATCH",
			);
		}
		expect(h.bundleReads()).toBe(0);
		expect(h.commands).toEqual([]);
	});

	it.each([
		url.replace("cresrmesgalqdgbxtyvm", "another-project"),
		url.replace(":5432/", ":6543/"),
		url.replace("/postgres?", "/another?"),
		url.replace("ezpic_app", "postgres"),
		url.replace("verify-full", "prefer"),
		url.replace("sslmode=verify-full", "sslmode=verify-full&sslmode=require"),
		url.replace("schema=public", "schema=other"),
		`${url}&options=-csearch_path%3Dother`,
	])("rejects a changed production connection before running a child", async (database) => {
		const h = harness();
		await expect(
			runPortraitPackMigration({ ...h.options, loadBundle: () => `DATABASE_URL=${database}` }),
		).rejects.toThrow("PORTRAIT_PACK_TARGET_INVALID");
		expect(h.commands).toEqual([]);
	});

	it("preflights, applies via official Prisma, and verifies the receipt and catalog", async () => {
		const h = harness();
		await expect(runPortraitPackMigration(h.options)).resolves.toBe("applied");
		expect(h.commands.map((command) => [command.stage, command.args])).toEqual([
			["preflight", ["db", "execute", "--stdin"]],
			["deploy", ["migrate", "deploy"]],
			["catalog", ["db", "execute", "--stdin"]],
			["status", ["migrate", "status"]],
		]);
		const before = h.commands[0]!.input!;
		const after = h.commands[2]!.input!;
		expect(before).toContain("BEGIN TRANSACTION READ ONLY");
		expect(before).toContain("20261114090000_guest_lifetime_entitlement");
		expect(before).toContain("a6b483e53252d73ca4255775fc02d5c8a6ecdb6f415e129deb3637c24661ebdc");
		expect(before).toContain("20261119133000_portrait_pack_trial");
		expect(after).toContain("portrait_pack_trial_slot_range");
		expect(after).toContain("relrowsecurity");
		expect(after).toContain("4cf6a969702ea1444b6907dcf7ca3badce4a3a689e5fef22e2c1a56ca49d46a3");
		expect(h.commands[1]!.input).toBeUndefined();
		const childEnvironment = h.commands[1]!.environment;
		expect(childEnvironment.CLOUDFLARE_BUILD_PRIVATE).toBeUndefined();
		expect(childEnvironment.NODE_OPTIONS).toBeUndefined();
		expect(childEnvironment.PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK).toBeUndefined();
		const database = new URL(childEnvironment.DATABASE_URL!);
		expect(database.searchParams.get("sslmode")).toBe("require");
		expect(database.searchParams.get("sslaccept")).toBe("strict");
		expect(database.searchParams.get("sslcert")).toBe(
			path.join(root, "tooling/certificates/supabase-prod-ca-2021.crt"),
		);
		expect(h.logs.join("\n")).not.toContain(secret);
		expect(h.logs.at(-1)).toBe("PORTRAIT_PACK_APPLIED_VERIFIED");
	});

	it.each([
		["preflight", 1, ["preflight"]],
		["deploy", null, ["preflight", "deploy"]],
		["catalog", 1, ["preflight", "deploy", "catalog"]],
		["status", 1, ["preflight", "deploy", "catalog", "status"]],
	] as const)(
		"never retries or leaks output after a failed %s",
		async (stage, status, expected) => {
			const h = harness(stage, status);
			await expect(runPortraitPackMigration(h.options)).rejects.toThrow(/^PORTRAIT_PACK_CHILD_/);
			expect(h.commands.map((command) => command.stage)).toEqual(expected);
			expect(h.logs.join("\n")).not.toContain(secret);
			expect(h.logs).not.toContain("PORTRAIT_PACK_APPLIED_VERIFIED");
		},
	);
});
