/** Local harness configuration only; never imported by a deployed application. */
export function resolveScanlessSqlMetrics(input: { mode?: string; format?: string } = {}) {
	const mode = input.mode ?? "on";
	if (mode !== "on" && mode !== "off") throw new Error("INVALID_SCANLESS_SQL_METRICS_MODE");
	const format = input.format ?? "pretty";
	if (format !== "pretty" && format !== "jsonl")
		throw new Error("INVALID_SCANLESS_SQL_METRICS_FORMAT");
	const enabled = mode === "on";
	return {
		enabled,
		format,
		// The same values are assigned before Node client construction and passed
		// as Worker bindings. Explicit false also overrides inherited true flags.
		env: {
			EZPIC_LOCAL_SQL_METRICS: String(enabled),
			EZPIC_LOCAL_SQL_METRICS_HYPERDRIVE: String(enabled),
			EZPIC_LOCAL_SQL_METRICS_FORMAT: format,
		},
		report: {
			sqlMetricsEnabled: enabled,
			localSqlTraceEnabled: enabled,
			sqlMetricsFormat: format,
			sqlMetricsEvidence: enabled ? "query-events-enabled" : "unavailable-diagnostics-disabled",
		},
	};
}
