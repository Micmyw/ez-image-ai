import { sampleStatistics } from "./scanless-concurrency";
import {
	attributeConcurrentRuntime,
	parseRuntimeEvidence,
	type EvidenceRow,
} from "./scanless-timing-evidence";

const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);
const records = (value: unknown): EvidenceRow[] =>
	Array.isArray(value) ? value.filter((row) => row && typeof row === "object") : [];
const countBy = (items: readonly EvidenceRow[], field: string) => {
	const counts: Record<string, number> = {};
	for (const row of items) {
		const key = typeof row[field] === "string" ? row[field] : "unknown";
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
};

/** A fused child is business work inside one RPC, never a second executor request. */
export function scanlessExecutionAccounting(report: EvidenceRow, log: string) {
	const runtime = parseRuntimeEvidence(log);
	const attributed = attributeConcurrentRuntime(report, runtime);
	const rpc = attributed.filter(
		({ row }) => row.tag === "job.executor" && row.phase === "completed",
	);
	const started = attributed.filter(({ row }) => row.tag === "media.task.started");
	const inline = started.filter(({ row }) => row.executionMode === "inline");
	const observations = records(report.observations);
	const supplier = observations.filter(
		(row) => row.stage === "seeapi.query" || row.stage === "kie.query",
	);
	const stages = attributed.filter(({ row }) => row.tag === "media.upload.verification");
	const taskIds = [...new Set([...rpc, ...started].map(({ row }) => String(row.taskId)))].sort();
	return {
		executorRpcCompletions: rpc.length,
		unassignedRpcCompletions: rpc.filter((entry) => entry.caseIndex === null).length,
		inlineBusinessStageStarts: inline.length,
		standaloneStageStarts: started.length - inline.length,
		byTask: taskIds.map((taskId) => {
			const completed = rpc.filter(({ row }) => row.taskId === taskId);
			const child = inline.filter(({ row }) => row.taskId === taskId);
			const durations = completed.flatMap(({ row }) =>
				finite(row.startedAt) && finite(row.completedAt) && row.completedAt >= row.startedAt
					? [row.completedAt - row.startedAt]
					: [],
			);
			return {
				taskId,
				executorRpcCompletions: completed.length,
				inlineBusinessStageStarts: child.length,
				inlineParentTasks: countBy(
					child.map(({ row }) => row),
					"parentTaskId",
				),
				executorEnvelopeMs: sampleStatistics(durations),
				missingExecutorEnvelopeCount: completed.length - durations.length,
				inlineElapsedMs: null,
			};
		}),
		verificationStageCounts: countBy(
			stages.map(({ row }) => row),
			"stage",
		),
		verificationStageEnvelopes: [...new Set(stages.map(({ row }) => String(row.stage)))]
			.sort()
			.map((stage) => ({
				stage,
				reportedStageMs: sampleStatistics(
					stages.flatMap(({ row }) =>
						row.stage === stage && finite(row.stageMs) ? [row.stageMs] : [],
					),
				),
			})),
		supplierQueries: Array.isArray(report.observations) ? countBy(supplier, "stage") : null,
		supplierQueriesSucceeded: Array.isArray(report.observations)
			? countBy(
					supplier.filter((row) => row.done === true),
					"stage",
				)
			: null,
		statusRequests: Array.isArray(report.observations)
			? observations.filter((row) => row.stage === "browser.status.request").length
			: null,
		preparationStatusRequests: Array.isArray(report.observations)
			? observations.filter((row) => row.stage === "preparation.status.request").length
			: null,
		sqlObservedQueryCount:
			report.sqlMetricsEnabled === true
				? runtime.filter((row) => row.tag === "media.database.query").length
				: null,
		inlineEntries: inline,
		unassignedRpcEntries: rpc.filter((entry) => entry.caseIndex === null),
		boundary:
			"RPC completions, inline starts and supplier queries are separate counts. Phase-wake acceptance is not provider-query proof; stage/envelope spans are not CPU or unavoidable I/O.",
	};
}
