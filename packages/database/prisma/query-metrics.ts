/** Explicit server-owned identities only. Never pass payloads, owner data, or private URLs. */
export interface DatabaseQueryContext {
	runId?: string;
	taskId?: string;
	jobId?: string;
	assetId?: string;
}

/** Local fixture diagnostics only. Never retain or publish SQL, bind values, or connection URLs. */
export interface DatabaseQuerySample extends DatabaseQueryContext {
	at: number;
	startedAt: number;
	completedAt: number;
	durationMs: number;
	/** Random per-client identity, independent of database/user/request contents. */
	clientScope: string;
}

export interface DatabaseQueryMetrics {
	clientScope: string;
	queryCount: number;
	cumulativeDurationMs: number;
	maximumDurationMs: number;
	invalidDurationEvents: number;
}

/** Only changes the representation of already-admitted local diagnostics. */
export function databaseQueryLogArgs(
	sample: DatabaseQuerySample,
	format: string | undefined,
): [string] | [string, DatabaseQuerySample] {
	return format === "jsonl"
		? [`media.database.query ${JSON.stringify(sample)}`]
		: ["media.database.query", sample];
}

/** Require an explicit flag and the dedicated local fixture ports/database naming convention. */
export function localSqlMetricsEnabled(
	connectionString: string,
	flag: string | undefined,
	fixture?: { hyperdriveFlag?: string; originalConnectionString?: string },
): boolean {
	if (flag !== "true") return false;
	try {
		const url = new URL(connectionString);
		const directFixture =
			["postgres:", "postgresql:"].includes(url.protocol) &&
			["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
			["55432", "55439"].includes(url.port) &&
			/(^|[_-])test([_-]|$)/.test(url.pathname.slice(1)) &&
			// pg connection-string query options can override host/port/database.
			// Diagnostic fixtures use explicit URLs without connection overrides.
			url.search === "" &&
			url.hash === "";
		if (directFixture) return true;
		if (
			fixture?.hyperdriveFlag !== "true" ||
			!fixture.originalConnectionString ||
			!localSqlMetricsEnabled(fixture.originalConnectionString, flag)
		)
			return false;
		// Miniflare/workerd substitutes a magic host for its configured local origin.
		// Require that exact observed binding shape plus a separately validated local
		// origin with the same database and credentials; arbitrary proxy URLs stay off.
		const original = new URL(fixture.originalConnectionString);
		return (
			url.protocol === original.protocol &&
			/^[a-f0-9]{32}\.hyperdrive\.local$/.test(url.hostname) &&
			url.port === "5432" &&
			url.pathname === original.pathname &&
			url.username === original.username &&
			url.password === original.password &&
			url.searchParams.size === 1 &&
			url.searchParams.get("sslmode") === "disable" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}

/**
 * Prisma query-event duration is a client-observed span, not isolated server/RTT time.
 * Counts cover emitted query events; the adapter may omit transaction-control commands.
 * Cumulative spans can overlap: consumers must union intervals before comparison
 * with wall time, and must not automatically deduct these spans from system latency.
 */
export function createDatabaseQueryMetrics(input: {
	clientKind: "request" | "node";
	context?: DatabaseQueryContext;
	emit(sample: DatabaseQuerySample): void;
	now?: () => number;
}) {
	const clientScope = `${input.clientKind}:${crypto.randomUUID()}`;
	// Capture once per client, not from the asynchronous query event's ambient
	// context or time window: concurrent tasks may complete in any order.
	const context: DatabaseQueryContext = {};
	for (const key of ["runId", "taskId", "jobId", "assetId"] as const) {
		const value = input.context?.[key];
		if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value))
			context[key] = value;
	}
	const now = input.now ?? Date.now;
	let queryCount = 0;
	let cumulativeDurationMs = 0;
	let maximumDurationMs = 0;
	let invalidDurationEvents = 0;
	return {
		observe(this: void, event: { duration: number }): void {
			// Read only the duration projection; even accessors for query/params stay untouched.
			const durationMs = event.duration;
			const completedAt = now();
			if (!Number.isFinite(durationMs) || durationMs < 0 || !Number.isFinite(completedAt)) {
				invalidDurationEvents += 1;
				return;
			}
			queryCount += 1;
			cumulativeDurationMs += durationMs;
			maximumDurationMs = Math.max(maximumDurationMs, durationMs);
			try {
				input.emit({
					at: completedAt,
					startedAt: completedAt - durationMs,
					completedAt,
					durationMs,
					clientScope,
					...context,
				});
			} catch {
				// An optional diagnostics sink must never change query/business outcomes.
			}
		},
		snapshot(): DatabaseQueryMetrics {
			return {
				clientScope,
				queryCount,
				cumulativeDurationMs,
				maximumDurationMs,
				invalidDurationEvents,
			};
		},
	};
}
