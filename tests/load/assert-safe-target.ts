const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function assertSafeDatabaseUrl(value: string | undefined): URL {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = parseUrl(value, "TEST_DATABASE_URL");
	if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
		throw new Error("TEST_DATABASE_URL must use postgres or postgresql");
	}
	if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
		throw new Error("TEST_DATABASE_URL must use a loopback host");
	}
	const databaseName = decodeURIComponent(parsed.pathname.slice(1)).toLowerCase();
	if (!databaseName.includes("test") && !databaseName.includes("testing")) {
		throw new Error("TEST_DATABASE_URL database name must contain test or testing");
	}
	if (process.env.DATABASE_URL && process.env.DATABASE_URL === value) {
		throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL");
	}
	return parsed;
}

export function assertSafeLoadTarget(value: string | undefined): URL {
	if (!value) throw new Error("LOAD_BASE_URL is required");
	const parsed = parseUrl(value, "LOAD_BASE_URL");
	if (!["http:", "https:"].includes(parsed.protocol)) {
		throw new Error("LOAD_BASE_URL must use http or https");
	}
	const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname);
	if (isLoopback) return parsed;
	if (process.env.ALLOW_REMOTE_LOAD_TARGET !== "true") {
		throw new Error("Remote load targets require ALLOW_REMOTE_LOAD_TARGET=true");
	}
	if (process.env.LOAD_TARGET_CONFIRMATION !== parsed.origin) {
		throw new Error("LOAD_TARGET_CONFIRMATION must exactly match the remote target origin");
	}
	return parsed;
}

function parseUrl(value: string, name: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`${name} must be a valid URL`);
	}
	return parsed;
}
