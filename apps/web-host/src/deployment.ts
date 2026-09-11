export const containerDatabaseCa = "/app/tooling/certificates/supabase-prod-ca-2021.crt";

const publicVariables = new Set([
	"NEXT_PUBLIC_SAAS_URL",
	"NEXT_PUBLIC_SITE_NAME",
	"NEXT_PUBLIC_SITE_DESCRIPTION",
	"NEXT_PUBLIC_SUPPORT_EMAIL",
	"NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION",
	"NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY",
	"NEXT_PUBLIC_AVATARS_BUCKET_NAME",
	"NEXT_PUBLIC_POSTHOG_KEY",
	"NEXT_PUBLIC_POSTHOG_HOST",
	"NEXT_PUBLIC_GOOGLE_ANALYTICS_ID",
	"NEXT_PUBLIC_CLARITY_PROJECT_ID",
	"NEXT_PUBLIC_MIXPANEL_TOKEN",
	"NEXT_PUBLIC_PIRSCH_CODE",
	"NEXT_PUBLIC_PLAUSIBLE_URL",
	"NEXT_PUBLIC_UMAMI_TRACKING_ID",
]);

export function publicBuildVariables(environment: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(environment)) {
		if (!key.startsWith("NEXT_PUBLIC_")) continue;
		if (!publicVariables.has(key)) throw new Error(`UNRECOGNIZED_PUBLIC_VARIABLE: ${key}`);
		if (value) result[key] = value;
	}
	return result;
}

export function deploymentEnvironment(
	environment: Record<string, string>,
	canonicalOrigin: string,
): Record<string, string> {
	if (environment.NEXT_PUBLIC_SAAS_URL !== canonicalOrigin) throw new Error("WEB_ORIGIN_MISMATCH");
	publicBuildVariables(environment);
	const result = Object.fromEntries(
		Object.entries(environment).filter(
			([key, value]) =>
				value &&
				!/^(?:LOAD_|TEST_|E2E_|INVARIANT_|REQUIRE_LOAD_|ALLOW_REMOTE_LOAD_TARGET$|DIRECT_URL$|JOBS_RUNTIME_ENV$)/.test(
					key,
				),
		),
	);
	if (result.DATABASE_URL) {
		let database: URL;
		try {
			database = new URL(result.DATABASE_URL);
			if (!["postgres:", "postgresql:"].includes(database.protocol)) throw new Error();
		} catch {
			throw new Error("INVALID_DATABASE_URL");
		}
		const certificate = database.searchParams.get("sslrootcert");
		if (certificate?.replaceAll("\\", "/").endsWith("/supabase-prod-ca-2021.crt")) {
			if (database.searchParams.get("sslmode") !== "verify-full")
				throw new Error("DATABASE_TLS_VERIFICATION_REQUIRED");
			database.searchParams.set("sslrootcert", containerDatabaseCa);
			result.DATABASE_URL = database.toString();
		}
	}
	return {
		...result,
		NODE_ENV: "production",
		MEDIA_TRUSTED_PROXY_PROVIDER: "cloudflare",
		E2E_TEST_MEDIA_ADAPTERS: "false",
		E2E_DRAFT_HANDOFF: "false",
		LOAD_TESTING_ENABLED: "false",
		LEGACY_AI_STREAM_ENABLED: "false",
	};
}
