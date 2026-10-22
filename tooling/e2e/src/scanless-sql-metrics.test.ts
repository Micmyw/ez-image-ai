import assert from "node:assert/strict";
import test from "node:test";

import { localSqlMetricsEnabled } from "../../../packages/database/prisma/query-metrics";
import { resolveScanlessSqlMetrics } from "./scanless-sql-metrics";

const databaseUrl = "postgresql://fixture:fixture-only@127.0.0.1:55432/scanless_metrics_test";
const hyperdriveUrl = databaseUrl.replace(
	"127.0.0.1:55432",
	"0123456789abcdef0123456789abcdef.hyperdrive.local:5432",
);

void test("SQL diagnostics remain on with the existing pretty format by default", () => {
	const defaults = resolveScanlessSqlMetrics();
	assert.deepEqual(defaults, resolveScanlessSqlMetrics({ mode: "on", format: "pretty" }));
	assert.equal(localSqlMetricsEnabled(databaseUrl, defaults.env.EZPIC_LOCAL_SQL_METRICS), true);
	assert.deepEqual(defaults.report, {
		sqlMetricsEnabled: true,
		localSqlTraceEnabled: true,
		sqlMetricsFormat: "pretty",
		sqlMetricsEvidence: "query-events-enabled",
	});
});

void test("explicit off overrides inherited flags for both Node and Worker diagnostics", () => {
	const disabled = resolveScanlessSqlMetrics({ mode: "off" });
	const inherited = {
		EZPIC_LOCAL_SQL_METRICS: "true",
		EZPIC_LOCAL_SQL_METRICS_HYPERDRIVE: "true",
	};
	const nodeEnvironment = Object.assign({}, inherited, disabled.env);
	const workerBindings = { ...inherited, ...disabled.env };
	assert.equal(
		localSqlMetricsEnabled(`${hyperdriveUrl}?sslmode=disable`, inherited.EZPIC_LOCAL_SQL_METRICS, {
			hyperdriveFlag: inherited.EZPIC_LOCAL_SQL_METRICS_HYPERDRIVE,
			originalConnectionString: databaseUrl,
		}),
		true,
	);
	assert.equal(localSqlMetricsEnabled(databaseUrl, nodeEnvironment.EZPIC_LOCAL_SQL_METRICS), false);
	assert.equal(
		localSqlMetricsEnabled(
			`${hyperdriveUrl}?sslmode=disable`,
			workerBindings.EZPIC_LOCAL_SQL_METRICS,
			{
				hyperdriveFlag: workerBindings.EZPIC_LOCAL_SQL_METRICS_HYPERDRIVE,
				originalConnectionString: databaseUrl,
			},
		),
		false,
	);
	assert.equal(nodeEnvironment.EZPIC_LOCAL_SQL_METRICS_HYPERDRIVE, "false");
	assert.equal(workerBindings.EZPIC_LOCAL_SQL_METRICS_HYPERDRIVE, "false");
	assert.deepEqual(disabled.report, {
		sqlMetricsEnabled: false,
		localSqlTraceEnabled: false,
		sqlMetricsFormat: "pretty",
		sqlMetricsEvidence: "unavailable-diagnostics-disabled",
	});
});

void test("format is independent of the explicit on/off switch", () => {
	for (const mode of ["on", "off"])
		for (const format of ["pretty", "jsonl"]) {
			const result = resolveScanlessSqlMetrics({ mode, format });
			assert.equal(result.enabled, mode === "on");
			assert.equal(result.env.EZPIC_LOCAL_SQL_METRICS_FORMAT, format);
			assert.equal(result.report.sqlMetricsFormat, format);
		}
});

void test("invalid modes fail rather than accidentally disabling diagnostics", () => {
	for (const mode of ["", "false", "true", "0", "1", "ON", "OFF", " off "])
		assert.throws(() => resolveScanlessSqlMetrics({ mode }), /INVALID_SCANLESS_SQL_METRICS_MODE/);
});

void test("invalid formats fail even when diagnostics are disabled", () => {
	for (const mode of ["on", "off"])
		for (const format of ["", "off", "JSONL", "compact"])
			assert.throws(
				() => resolveScanlessSqlMetrics({ mode, format }),
				/INVALID_SCANLESS_SQL_METRICS_FORMAT/,
			);
});
