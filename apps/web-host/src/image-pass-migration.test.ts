import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	CANONICAL_SHA256,
	ENVELOPE_SHA256,
	MIGRATION_NAME,
	createImagePassPlan,
	runImagePassMigration,
	type MigrationCommand,
	type MigrationFile,
	type CommandResult,
} from "./image-pass-migration";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDirectory = path.join(root, "packages/database/prisma/migrations");
const files: MigrationFile[] = await Promise.all(
	(await readdir(migrationsDirectory, { withFileTypes: true }))
		// This one-time release tool is pinned to its original reviewed migration set.
		// New migrations must not expand the fixture or its production guard.
		.filter((entry) => entry.isDirectory() && entry.name <= MIGRATION_NAME)
		.map(async (entry) => ({
			name: entry.name,
			sql: await readFile(path.join(migrationsDirectory, entry.name, "migration.sql"), "utf8"),
		})),
);
const sha = "a".repeat(40);
const secret = "DO_NOT_PRINT_PRIVATE_VALUE";
const databaseUrl = `postgresql://ezpic_app:${secret}@db.cresrmesgalqdgbxtyvm.supabase.co:5432/postgres?sslmode=verify-full&schema=public`;
const environment = {
	WORKERS_CI: "1",
	WORKERS_CI_BRANCH: "main",
	WORKERS_CI_COMMIT_SHA: sha,
	npm_execpath: "/runner/pnpm.cjs",
	CLOUDFLARE_PRODUCTION_ENV: `DATABASE_URL=${databaseUrl}\nPRIVATE_KEY=${secret}\n`,
	CLOUDFLARE_API_TOKEN: secret,
	NODE_OPTIONS: `--private-${secret}`,
};

function harness(failStage?: string, failure: CommandResult = { status: 1, stderr: secret }) {
	const commands: MigrationCommand[] = [];
	const logs: string[] = [];
	const envelopes: string[] = [];
	const execute = async (command: MigrationCommand) => {
		commands.push(command);
		return command.stage === failStage ? failure : { status: 0, stdout: secret, stderr: secret };
	};
	const options = {
		args: ["--apply", "--expected-commit", sha],
		root,
		gitHead: sha,
		gitClean: true,
		files,
		environment,
		execute,
		withEnvelope: async <T>(sql: string, use: (filename: string) => Promise<T>) => {
			envelopes.push(sql);
			return use("/tmp/reviewed-image-pass.sql");
		},
		log: (line: string) => logs.push(line),
	};
	return { commands, logs, envelopes, options };
}

describe("one-time image-pass migration", () => {
	it("defaults to a local plan without reading build bindings or running a child", async () => {
		const h = harness();
		const result = await runImagePassMigration({
			...h.options,
			args: [],
			environment: new Proxy(
				{},
				{
					get: () => {
						throw new Error(secret);
					},
				},
			),
		});
		expect(result).toBe("plan");
		expect(h.commands).toEqual([]);
		expect(h.envelopes).toEqual([]);
		expect(h.logs).toEqual(["IMAGE_PASS_PLAN_READY"]);
	});

	it("preserves canonical SQL and builds only the reviewed timeout envelope", () => {
		const before = files.find((file) => file.name === MIGRATION_NAME)!.sql;
		const plan = createImagePassPlan(files);
		expect(createHash("sha256").update(before).digest("hex")).toBe(CANONICAL_SHA256);
		expect(createHash("sha256").update(plan.envelope).digest("hex")).toBe(ENVELOPE_SHA256);
		expect(plan.envelope).toBe(
			before.replace(
				"BEGIN;\n",
				"BEGIN;\nSET LOCAL lock_timeout = '3s';\nSET LOCAL statement_timeout = '30s';\n",
			),
		);
		expect(files.find((file) => file.name === MIGRATION_NAME)!.sql).toBe(before);
		expect(plan.history).toHaveLength(66);
		expect(plan.history.every((entry) => entry.checksums.length === 2)).toBe(true);
	});

	it.each([
		["missing explicit commit", ["--apply"]],
		["abbreviated commit", ["--apply", "--expected-commit", sha.slice(0, 7)]],
		["unknown flag", ["--apply", "--expected-commit", sha, "--force"]],
		["duplicate flag", ["--apply", "--apply", "--expected-commit", sha]],
	])("rejects %s before any database access", async (_name, args) => {
		const h = harness();
		await expect(runImagePassMigration({ ...h.options, args })).rejects.toThrow(
			"IMAGE_PASS_ARGUMENTS_INVALID",
		);
		expect(h.commands).toHaveLength(0);
		expect(h.envelopes).toHaveLength(0);
	});

	it.each([
		{ gitHead: "b".repeat(40) },
		{ gitClean: false },
		{ environment: { ...environment, WORKERS_CI: "0" } },
		{ environment: { ...environment, WORKERS_CI_BRANCH: "preview" } },
		{ environment: { ...environment, WORKERS_CI_COMMIT_SHA: "b".repeat(40) } },
	])(
		"rejects an unapproved source or build context before database access: %j",
		async (override) => {
			const h = harness();
			await expect(runImagePassMigration({ ...h.options, ...override })).rejects.toThrow();
			expect(h.commands).toHaveLength(0);
			expect(h.envelopes).toHaveLength(0);
		},
	);

	it.each([
		databaseUrl.replace("cresrmesgalqdgbxtyvm", "anotherproject"),
		databaseUrl.replace("/postgres?", "/another_database?"),
		databaseUrl.replace(":5432", ":6543"),
		databaseUrl.replace("schema=public", "schema=private"),
		databaseUrl.replace("verify-full", "require"),
		`${databaseUrl}&host=attacker.invalid`,
		`${databaseUrl}&options=-c%20search_path%3Dprivate`,
	])("rejects a changed target or weaker TLS without echoing its URL", async (url) => {
		const h = harness();
		let error: unknown;
		try {
			await runImagePassMigration({
				...h.options,
				environment: { ...environment, CLOUDFLARE_PRODUCTION_ENV: `DATABASE_URL=${url}\n` },
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain(secret);
		expect(h.commands).toHaveLength(0);
		expect(h.logs.join("\n")).not.toContain(secret);
	});

	it("rejects SQL changes or extra pending local migrations before accessing a binding", async () => {
		const h = harness();
		for (const changed of [
			files.map((file) =>
				file.name === MIGRATION_NAME ? { ...file, sql: `${file.sql}\n` } : file,
			),
			[...files, { name: "20261020000000_unreviewed", sql: "SELECT 1;" }],
		]) {
			await expect(runImagePassMigration({ ...h.options, files: changed })).rejects.toThrow(
				"IMAGE_PASS_ARTIFACT_MISMATCH",
			);
		}
		expect(h.commands).toHaveLength(0);
	});

	it("executes only the bounded file, validates it, then lets Prisma record and verify history", async () => {
		const h = harness();
		expect(await runImagePassMigration(h.options)).toBe("applied");
		expect(h.commands.map((command) => command.stage)).toEqual([
			"preflight",
			"apply",
			"catalog",
			"resolve",
			"status",
			"receipt",
		]);
		expect(h.commands[1].args.slice(-4)).toEqual([
			"db",
			"execute",
			"--file",
			"/tmp/reviewed-image-pass.sql",
		]);
		expect(h.commands[3].args.slice(-4)).toEqual([
			"migrate",
			"resolve",
			"--applied",
			MIGRATION_NAME,
		]);
		expect(h.commands[4].args.slice(-2)).toEqual(["migrate", "status"]);
		for (const command of h.commands) {
			expect(command.args.join(" ")).not.toMatch(/migrate (deploy|dev|reset)|db push/);
			expect(command.args.join(" ")).not.toContain(secret);
			expect(command.environment.DATABASE_URL).toContain(secret);
			expect(command.environment.CLOUDFLARE_PRODUCTION_ENV).toBeUndefined();
			expect(command.environment.CLOUDFLARE_API_TOKEN).toBeUndefined();
			expect(command.environment.NODE_OPTIONS).toBeUndefined();
		}
		expect(h.envelopes).toHaveLength(1);
		expect(h.logs.at(-1)).toBe("IMAGE_PASS_APPLIED_VERIFIED");
		expect(h.logs.join("\n")).not.toContain(secret);
	});

	it.each(["preflight", "apply", "catalog", "resolve", "status", "receipt"])(
		"stops after a failed %s without retrying or advancing",
		async (stage) => {
			const h = harness(stage);
			await expect(runImagePassMigration(h.options)).rejects.toThrow("IMAGE_PASS_CHILD_FAILED");
			expect(h.commands.at(-1)?.stage).toBe(stage);
			expect(h.commands.filter((command) => command.stage === stage)).toHaveLength(1);
			if (stage === "preflight") expect(h.envelopes).toHaveLength(0);
			expect(h.logs.join("\n")).not.toContain(secret);
			expect(h.logs).not.toContain("IMAGE_PASS_APPLIED_VERIFIED");
		},
	);

	it("treats a killed child as uncertain and never resolves or retries", async () => {
		const h = harness("apply", { status: null, stderr: `${secret} IMAGE_PASS_GUARD_HISTORY` });
		await expect(runImagePassMigration(h.options)).rejects.toThrow("IMAGE_PASS_CHILD_UNCERTAIN");
		expect(h.commands.map((command) => command.stage)).toEqual(["preflight", "apply"]);
		expect(h.logs.join("\n")).not.toContain(secret);
	});

	it("does not expose thrown executor exceptions or arbitrary stderr error codes", async () => {
		const h = harness();
		await expect(
			runImagePassMigration({
				...h.options,
				execute: async () => {
					throw new Error(secret);
				},
			}),
		).rejects.toThrow("IMAGE_PASS_CHILD_UNCERTAIN");
		expect(h.logs.join("\n")).not.toContain(secret);
		const failed = harness("preflight", {
			status: 1,
			stderr: `${secret}\nP1012\nIMAGE_PASS_GUARD_HISTORY\nIMAGE_PASS_EVIL_SECRET`,
		});
		await expect(runImagePassMigration(failed.options)).rejects.toThrow("IMAGE_PASS_CHILD_FAILED");
		expect(failed.logs.join("\n")).toContain("IMAGE_PASS_GUARD_HISTORY");
		expect(failed.logs.join("\n")).not.toMatch(/P1012|EVIL|DO_NOT_PRINT/);
	});

	it("generates read-only guards for both catalog states and a canonical Prisma receipt", () => {
		const plan = createImagePassPlan(files);
		for (const sql of [plan.preflightSql, plan.catalogSql, plan.receiptSql]) {
			expect(sql).toMatch(/^BEGIN READ ONLY;/);
			expect(sql).toMatch(/COMMIT;\s*$/);
			expect(sql).not.toMatch(
				/\b(?:INSERT INTO|UPDATE public|DELETE FROM|ALTER TABLE|CREATE TABLE)\b/i,
			);
			expect(sql).toContain("has_schema_privilege");
			expect(sql).toContain("has_table_privilege");
		}
		expect(plan.preflightSql).toContain("finished_at IS NULL AND rolled_back_at IS NULL");
		expect(plan.preflightSql).toContain("generation_job_credits_reserved_positive");
		expect(plan.preflightSql).toContain("payment_checkout_intent_credit_pack_snapshot");
		expect(plan.catalogSql).toContain("generation_job_funding_amount_valid");
		expect(plan.catalogSql).toContain("relrowsecurity");
		expect(plan.catalogSql).toContain("prosecdef");
		expect(plan.catalogSql).toContain("LIMIT 0");
		expect(plan.receiptSql).toContain(CANONICAL_SHA256);
		expect(plan.receiptSql).toContain("IMAGE_PASS_GUARD_RECEIPT");
	});

	it("pins both exact public before-state constraint definitions, rather than trusting their names", () => {
		const plan = createImagePassPlan(files);
		expect(plan.preflightSql).toContain("f4503c140a260ec9a9482dee6c2b6818");
		expect(plan.preflightSql).toContain("5ce83202a53d86359d41a0abbfe585b8");
		expect(plan.preflightSql).toContain("conrelid='public.payment_checkout_intent'::regclass");
		expect(plan.preflightSql).not.toContain("LIKE '%CREDIT_PACK%'");
	});

	it("accepts historical LF/CRLF byte variants without changing the guarded history set", () => {
		const variant = files.map((file) =>
			file.name === MIGRATION_NAME
				? file
				: { ...file, sql: file.sql.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n") },
		);
		expect(createImagePassPlan(variant).history).toEqual(createImagePassPlan(files).history);
	});
});
