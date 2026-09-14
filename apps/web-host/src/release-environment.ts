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

export function assertAutomaticReleaseEnvironment(
	environment: Record<string, string>,
	catalogVersion: string,
) {
	if ((environment.EZPIC_DEPLOYMENT_PROFILE ?? "workers") !== "workers") {
		throw new Error("AUTOMATIC_DEPLOYMENT_REQUIRES_WORKERS_PROFILE");
	}
	const providers = new Set(
		(environment.MEDIA_ENABLED_PROVIDERS ?? "").split(",").map((v) => v.trim()),
	);
	const versions = new Set(
		(environment.MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS ?? "").split(",").map((v) => v.trim()),
	);
	if (
		environment.MEDIA_GENERATION_ENABLED === "true" &&
		providers.has("kie") &&
		!versions.has(catalogVersion)
	) {
		throw new Error(
			`PRODUCTION_CATALOG_NOT_CERTIFIED: MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS must include ${catalogVersion} after provider evidence is reviewed; deployment did not change the gate.`,
		);
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
	const ca = database.searchParams.get("sslrootcert");
	if (ca?.replaceAll("\\", "/").endsWith("/supabase-prod-ca-2021.crt")) {
		database.searchParams.set(
			"sslrootcert",
			path.join(root, "tooling/certificates/supabase-prod-ca-2021.crt"),
		);
	}
	return database.toString();
}
