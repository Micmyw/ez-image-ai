const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const LOCAL_MEDIA_SAFETY_PROVIDER = "test";

export interface LocalMediaE2EEnvironment {
	databaseUrl: string;
	runId: string;
	saasOrigin: string;
	marketingOrigin: string;
}

export function isLocalMediaE2E(
	environment: NodeJS.ProcessEnv = process.env,
): environment is NodeJS.ProcessEnv & Record<"E2E_RUN_ID", string> {
	try {
		assertLocalMediaE2E(environment);
		return true;
	} catch {
		return false;
	}
}

export function assertLocalMediaE2E(
	environment: NodeJS.ProcessEnv = process.env,
): LocalMediaE2EEnvironment {
	if (environment.NODE_ENV === "production" && environment.E2E_USE_PRODUCTION_BUILD !== "true") {
		throw new Error(
			"LOCAL_MEDIA_E2E_REFUSED: production NODE_ENV requires E2E_USE_PRODUCTION_BUILD=true",
		);
	}
	if (environment.E2E_TEST_MEDIA_ADAPTERS !== "true") {
		throw new Error("LOCAL_MEDIA_E2E_REFUSED: E2E_TEST_MEDIA_ADAPTERS=true is required");
	}
	if (
		environment.MEDIA_SAFETY_ADAPTER !== LOCAL_MEDIA_SAFETY_PROVIDER ||
		environment.MEDIA_ALLOW_TEST_SAFETY_ADAPTER !== "true"
	) {
		throw new Error("LOCAL_MEDIA_E2E_REFUSED: explicit test prompt moderation opt-in is required");
	}
	if (!environment.E2E_RUN_ID || !/^[a-z0-9-]{6,48}$/i.test(environment.E2E_RUN_ID)) {
		throw new Error("LOCAL_MEDIA_E2E_REFUSED: E2E_RUN_ID is missing or invalid");
	}
	if (!environment.DATABASE_URL || !environment.TEST_DATABASE_URL) {
		throw new Error("LOCAL_MEDIA_E2E_REFUSED: DATABASE_URL and TEST_DATABASE_URL are required");
	}
	if (environment.DATABASE_URL !== environment.TEST_DATABASE_URL) {
		throw new Error("LOCAL_MEDIA_E2E_REFUSED: server must target the declared test database");
	}
	const database = parseUrl(environment.DATABASE_URL, "DATABASE_URL");
	if (!LOOPBACK_HOSTS.has(database.hostname) || !/test|testing/i.test(database.pathname)) {
		throw new Error(
			"LOCAL_MEDIA_E2E_REFUSED: database must be loopback and its name must contain test",
		);
	}
	const saas = assertLoopbackOrigin(environment.NEXT_PUBLIC_SAAS_URL, "NEXT_PUBLIC_SAAS_URL");
	const marketing = assertLoopbackOrigin(
		environment.NEXT_PUBLIC_MARKETING_URL,
		"NEXT_PUBLIC_MARKETING_URL",
	);
	if (saas.origin === marketing.origin) {
		throw new Error("LOCAL_MEDIA_E2E_REFUSED: SaaS and marketing origins must differ");
	}
	return {
		databaseUrl: database.toString(),
		runId: environment.E2E_RUN_ID,
		saasOrigin: saas.origin,
		marketingOrigin: marketing.origin,
	};
}

function assertLoopbackOrigin(value: string | undefined, name: string): URL {
	const url = parseUrl(value, name);
	if (!LOOPBACK_HOSTS.has(url.hostname) || url.protocol !== "http:" || url.pathname !== "/") {
		throw new Error(`LOCAL_MEDIA_E2E_REFUSED: ${name} must be an HTTP loopback origin`);
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error(`LOCAL_MEDIA_E2E_REFUSED: ${name} must not contain credentials or URL data`);
	}
	return url;
}

function parseUrl(value: string | undefined, name: string): URL {
	try {
		return new URL(value ?? "");
	} catch {
		throw new Error(`LOCAL_MEDIA_E2E_REFUSED: ${name} is not a valid URL`);
	}
}
