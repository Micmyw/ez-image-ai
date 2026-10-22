import assert from "node:assert/strict";

export type ScanlessDatabasePoolMode = "direct" | "transaction";

function parseFixtureUrl(value: string, code: string): URL {
	try {
		return new URL(value);
	} catch {
		// Never include the supplied URL or credentials in diagnostic errors.
		throw new Error(code);
	}
}

/** Local harness only. The direct database remains the fixture and inspection target. */
export function resolveScanlessDatabasePool(input: {
	databaseUrl: string;
	mode?: string;
	poolUrl?: string;
}) {
	const backend = parseFixtureUrl(input.databaseUrl, "INVALID_SCANLESS_DATABASE_URL");
	assert(
		["postgres:", "postgresql:"].includes(backend.protocol) &&
			backend.hostname === "127.0.0.1" &&
			backend.port === "55432" &&
			/^\/scanless_[a-z0-9_]*test$/.test(backend.pathname) &&
			backend.username.length > 0 &&
			backend.password.length > 0 &&
			backend.search === "" &&
			backend.hash === "",
		"UNSAFE_SCANLESS_DATABASE_URL",
	);
	const mode = input.mode ?? "direct";
	assert(mode === "direct" || mode === "transaction", "INVALID_SCANLESS_DATABASE_POOL_MODE");
	let frontend = backend;
	let hyperdriveUrl = input.databaseUrl;
	if (mode === "direct") {
		assert(input.poolUrl === undefined, "SCANLESS_POOL_URL_REQUIRES_TRANSACTION_MODE");
	} else {
		assert(input.poolUrl, "SCANLESS_TRANSACTION_POOL_URL_REQUIRED");
		frontend = parseFixtureUrl(input.poolUrl, "INVALID_SCANLESS_DATABASE_POOL_URL");
		assert(
			frontend.protocol === backend.protocol &&
				frontend.hostname === "127.0.0.1" &&
				frontend.port === "55433" &&
				frontend.pathname === backend.pathname &&
				frontend.username === backend.username &&
				frontend.password === backend.password &&
				frontend.search === "" &&
				frontend.hash === "",
			"UNSAFE_SCANLESS_DATABASE_POOL_URL",
		);
		hyperdriveUrl = input.poolUrl;
	}
	return {
		hyperdriveUrl,
		report: {
			mode: mode as ScanlessDatabasePoolMode,
			backend: { host: backend.hostname, port: Number(backend.port) },
			frontend: { host: frontend.hostname, port: Number(frontend.port) },
			database: backend.pathname.slice(1),
			// Selecting a URL is configuration evidence, not proof of server behavior.
			transactionModeProofRequired: mode === "transaction",
		},
	};
}
