import path from "node:path";

export function assertCloudflareGitCommit(
	environment: Record<string, string | undefined>,
	sha: string,
) {
	if (environment.WORKERS_CI !== "1") return;
	if (environment.WORKERS_CI_BRANCH !== "main") throw new Error("PRODUCTION_MAIN_BRANCH_REQUIRED");
	if (environment.WORKERS_CI_COMMIT_SHA !== sha)
		throw new Error("CLOUDFLARE_BUILD_COMMIT_MISMATCH");
}

export function assertAutomaticReleaseEnvironment(environment: Record<string, string>) {
	if ((environment.EZPIC_DEPLOYMENT_PROFILE ?? "workers") !== "workers") {
		throw new Error("AUTOMATIC_DEPLOYMENT_REQUIRES_WORKERS_PROFILE");
	}
}

export function migrationDatabaseUrl(environment: Record<string, string>, root: string) {
	let database: URL;
	try {
		database = new URL(environment.DATABASE_URL);
		if (!["postgres:", "postgresql:"].includes(database.protocol)) throw new Error();
	} catch {
		throw new Error("MIGRATION_STATUS_DATABASE_URL_REQUIRED");
	}
	if (database.searchParams.get("sslmode") !== "verify-full") {
		throw new Error("MIGRATION_STATUS_REQUIRES_VERIFIED_TLS");
	}
	const repositoryCa = path.join(root, "tooling/certificates/supabase-prod-ca-2021.crt");
	const configuredCa = database.searchParams.get("sslrootcert");
	const ca =
		!configuredCa?.trim() ||
		configuredCa.replaceAll("\\", "/").split("/").at(-1) === "supabase-prod-ca-2021.crt"
			? repositoryCa
			: configuredCa;
	// Prisma's Rust connector does not recognize verify-full or sslrootcert.
	// Its require mode enforces TLS, and strict retains certificate and hostname verification.
	database.searchParams.set("sslmode", "require");
	database.searchParams.set("sslaccept", "strict");
	database.searchParams.set("sslcert", ca);
	database.searchParams.delete("sslrootcert");
	return database.toString();
}
