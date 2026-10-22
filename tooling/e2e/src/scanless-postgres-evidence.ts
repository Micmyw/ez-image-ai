/** Offline PostgreSQL evidence. Identity is exact clientScope, never clock proximity. */
import type { EvidenceRow } from "./scanless-timing-evidence";

export type PostgresErrorEvidence = {
	sourceLine: number;
	lastSourceLine: number;
	timestamp: string;
	timezone: string;
	pid: number;
	applicationName: string | null;
	clientScope: string | null;
	backendContext: string;
	severity: "ERROR" | "FATAL" | "PANIC";
	message: string;
	detail: string;
	hint: string;
	serverContext: string;
	location: string;
	internalQuery: string;
	statement: string;
};

const scopePattern =
	/^(?:request|node):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const contextFields = [
	"taskId",
	"runId",
	"jobId",
	"assetId",
	"attemptId",
	"outboxEventId",
	"ownerId",
] as const;

export function parsePostgresEvidence(log: string) {
	const errors: PostgresErrorEvidence[] = [];
	const unmatchedContextLines: Array<{
		sourceLine: number;
		pid: number;
		applicationName: string | null;
		kind: string;
	}> = [];
	const backends = new Map<
		number,
		{ applicationName: string | null; generation: number; error: PostgresErrorEvidence | null }
	>();
	let multiline: {
		error: PostgresErrorEvidence;
		field:
			| "message"
			| "detail"
			| "hint"
			| "serverContext"
			| "location"
			| "internalQuery"
			| "statement";
	} | null = null;
	let oldPrefixLines = 0;
	let applicationPrefixLines = 0;
	let unparsedHeaderLines = 0;
	for (const [index, line] of log.split(/\r?\n/).entries()) {
		const match =
			/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?) (\S+) (?:(.*?) )?\[(\d+)\] ([A-Z]+):\s*(.*)$/.exec(
				line,
			);
		if (!match) {
			if (/^\d{4}-\d{2}-\d{2} /.test(line)) {
				multiline = null;
				backends.clear();
				unparsedHeaderLines++;
			} else if (multiline && line.trim()) {
				multiline.error[multiline.field] += `\n${line}`;
				multiline.error.lastSourceLine = index + 1;
			}
			continue;
		}
		multiline = null;
		if (match[3] === undefined) oldPrefixLines++;
		else applicationPrefixLines++;
		const applicationName = match[3] || null;
		const pid = Number(match[4]);
		const kind = match[5]!;
		const previous = backends.get(pid);
		const state =
			previous?.applicationName === applicationName
				? previous
				: {
						applicationName,
						generation: (previous?.generation ?? 0) + 1,
						error: null,
					};
		backends.set(pid, state);
		if (kind === "ERROR" || kind === "FATAL" || kind === "PANIC") {
			const error: PostgresErrorEvidence = {
				sourceLine: index + 1,
				lastSourceLine: index + 1,
				timestamp: match[1]!,
				timezone: match[2]!,
				pid,
				applicationName,
				clientScope: applicationName && scopePattern.test(applicationName) ? applicationName : null,
				backendContext: `${pid}:${state.generation}:${applicationName ?? "unknown"}`,
				severity: kind,
				message: match[6]!,
				detail: "",
				hint: "",
				serverContext: "",
				location: "",
				internalQuery: "",
				statement: "",
			};
			errors.push(error);
			state.error = error;
			multiline = { error, field: "message" };
		} else if (["DETAIL", "HINT", "CONTEXT", "LOCATION", "QUERY", "STATEMENT"].includes(kind)) {
			if (!state.error) {
				unmatchedContextLines.push({ sourceLine: index + 1, pid, applicationName, kind });
				continue;
			}
			const field =
				kind === "DETAIL"
					? "detail"
					: kind === "HINT"
						? "hint"
						: kind === "CONTEXT"
							? "serverContext"
							: kind === "LOCATION"
								? "location"
								: kind === "QUERY"
									? "internalQuery"
									: "statement";
			state.error[field] += (state.error[field] ? "\n" : "") + match[6]!;
			state.error.lastSourceLine = index + 1;
			multiline = { error: state.error, field };
		} else {
			// An intervening backend message is a boundary, not proof of the same error/session.
			state.error = null;
		}
	}
	return {
		errors,
		unmatchedContextLines,
		prefixLines: {
			legacy: oldPrefixLines,
			applicationName: applicationPrefixLines,
			unparsed: unparsedHeaderLines,
		},
		boundary:
			"backendContext is an observed PID/application_name segment, not PostgreSQL %c session identity. Legacy or empty application_name remains unknown. No timestamp joins are used.",
	};
}

export function attributePostgresEvidence(
	errors: readonly PostgresErrorEvidence[],
	runtime: readonly EvidenceRow[],
) {
	const scopes = new Map<string, EvidenceRow[]>();
	for (const row of runtime) {
		if (row.tag !== "media.database.query" || typeof row.clientScope !== "string") continue;
		const rows = scopes.get(row.clientScope) ?? [];
		rows.push(row);
		scopes.set(row.clientScope, rows);
	}
	return errors.map((error) => {
		const queries = error.clientScope ? (scopes.get(error.clientScope) ?? []) : [];
		const observedContext = Object.fromEntries(
			contextFields.map((key) => [
				key,
				[
					...new Set(
						queries
							.map((row) => row[key])
							.filter((value): value is string => typeof value === "string" && value.length > 0),
					),
				],
			]),
		) as Record<(typeof contextFields)[number], string[]>;
		const ambiguous = contextFields.some((key) => observedContext[key].length > 1);
		const context = Object.fromEntries(
			contextFields.map((key) => [
				key,
				!ambiguous && observedContext[key].length === 1 ? observedContext[key][0]! : null,
			]),
		);
		const attribution = !error.clientScope
			? "unknown"
			: !queries.length
				? "scope-without-query-metrics"
				: ambiguous
					? "ambiguous-client-scope"
					: context.taskId && context.runId
						? "exact-client-scope"
						: "client-scope-only";
		return { ...error, attribution, observedQueryCount: queries.length, context, observedContext };
	});
}

export function postgresStatementCategory(
	error: Pick<PostgresErrorEvidence, "severity" | "message" | "statement">,
) {
	const statement = error.statement.replace(/\s+/g, " ").trim();
	if (error.severity === "FATAL" || error.severity === "PANIC")
		return `${error.severity} ${error.message}`;
	if (statement === "COMMIT") return "COMMIT";
	if (/^UPDATE "public"\."generation_job" SET "finalizationStage"/.test(statement))
		return "UPDATE generation_job finalization retry";
	if (/^UPDATE "public"\."generation_job" SET "status"/.test(statement))
		return "UPDATE generation_job terminal status";
	return (
		statement.match(/^(?:UPDATE|INSERT INTO) "public"\."([a-z_]+)"/)?.[0] ?? statement.slice(0, 160)
	);
}
