// One-time migration-only Cloudflare build. No Worker deployment and no
// manual migration-history writes. Never retry a failed/uncertain deploy
// without first reading back both the SQL catalog and Prisma receipt.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { assertCloudflareGitCommit, migrationDatabaseUrl } from "./release-environment";

const migration = "20261119133000_portrait_pack_trial";
const canonicalSha256 = "4cf6a969702ea1444b6907dcf7ca3badce4a3a689e5fef22e2c1a56ca49d46a3";
const rollback = "20260813000000_ai_media_foundation";
const knownGuestChecksum = "a6b483e53252d73ca4255775fc02d5c8a6ecdb6f415e129deb3637c24661ebdc";
const caName = "supabase-prod-ca-2021.crt";
const guardErrors = [
	"PORTRAIT_PACK_GUARD_TARGET",
	"PORTRAIT_PACK_GUARD_HISTORY",
	"PORTRAIT_PACK_GUARD_BEFORE",
	"PORTRAIT_PACK_GUARD_CATALOG",
] as const;

type Environment = Record<string, string | undefined>;
type File = { name: string; sql: string };
export type PortraitMigrationCommand = {
	stage: "preflight" | "deploy" | "catalog" | "status";
	args: string[];
	environment: Environment;
	input?: string;
};
type Options = {
	args: string[];
	root: string;
	files: File[];
	gitClean: boolean;
	gitHead: string;
	environment: Environment;
	loadBundle: () => string | Promise<string>;
	log: (line: string) => void;
	execute: (command: PortraitMigrationCommand) => {
		status: number | null;
		stdout?: string;
		stderr?: string;
	};
};

function sha256(sql: string) {
	return createHash("sha256").update(sql).digest("hex");
}

function reviewedManifest(files: File[]) {
	const names = files.map(({ name }) => name).sort();
	const sql = files.find(({ name }) => name === migration)?.sql;
	if (
		names.length !== 85 ||
		new Set(names).size !== names.length ||
		names.at(-1) !== migration ||
		names.some((name) => !/^\d{14}_[a-z0-9_]+$/.test(name)) ||
		!sql ||
		sha256(sql) !== canonicalSha256
	)
		throw new Error("PORTRAIT_PACK_ARTIFACT_MISMATCH");
	return files.map(({ name, sql }) => {
		const lf = sql.replaceAll("\r\n", "\n");
		const expected = [sha256(lf), sha256(lf.replaceAll("\n", "\r\n"))];
		// This single already-observed, completed historical checksum is explicitly
		// accepted as immutable baseline, not repaired or written by the runner.
		if (name === "20261114090000_guest_lifetime_entitlement") expected.push(knownGuestChecksum);
		return `('${name}', ARRAY[${expected.map((hash) => `'${hash}'`).join(",")}])`;
	});
}

function historyGuard(manifest: string[], applied: boolean) {
	const count = applied ? 85 : 84;
	const expected = applied
		? manifest
		: manifest.filter((row) => !row.startsWith(`('${migration}',`));
	return `
 IF (SELECT count(*) FROM public._prisma_migrations) <> ${count + 1}
   OR (SELECT count(*) FROM public._prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) <> ${count}
   OR (SELECT count(*) FROM public._prisma_migrations
       WHERE migration_name='${rollback}' AND rolled_back_at IS NOT NULL) <> 1
   OR EXISTS (
    WITH expected(name, checksums) AS (VALUES ${expected.join(",\n")})
    SELECT 1 FROM expected e LEFT JOIN public._prisma_migrations m
    ON m.migration_name=e.name AND m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL
      AND m.checksum=ANY(e.checksums)
    GROUP BY e.name HAVING count(m.id) <> 1
   ) THEN RAISE EXCEPTION 'PORTRAIT_PACK_GUARD_HISTORY';
 END IF;`;
}

const catalogGuard = `
 IF NOT EXISTS (
   SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
   WHERE c.oid=to_regclass('public.portrait_pack_trial') AND c.relkind='r'
     AND r.rolname='ezpic_app' AND c.relrowsecurity
     AND NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) where grantee=0)
 ) THEN RAISE EXCEPTION 'PORTRAIT_PACK_GUARD_CATALOG';
 END IF;
 IF NOT has_table_privilege('ezpic_app','public.portrait_pack_trial','SELECT')
   OR NOT has_table_privilege('ezpic_app','public.portrait_pack_trial','INSERT')
   OR has_table_privilege('ezpic_app','public.portrait_pack_trial','UPDATE,DELETE,TRUNCATE')
   OR EXISTS (SELECT 1 FROM pg_roles
     WHERE rolname IN ('anon','authenticated','service_role')
       AND has_table_privilege(oid,'public.portrait_pack_trial','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
   OR (SELECT count(*) FROM pg_constraint
     WHERE conrelid='public.portrait_pack_trial'::regclass AND convalidated
       AND (conname,contype::text) IN (
         ('portrait_pack_trial_pkey','p'), ('portrait_pack_trial_slot_range','c'),
         ('portrait_pack_trial_subjectKey_requestId_key','u')
       )) <> 3
   OR (SELECT count(*) FROM pg_policies
     WHERE schemaname='public' AND tablename='portrait_pack_trial') <> 2
   OR (SELECT count(*) FROM pg_policies
     WHERE schemaname='public' AND tablename='portrait_pack_trial'
       AND roles=ARRAY['ezpic_app']::name[]
       AND (policyname,cmd) IN (('portrait_pack_trial_read','SELECT'),('portrait_pack_trial_issue','INSERT'))
     ) <> 2 THEN RAISE EXCEPTION 'PORTRAIT_PACK_GUARD_CATALOG';
 END IF;`;

function guardSql(manifest: string[], applied: boolean) {
	return `BEGIN TRANSACTION READ ONLY;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $guard$
BEGIN
 IF current_database() <> 'postgres' OR current_schema() IS DISTINCT FROM 'public' OR current_user <> 'ezpic_app'
   OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
   OR NOT EXISTS (SELECT 1 FROM pg_stat_ssl WHERE pid=pg_backend_pid() AND ssl)
   OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND NOT rolsuper AND NOT rolbypassrls)
   OR NOT has_schema_privilege(current_user,'public','CREATE')
   OR to_regclass('public.growth_event') IS NULL
   OR NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
     WHERE c.oid=to_regclass('public._prisma_migrations') AND r.rolname=current_user)
   THEN RAISE EXCEPTION 'PORTRAIT_PACK_GUARD_TARGET';
 END IF;
 ${historyGuard(manifest, applied)}
 ${
		applied
			? `
 IF NOT EXISTS (SELECT 1 FROM public._prisma_migrations WHERE migration_name='${migration}'
       AND checksum='${canonicalSha256}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
   THEN RAISE EXCEPTION 'PORTRAIT_PACK_GUARD_HISTORY';
 END IF;
 ${catalogGuard}`
			: `
 IF to_regclass('public.portrait_pack_trial') IS NOT NULL
   OR EXISTS (SELECT 1 FROM public._prisma_migrations WHERE migration_name='${migration}')
   THEN RAISE EXCEPTION 'PORTRAIT_PACK_GUARD_BEFORE';
 END IF;`
 }
END;
$guard$;
COMMIT;`;
}

async function targetUrl(loadBundle: Options["loadBundle"], root: string) {
	try {
		const input = parseEnv(await loadBundle());
		const connection = input.DATABASE_URL;
		if (!connection) throw new Error();
		const database = new URL(connection);
		const allowed = new Set([
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
			!["postgresql:", "postgres:"].includes(database.protocol) ||
			database.hostname !== "db.cresrmesgalqdgbxtyvm.supabase.co" ||
			!["", "5432"].includes(database.port) ||
			database.pathname !== "/postgres" ||
			decodeURIComponent(database.username) !== "ezpic_app" ||
			!["public", null].includes(database.searchParams.get("schema")) ||
			database.searchParams.getAll("schema").length > 1 ||
			database.searchParams.getAll("sslmode").length !== 1 ||
			[...database.searchParams.keys()].some((key) => !allowed.has(key))
		)
			throw new Error();
		const verified = new URL(migrationDatabaseUrl({ DATABASE_URL: connection }, root));
		if (verified.searchParams.get("sslcert") !== path.join(root, "tooling/certificates", caName))
			throw new Error();
		return verified.toString();
	} catch {
		throw new Error("PORTRAIT_PACK_TARGET_INVALID");
	}
}

export async function runPortraitPackMigration(options: Options): Promise<"plan" | "applied"> {
	const manifest = reviewedManifest(options.files);
	if (options.args.length === 0) {
		options.log("PORTRAIT_PACK_PLAN_READY");
		return "plan";
	}
	const [action, expected, sha] = options.args;
	if (
		options.args.length !== 3 ||
		action !== "--apply" ||
		expected !== "--expected-commit" ||
		!sha ||
		!/^[a-f0-9]{40}$/.test(sha)
	)
		throw new Error("PORTRAIT_PACK_ACTION_INVALID");
	if (
		!options.gitClean ||
		options.gitHead !== sha ||
		options.environment.WORKERS_CI !== "1" ||
		(options.environment.WORKERS_CI_WORKER_NAME &&
			options.environment.WORKERS_CI_WORKER_NAME !== "ezimageai-site-production") ||
		!options.environment.npm_execpath
	)
		throw new Error("PORTRAIT_PACK_SOURCE_INVALID");
	try {
		assertCloudflareGitCommit(options.environment, sha);
	} catch {
		throw new Error("PORTRAIT_PACK_SOURCE_INVALID");
	}

	const environment: Environment = {
		DATABASE_URL: await targetUrl(options.loadBundle, options.root),
		NO_COLOR: "1",
		PRISMA_HIDE_UPDATE_MESSAGE: "1",
	};
	for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "npm_execpath"])
		if (options.environment[key] !== undefined) environment[key] = options.environment[key];
	function run(stage: PortraitMigrationCommand["stage"], args: string[], input?: string) {
		options.log(`PORTRAIT_PACK_STAGE ${stage}`);
		let result: ReturnType<Options["execute"]>;
		try {
			result = options.execute({ stage, args, environment, input });
		} catch {
			result = { status: null };
		}
		if (result.status === null) throw new Error("PORTRAIT_PACK_CHILD_UNCERTAIN");
		if (result.status !== 0) {
			for (const code of guardErrors) {
				if (`${result.stdout ?? ""}\n${result.stderr ?? ""}`.includes(code)) options.log(code);
			}
			throw new Error("PORTRAIT_PACK_CHILD_FAILED");
		}
	}
	run("preflight", ["db", "execute", "--stdin"], guardSql(manifest, false));
	// The read-only manifest check proved every exact committed predecessor is
	// already applied. Drain other migrators before running this one-time build.
	run("deploy", ["migrate", "deploy"]);
	run("catalog", ["db", "execute", "--stdin"], guardSql(manifest, true));
	run("status", ["migrate", "status"]);
	options.log("PORTRAIT_PACK_APPLIED_VERIFIED");
	return "applied";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
	const directory = path.join(root, "packages/database/prisma/migrations");
	const files = await Promise.all(
		(await readdir(directory, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => ({
				name: entry.name,
				sql: await readFile(path.join(directory, entry.name, "migration.sql"), "utf8"),
			})),
	).catch(() => []);
	function git(args: string[]) {
		const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 });
		return result.status === 0 ? result.stdout.trim() : undefined;
	}
	await runPortraitPackMigration({
		args: process.argv.slice(2),
		root,
		files,
		gitHead: git(["rev-parse", "HEAD"]) ?? "",
		gitClean: git(["status", "--porcelain", "--untracked-files=all"]) === "",
		environment: process.env,
		loadBundle: async () =>
			(await import("./build-secrets")).readCloudflareBuildEnvironment(process.env),
		log: (line) => process.stdout.write(`${line}\n`),
		execute: ({ args, environment, input }) =>
			spawnSync(
				process.execPath,
				[environment.npm_execpath!, "--filter", "@repo/database", "exec", "prisma", ...args],
				{
					cwd: root,
					// Cloudflare adds required Worker variables to ProcessEnv; Prisma only receives this allowlist.
					env: environment as NodeJS.ProcessEnv,
					input,
					encoding: "utf8",
					timeout: 120_000,
				},
			),
	}).catch((error: unknown) => {
		const safe = error instanceof Error && /^PORTRAIT_PACK_[A-Z_]+$/.test(error.message);
		process.stderr.write(
			`${safe ? (error as Error).message : "PORTRAIT_PACK_UNEXPECTED_FAILURE"}\n`,
		);
		process.exitCode = 1;
	});
}
