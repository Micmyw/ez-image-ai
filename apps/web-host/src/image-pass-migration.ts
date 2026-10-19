// One-time, separately approved production operation. This is never imported by
// the ordinary build/deploy flow. --apply does not establish backup readiness.
// Apply only from the approved exact main merge SHA after its CI passes, with
// other migrators/builds drained and this build's deploy command set to a no-op.
// A failure after the apply stage may leave committed schema without its Prisma
// receipt. Stop and inspect; do not retry this runner or re-run the DDL blindly.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { readCloudflareBuildEnvironment } from "./build-secrets";
import { assertCloudflareGitCommit, migrationDatabaseUrl } from "./release-environment";

export const MIGRATION_NAME = "20261019010000_image_pass";
export const CANONICAL_SHA256 = "ed215fd662ff62a67595a59dab6e3c62301dc0a7832bb29bc5e90ed411fbe5ab";
export const ENVELOPE_SHA256 = "80327f3c99925fac2d1e8119b263edd4034e44a2813d13bf6041c0db2d991d81";
const stages = ["preflight", "apply", "catalog", "resolve", "status", "receipt"] as const;
type Stage = (typeof stages)[number];
type Environment = Record<string, string | undefined>;
export type MigrationFile = { name: string; sql: string };
export type MigrationCommand = {
	stage: Stage;
	args: string[];
	environment: Environment;
	input?: string;
};
export type CommandResult = {
	status: number | null;
	stdout?: string;
	stderr?: string;
	error?: unknown;
	signal?: string | null;
};
type Options = {
	args: string[];
	root: string;
	gitHead: string;
	gitClean: boolean;
	files: MigrationFile[];
	environment: Environment;
	execute: (command: MigrationCommand) => Promise<CommandResult>;
	withEnvelope: <T>(sql: string, use: (filename: string) => Promise<T>) => Promise<T>;
	log: (line: string) => void;
};

type HistoryFile = { name: string; checksums: string[] };
const tableNames = [
	"image_pass_grant",
	"image_pass_unit",
	"image_pass_reservation",
	"image_pass_ledger_entry",
	"image_pass_adjustment",
];
const functions = [
	"prevent_image_pass_ledger_mutation",
	"assert_image_pass_funding_binding",
	"guard_image_pass_identity",
	"assert_image_pass_three_units",
];
const guardCodes = [
	"IMAGE_PASS_GUARD_TARGET",
	"IMAGE_PASS_GUARD_PRIVILEGES",
	"IMAGE_PASS_GUARD_HISTORY",
	"IMAGE_PASS_GUARD_BEFORE_STATE",
	"IMAGE_PASS_GUARD_LOCKS",
	"IMAGE_PASS_GUARD_CATALOG",
	"IMAGE_PASS_GUARD_RLS",
	"IMAGE_PASS_GUARD_RECEIPT",
];
const safeErrors = new Set([
	"IMAGE_PASS_ARGUMENTS_INVALID",
	"IMAGE_PASS_ARTIFACT_MISMATCH",
	"IMAGE_PASS_SOURCE_MISMATCH",
	"IMAGE_PASS_TARGET_INVALID",
	"IMAGE_PASS_BUILD_ENVIRONMENT_INVALID",
	"IMAGE_PASS_CHILD_FAILED",
	"IMAGE_PASS_CHILD_UNCERTAIN",
	"IMAGE_PASS_LOCAL_IO_FAILED",
]);

function digest(sql: string) {
	return createHash("sha256").update(sql).digest("hex");
}

function literal(value: string) {
	return `'${value.replaceAll("'", "''")}'`;
}

function commonGuard() {
	return `
 IF current_database() <> 'postgres' OR current_schema() <> 'public'
   OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
   OR current_user NOT IN ('postgres','ezpic_app') THEN
  RAISE EXCEPTION 'IMAGE_PASS_GUARD_TARGET';
 END IF;
 IF NOT has_schema_privilege(current_user,'public','CREATE')
   OR NOT has_schema_privilege(current_user,'public','USAGE')
   OR NOT has_language_privilege(current_user,'plpgsql','USAGE')
   OR NOT has_type_privilege(current_user,'public."PaymentProductKind"','USAGE')
   OR NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
     WHERE n.nspname='public' AND t.typname='PaymentProductKind' AND pg_has_role(current_user,t.typowner,'USAGE'))
   OR EXISTS (SELECT 1 FROM (VALUES ('generation_job'),('payment_checkout_intent')) expected(name)
     LEFT JOIN pg_class c ON c.oid=to_regclass('public.' || expected.name)
     WHERE c.oid IS NULL OR NOT pg_has_role(current_user,c.relowner,'USAGE'))
   OR NOT has_table_privilege(current_user,'public.credit_reservation','TRIGGER')
   OR NOT has_table_privilege(current_user,'public.generation_job','REFERENCES')
   OR NOT has_table_privilege(current_user,'public.payment_checkout_intent','REFERENCES')
   OR NOT has_table_privilege(current_user,'public.purchase','REFERENCES')
   OR NOT has_table_privilege(current_user,'public._prisma_migrations','SELECT')
   OR NOT has_table_privilege(current_user,'public._prisma_migrations','INSERT')
   OR NOT has_table_privilege(current_user,'public._prisma_migrations','UPDATE')
   OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ezpic_app' AND NOT rolsuper AND NOT rolbypassrls) THEN
  RAISE EXCEPTION 'IMAGE_PASS_GUARD_PRIVILEGES';
 END IF;
 -- An inactive placeholder still exposes the enum to old readers.
 IF EXISTS (SELECT 1 FROM public.billing_plan WHERE "provider"='paypal'
   AND "providerPriceId"='EZIMAGE-IMAGE-PASS-3-USD-1-20261019')
   OR EXISTS (SELECT 1 FROM public.billing_plan WHERE "productKind"::text='IMAGE_PASS') THEN
  RAISE EXCEPTION 'IMAGE_PASS_GUARD_BEFORE_STATE';
 END IF;
`;
}

function historyGuard(history: HistoryFile[], receipt: boolean) {
	const manifest = history
		.map(
			(entry) =>
				`(${literal(entry.name)},${literal(entry.checksums[0])},${literal(entry.checksums[1])})`,
		)
		.join(",\n");
	return `
 IF EXISTS (SELECT 1 FROM public._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL)
   OR (SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) <> ${receipt ? 67 : 66}
   OR (SELECT count(*) FROM public._prisma_migrations) <> ${receipt ? 68 : 67}
   OR EXISTS (
    WITH local_history(name,lf,crlf) AS (VALUES ${manifest})
    SELECT 1 FROM public._prisma_migrations m LEFT JOIN local_history l ON l.name=m.migration_name
    WHERE m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL AND m.migration_name <> '${MIGRATION_NAME}'
      AND (l.name IS NULL OR m.checksum NOT IN (l.lf,l.crlf)))
   OR EXISTS (
    WITH local_history(name,lf,crlf) AS (VALUES ${manifest})
    SELECT 1 FROM local_history l LEFT JOIN public._prisma_migrations m
     ON m.migration_name=l.name AND m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL
    GROUP BY l.name HAVING count(m.id) <> 1) THEN
  RAISE EXCEPTION 'IMAGE_PASS_GUARD_HISTORY';
 END IF;
 ${
		receipt
			? `IF (SELECT count(*) FROM public._prisma_migrations WHERE migration_name='${MIGRATION_NAME}') <> 1
   OR NOT EXISTS (SELECT 1 FROM public._prisma_migrations WHERE migration_name='${MIGRATION_NAME}'
     AND checksum='${CANONICAL_SHA256}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
  RAISE EXCEPTION 'IMAGE_PASS_GUARD_RECEIPT';
 END IF;`
			: `IF EXISTS (SELECT 1 FROM public._prisma_migrations WHERE migration_name='${MIGRATION_NAME}') THEN
  RAISE EXCEPTION 'IMAGE_PASS_GUARD_HISTORY';
 END IF;`
 }
`;
}

function beforeGuard() {
	// These fingerprints identify the exact public pg_get_constraintdef results
	// reviewed on 2026-10-19. SQL artifact integrity separately uses SHA-256.
	return `
 IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace
     WHERE n.nspname='public' AND t.typname='PaymentProductKind' AND e.enumlabel='IMAGE_PASS')
   OR EXISTS (SELECT 1 FROM (VALUES ${tableNames.map((name) => `(${literal(name)})`).join(",")}) expected(name)
     WHERE to_regclass('public.' || expected.name) IS NOT NULL)
   OR EXISTS (SELECT 1 FROM pg_attribute WHERE NOT attisdropped AND
     ((attrelid='public.generation_job'::regclass AND attname='fundingSource')
       OR (attrelid='public.payment_checkout_intent'::regclass AND attname='imagePassOfferSnapshot')))
   OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.generation_job'::regclass
     AND conname='generation_job_credits_reserved_positive' AND contype='c' AND convalidated
     AND md5(pg_get_constraintdef(oid))='f4503c140a260ec9a9482dee6c2b6818')
   OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.payment_checkout_intent'::regclass
     AND conname='payment_checkout_intent_credit_pack_snapshot' AND contype='c' AND convalidated
     AND md5(pg_get_constraintdef(oid))='5ce83202a53d86359d41a0abbfe585b8') THEN
  RAISE EXCEPTION 'IMAGE_PASS_GUARD_BEFORE_STATE';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_locks WHERE pid <> pg_backend_pid()
   AND relation IN ('public.generation_job'::regclass,'public.payment_checkout_intent'::regclass,'public.billing_plan'::regclass)
   AND (NOT granted OR mode IN ('ShareUpdateExclusiveLock','ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock'))) THEN
  RAISE EXCEPTION 'IMAGE_PASS_GUARD_LOCKS';
 END IF;
`;
}

function catalogGuard() {
	const tables = tableNames.map(literal).join(",");
	const triggerValues = [
		["generation_job", "generation_funding_immutable", "assert_image_pass_funding_binding"],
		[
			"credit_reservation",
			"credit_reservation_funding_binding",
			"assert_image_pass_funding_binding",
		],
		[
			"image_pass_reservation",
			"image_pass_reservation_funding_binding",
			"assert_image_pass_funding_binding",
		],
		[
			"image_pass_ledger_entry",
			"image_pass_ledger_immutable",
			"prevent_image_pass_ledger_mutation",
		],
		["image_pass_grant", "image_pass_grant_identity", "guard_image_pass_identity"],
		["image_pass_unit", "image_pass_unit_identity", "guard_image_pass_identity"],
		["image_pass_reservation", "image_pass_reservation_identity", "guard_image_pass_identity"],
		[
			"image_pass_adjustment",
			"image_pass_adjustment_immutable",
			"prevent_image_pass_ledger_mutation",
		],
		["image_pass_grant", "image_pass_grant_three_units", "assert_image_pass_three_units"],
		["image_pass_unit", "image_pass_unit_three_units", "assert_image_pass_three_units"],
	]
		.map((entry) => `(${entry.map(literal).join(",")})`)
		.join(",");
	return `
 IF (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace
     WHERE n.nspname='public' AND t.typname='PaymentProductKind' AND e.enumlabel='IMAGE_PASS') <> 1
   OR NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     WHERE a.attrelid='public.generation_job'::regclass AND a.attname='fundingSource' AND NOT a.attisdropped
       AND a.attnotnull AND a.atttypid='text'::regtype AND pg_get_expr(d.adbin,d.adrelid)='''CREDITS''::text')
   OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.payment_checkout_intent'::regclass
     AND attname='imagePassOfferSnapshot' AND NOT attisdropped AND NOT attnotnull AND atttypid='jsonb'::regtype)
   OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.generation_job'::regclass AND conname='generation_job_credits_reserved_positive')
   OR EXISTS (SELECT 1 FROM (VALUES ('generation_job','generation_job_funding_amount_valid'),
     ('payment_checkout_intent','payment_checkout_intent_credit_pack_snapshot'),
     ('payment_checkout_intent','payment_checkout_intent_image_pass_snapshot')) expected(table_name,constraint_name)
     WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.' || expected.table_name)
       AND conname=expected.constraint_name AND contype='c' AND convalidated))
   OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname IN (${tables}) AND c.relkind='r' AND c.relrowsecurity) <> 5
   OR (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname IN (${tables}) AND i.indisvalid AND i.indisready) <> 20
   OR NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
     WHERE c.oid=to_regclass('public.image_pass_reservation_one_active_unit') AND i.indisunique AND i.indpred IS NOT NULL)
   OR (SELECT count(*) FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname IN (${tables}) AND con.contype='f' AND con.convalidated
       AND con.confupdtype='c' AND con.confdeltype=CASE WHEN c.relname='image_pass_grant' AND con.confrelid='public.purchase'::regclass THEN 'n'::"char" ELSE 'r'::"char" END) <> 8
   OR EXISTS (SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname IN (${tables}) AND con.contype='c' AND NOT con.convalidated)
   OR EXISTS (SELECT 1 FROM (VALUES ${triggerValues}) expected(table_name,trigger_name,function_name)
     WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE t.tgrelid=to_regclass('public.' || expected.table_name) AND t.tgname=expected.trigger_name
         AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND n.nspname='public' AND p.proname=expected.function_name
         AND (expected.function_name <> 'assert_image_pass_three_units' OR (t.tgdeferrable AND t.tginitdeferred))))
   OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname IN (${functions.map(literal).join(",")}) AND p.pronargs=0
       AND p.prorettype='trigger'::regtype AND NOT p.prosecdef
       AND EXISTS (SELECT 1 FROM unnest(p.proconfig) config WHERE replace(config,' ','')='search_path=pg_catalog,public,pg_temp')) <> 4 THEN
  RAISE EXCEPTION 'IMAGE_PASS_GUARD_CATALOG';
 END IF;
 IF EXISTS (SELECT 1 FROM (VALUES ${tableNames.map((name) => `(${literal(name)})`).join(",")}) expected(name)
   WHERE NOT has_table_privilege('ezpic_app','public.' || expected.name,'SELECT')
     OR NOT has_table_privilege('ezpic_app','public.' || expected.name,'INSERT')
     OR NOT has_table_privilege('ezpic_app','public.' || expected.name,'UPDATE')
     OR NOT has_table_privilege('ezpic_app','public.' || expected.name,'DELETE')
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.' || expected.name)
       AND polname=expected.name || '_app' AND polcmd='*' AND (SELECT oid FROM pg_roles WHERE rolname='ezpic_app')=ANY(polroles)
       AND pg_get_expr(polqual,polrelid)='true' AND pg_get_expr(polwithcheck,polrelid)='true'))
   OR EXISTS (SELECT 1 FROM pg_roles r CROSS JOIN (VALUES ${tableNames.map((name) => `(${literal(name)})`).join(",")}) expected(name)
     WHERE r.rolname IN ('anon','authenticated','service_role')
       AND has_table_privilege(r.oid,to_regclass('public.' || expected.name),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
   OR EXISTS (SELECT 1 FROM pg_roles r CROSS JOIN (VALUES ${functions.map((name) => `(${literal(name)})`).join(",")}) expected(name)
     WHERE r.rolname IN ('anon','authenticated','service_role')
       AND has_function_privilege(r.oid,to_regprocedure('public.' || expected.name || '()'),'EXECUTE')) THEN
  RAISE EXCEPTION 'IMAGE_PASS_GUARD_RLS';
 END IF;
 -- Permission/shape checks only; no customer row or generated enum is returned.
 PERFORM 1 FROM public.generation_job LIMIT 0;
 PERFORM 1 FROM public.payment_checkout_intent LIMIT 0;
 PERFORM 1 FROM public.billing_plan LIMIT 0;
`;
}

function guardSql(body: string) {
	return `BEGIN READ ONLY;\nSET LOCAL lock_timeout = '3s';\nSET LOCAL statement_timeout = '30s';\nDO $image_pass_guard$\nBEGIN\n${body}\nEND;\n$image_pass_guard$;\nCOMMIT;\n`;
}

export function createImagePassPlan(files: MigrationFile[]) {
	const ordered = [...files].sort((a, b) => a.name.localeCompare(b.name));
	const canonical = ordered.find((file) => file.name === MIGRATION_NAME);
	if (
		ordered.length !== 67 ||
		new Set(ordered.map((file) => file.name)).size !== 67 ||
		ordered.some((file) => !/^\d{14}_[a-z0-9_]+$/.test(file.name)) ||
		ordered.at(-1)?.name !== MIGRATION_NAME ||
		!canonical ||
		digest(canonical.sql) !== CANONICAL_SHA256
	) {
		throw new Error("IMAGE_PASS_ARTIFACT_MISMATCH");
	}
	const envelope = canonical.sql.replace(
		"BEGIN;\n",
		"BEGIN;\nSET LOCAL lock_timeout = '3s';\nSET LOCAL statement_timeout = '30s';\n",
	);
	if (digest(envelope) !== ENVELOPE_SHA256) throw new Error("IMAGE_PASS_ARTIFACT_MISMATCH");
	const history = ordered
		.filter((file) => file.name !== MIGRATION_NAME)
		.map((file) => {
			const lf = file.sql.replaceAll("\r\n", "\n");
			return { name: file.name, checksums: [digest(lf), digest(lf.replaceAll("\n", "\r\n"))] };
		});
	return {
		envelope,
		history,
		preflightSql: guardSql(commonGuard() + historyGuard(history, false) + beforeGuard()),
		catalogSql: guardSql(commonGuard() + historyGuard(history, false) + catalogGuard()),
		receiptSql: guardSql(commonGuard() + historyGuard(history, true) + catalogGuard()),
	};
}

function parseArguments(args: string[]) {
	let apply = false;
	let expectedCommit: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--apply" && !apply) apply = true;
		else if (
			args[i] === "--expected-commit" &&
			expectedCommit === undefined &&
			/^[a-f0-9]{40}$/.test(args[i + 1] ?? "")
		)
			expectedCommit = args[++i];
		else throw new Error("IMAGE_PASS_ARGUMENTS_INVALID");
	}
	if (apply && !expectedCommit) throw new Error("IMAGE_PASS_ARGUMENTS_INVALID");
	return { apply, expectedCommit };
}

function targetUrl(environment: Environment, root: string) {
	try {
		const input = Object.fromEntries(
			Object.entries(parseEnv(readCloudflareBuildEnvironment(environment))).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		);
		const target = new URL(input.DATABASE_URL ?? "");
		const allowedParameters = new Set([
			"schema",
			"sslmode",
			"sslrootcert",
			"sslcert",
			"sslaccept",
			"connection_limit",
			"connect_timeout",
			"pool_timeout",
			"statement_cache_size",
		]);
		if (
			target.hostname !== "db.cresrmesgalqdgbxtyvm.supabase.co" ||
			!["", "5432"].includes(target.port) ||
			target.pathname !== "/postgres" ||
			!["postgres", "ezpic_app"].includes(decodeURIComponent(target.username)) ||
			![null, "public"].includes(target.searchParams.get("schema")) ||
			target.searchParams.getAll("schema").length > 1 ||
			target.searchParams.getAll("sslmode").length !== 1 ||
			[...target.searchParams.keys()].some((key) => !allowedParameters.has(key))
		)
			throw new Error();
		return migrationDatabaseUrl(input, root);
	} catch {
		throw new Error("IMAGE_PASS_TARGET_INVALID");
	}
}

function childEnvironment(environment: Environment, databaseUrl: string) {
	const result: Environment = {
		DATABASE_URL: databaseUrl,
		NO_COLOR: "1",
		PRISMA_HIDE_UPDATE_MESSAGE: "1",
	};
	// Keep only executable/CA discovery, never arbitrary NODE_OPTIONS, debug flags,
	// cloud credentials, production binding parts, or Prisma engine overrides.
	for (const key of [
		"PATH",
		"HOME",
		"TMPDIR",
		"TEMP",
		"TMP",
		"SystemRoot",
		"npm_execpath",
		"npm_config_user_agent",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"NODE_EXTRA_CA_CERTS",
	]) {
		if (environment[key] !== undefined) result[key] = environment[key];
	}
	return result;
}

export async function runImagePassMigration(options: Options): Promise<"plan" | "applied"> {
	const args = parseArguments(options.args);
	const plan = createImagePassPlan(options.files);
	if (!args.apply) {
		options.log("IMAGE_PASS_PLAN_READY");
		return "plan";
	}
	if (
		!options.gitClean ||
		options.gitHead !== args.expectedCommit ||
		options.environment.WORKERS_CI !== "1"
	)
		throw new Error("IMAGE_PASS_SOURCE_MISMATCH");
	try {
		assertCloudflareGitCommit(options.environment, options.gitHead);
	} catch {
		throw new Error("IMAGE_PASS_SOURCE_MISMATCH");
	}
	const environment = childEnvironment(
		options.environment,
		targetUrl(options.environment, options.root),
	);
	if (!environment.npm_execpath) throw new Error("IMAGE_PASS_BUILD_ENVIRONMENT_INVALID");
	async function run(stage: Stage, command: string[], input?: string) {
		options.log(`IMAGE_PASS_STAGE ${stage}`);
		let result: CommandResult;
		try {
			result = await options.execute({
				stage,
				args: ["--filter", "@repo/database", "exec", "prisma", ...command],
				environment,
				input,
			});
		} catch {
			options.log(`IMAGE_PASS_EXIT ${stage} uncertain`);
			throw new Error("IMAGE_PASS_CHILD_UNCERTAIN");
		}
		if (result.status === null || result.error || result.signal) {
			options.log(`IMAGE_PASS_EXIT ${stage} uncertain`);
			throw new Error("IMAGE_PASS_CHILD_UNCERTAIN");
		}
		options.log(
			`IMAGE_PASS_EXIT ${stage} ${Number.isInteger(result.status) ? result.status : "uncertain"}`,
		);
		if (result.status !== 0) {
			for (const code of guardCodes)
				if (new RegExp(`\\b${code}\\b`).test(result.stderr ?? "")) options.log(code);
			throw new Error("IMAGE_PASS_CHILD_FAILED");
		}
	}
	await run("preflight", ["db", "execute", "--stdin"], plan.preflightSql);
	await options.withEnvelope(plan.envelope, (filename) =>
		run("apply", ["db", "execute", "--file", filename]),
	);
	await run("catalog", ["db", "execute", "--stdin"], plan.catalogSql);
	await run("resolve", ["migrate", "resolve", "--applied", MIGRATION_NAME]);
	await run("status", ["migrate", "status"]);
	await run("receipt", ["db", "execute", "--stdin"], plan.receiptSql);
	options.log("IMAGE_PASS_APPLIED_VERIFIED");
	return "applied";
}

async function main() {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
	try {
		parseArguments(process.argv.slice(2));
		const directory = path.join(root, "packages/database/prisma/migrations");
		const files = await Promise.all(
			(await readdir(directory, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map(async (entry) => ({
					name: entry.name,
					sql: await readFile(path.join(directory, entry.name, "migration.sql"), "utf8"),
				})),
		);
		const git = (args: string[]) => {
			const result = spawnSync("git", args, {
				cwd: root,
				encoding: "utf8",
				stdio: "pipe",
				timeout: 10_000,
			});
			if (result.status !== 0 || result.error || result.signal)
				throw new Error("IMAGE_PASS_SOURCE_MISMATCH");
			return result.stdout.trim();
		};
		await runImagePassMigration({
			args: process.argv.slice(2),
			root,
			files,
			environment: process.env,
			gitHead: git(["rev-parse", "HEAD"]),
			gitClean: git(["status", "--porcelain"]) === "",
			log: (line) => process.stdout.write(`${line}\n`),
			execute: async (command) => {
				const result = spawnSync(
					process.execPath,
					[command.environment.npm_execpath!, ...command.args],
					{
						cwd: root,
						env: command.environment as NodeJS.ProcessEnv,
						input: command.input,
						encoding: "utf8",
						stdio: "pipe",
						timeout: 120_000,
						maxBuffer: 1024 * 1024,
					},
				);
				return {
					status: result.status,
					signal: result.signal,
					error: result.error,
					stdout: result.stdout,
					stderr: result.stderr,
				};
			},
			withEnvelope: async (sql, use) => {
				const directory = await mkdtemp(path.join(tmpdir(), "image-pass-migration-"));
				try {
					const filename = path.join(directory, "migration.sql");
					await writeFile(filename, sql, { mode: 0o600, flag: "wx" });
					return await use(filename);
				} finally {
					await rm(directory, { recursive: true, force: true });
				}
			},
		});
	} catch (error) {
		const code =
			error instanceof Error && safeErrors.has(error.message)
				? error.message
				: "IMAGE_PASS_LOCAL_IO_FAILED";
		process.stderr.write(`${code}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	void main();
