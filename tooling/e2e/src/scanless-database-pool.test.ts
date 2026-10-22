import assert from "node:assert/strict";
import test from "node:test";

import { resolveScanlessDatabasePool } from "./scanless-database-pool";

const databaseUrl = "postgresql://fixture:fixture-only@127.0.0.1:55432/scanless_pool_test";
const poolUrl = databaseUrl.replace(":55432/", ":55433/");

void test("direct remains the default and explicit direct has the identical target", () => {
	for (const mode of [undefined, "direct"]) {
		const result = resolveScanlessDatabasePool({ databaseUrl, mode });
		assert.equal(result.hyperdriveUrl, databaseUrl);
		assert.deepEqual(result.report, {
			mode: "direct",
			backend: { host: "127.0.0.1", port: 55432 },
			frontend: { host: "127.0.0.1", port: 55432 },
			database: "scanless_pool_test",
			transactionModeProofRequired: false,
		});
	}
});

void test("transaction mode changes only the Hyperdrive target and reports no credentials", () => {
	const result = resolveScanlessDatabasePool({ databaseUrl, mode: "transaction", poolUrl });
	assert.equal(result.hyperdriveUrl, poolUrl);
	assert.deepEqual(result.report, {
		mode: "transaction",
		backend: { host: "127.0.0.1", port: 55432 },
		frontend: { host: "127.0.0.1", port: 55433 },
		database: "scanless_pool_test",
		transactionModeProofRequired: true,
	});
	assert(!JSON.stringify(result.report).includes("fixture"));
});

void test("both explicit controls are required and accidental inherited URLs fail closed", () => {
	for (const mode of [undefined, "direct"])
		for (const value of [poolUrl, ""])
			assert.throws(
				() => resolveScanlessDatabasePool({ databaseUrl, mode, poolUrl: value }),
				/SCANLESS_POOL_URL_REQUIRES_TRANSACTION_MODE/,
			);
	for (const value of [undefined, ""])
		assert.throws(
			() => resolveScanlessDatabasePool({ databaseUrl, mode: "transaction", poolUrl: value }),
			/SCANLESS_TRANSACTION_POOL_URL_REQUIRED/,
		);
	for (const mode of ["", "session", "statement", "TRANSACTION", "true"])
		assert.throws(
			() => resolveScanlessDatabasePool({ databaseUrl, mode, poolUrl }),
			/INVALID_SCANLESS_DATABASE_POOL_MODE/,
		);
});

void test("the direct fixture gate cannot be bypassed by enabling the pool", () => {
	const invalid = [
		"not a URL",
		databaseUrl.replace("postgresql:", "https:"),
		databaseUrl.replace("127.0.0.1", "localhost"),
		databaseUrl.replace("127.0.0.1", "database.example.com"),
		databaseUrl.replace(":55432/", ":5432/"),
		databaseUrl.replace(":55432/", ":55433/"),
		databaseUrl.replace("scanless_pool_test", "production"),
		databaseUrl.replace("scanless_pool_test", "prefix_scanless_pool_test"),
		databaseUrl.replace("scanless_pool_test", "scanless_pool_%74est"),
		databaseUrl.replace("fixture:fixture-only@", ""),
		databaseUrl.replace(":fixture-only@", "@"),
		`${databaseUrl}?host=remote.example.com`,
		`${databaseUrl}?application_name=fixture`,
		`${databaseUrl}#fixture`,
	];
	for (const value of invalid)
		for (const mode of ["direct", "transaction"])
			assert.throws(
				() =>
					resolveScanlessDatabasePool({
						databaseUrl: value,
						mode,
						...(mode === "transaction" ? { poolUrl } : {}),
					}),
				/(INVALID|UNSAFE)_SCANLESS_DATABASE_URL/,
			);
});

void test("the pool accepts only the exact front port and identical database and credentials", () => {
	const invalid = [
		"not a URL",
		poolUrl.replace("postgresql:", "postgres:"),
		poolUrl.replace("postgresql:", "https:"),
		poolUrl.replace("127.0.0.1", "localhost"),
		poolUrl.replace("127.0.0.1", "remote.example.com"),
		poolUrl.replace(":55433/", ":55432/"),
		poolUrl.replace(":55433/", ":6432/"),
		poolUrl.replace("scanless_pool_test", "scanless_other_test"),
		poolUrl.replace("fixture:", "other:"),
		poolUrl.replace(":fixture-only@", ":other@"),
		`${poolUrl}?host=remote.example.com`,
		`${poolUrl}?dbname=production`,
		`${poolUrl}?application_name=fixture`,
		`${poolUrl}#fixture`,
	];
	for (const value of invalid)
		assert.throws(
			() => resolveScanlessDatabasePool({ databaseUrl, mode: "transaction", poolUrl: value }),
			/(INVALID|UNSAFE)_SCANLESS_DATABASE_POOL_URL/,
		);
});

void test("matching encoded credentials remain opaque and are never included in errors", () => {
	const encoded = databaseUrl.replace("fixture:fixture-only@", "fixture%40user:unique%2Fsecret@");
	assert.equal(
		resolveScanlessDatabasePool({
			databaseUrl: encoded,
			mode: "transaction",
			poolUrl: encoded.replace(":55432/", ":55433/"),
		}).report.mode,
		"transaction",
	);
	assert.throws(
		() => resolveScanlessDatabasePool({ databaseUrl: encoded, mode: "transaction", poolUrl }),
		(error: unknown) =>
			error instanceof Error &&
			!JSON.stringify(error).includes("secret") &&
			!error.message.includes("secret"),
	);
});
