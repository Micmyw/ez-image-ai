import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import {
	attributePostgresEvidence,
	parsePostgresEvidence,
	postgresStatementCategory,
} from "./scanless-postgres-evidence";
import {
	attributeConcurrentRuntime,
	parseRuntimeEvidence,
	type EvidenceRow,
} from "./scanless-timing-evidence";

const [postgresPath, runtimePath, reportPath, outputPath] = process.argv.slice(2);
if (!postgresPath || !runtimePath || !reportPath || !outputPath)
	throw new Error(
		"Usage: tsx src/analyze-scanless-postgres.mts <postgres-window.log> <runtime.log> <report.json> <new-output.json>",
	);
const read = async (file: string) => {
	const bytes = await readFile(file);
	return {
		text: bytes
			.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? "utf16le" : "utf8")
			.replace(/^\uFEFF/, ""),
		path: file,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
};
const [postgres, runtimeSource, reportSource] = await Promise.all([
	read(postgresPath),
	read(runtimePath),
	read(reportPath),
]);
const report = JSON.parse(reportSource.text) as EvidenceRow;
const runtime = parseRuntimeEvidence(runtimeSource.text);
const parsed = parsePostgresEvidence(postgres.text);
const attributed = attributePostgresEvidence(parsed.errors, runtime);
const pgRows = attributed.map((error) => ({ tag: "postgres.error", ...error.context }));
const assignments = attributeConcurrentRuntime(report, [...runtime, ...pgRows]);
const pgAssignments = assignments.slice(runtime.length);
const errors = attributed.map((error, index) => ({
	...error,
	category: postgresStatementCategory(error),
	caseIndex: pgAssignments[index]!.caseIndex,
	caseAttribution: pgAssignments[index]!.attribution,
}));
const runtimeFailures = assignments
	.slice(0, runtime.length)
	.filter(({ row }) => row.tag === "job_execution_failed")
	.map(({ row, caseIndex, attribution }) => ({ ...row, caseIndex, attribution }));
const countBy = (items: readonly EvidenceRow[], key: string) =>
	Object.fromEntries(
		[...new Set(items.map((item) => String(item[key])))].map((value) => [
			value,
			items.filter((item) => String(item[key]) === value).length,
		]),
	);
const analysisSources = await Promise.all(
	[
		"analyze-scanless-postgres.mts",
		"scanless-postgres-evidence.ts",
		"scanless-timing-evidence.ts",
		"scanless-concurrency.ts",
	].map(async (file) => ({
		file: `tooling/e2e/src/${file}`,
		sha256: createHash("sha256")
			.update(await readFile(new URL(file, import.meta.url)))
			.digest("hex"),
	})),
);
const result = {
	label: report.label,
	artifactSha256: report.artifactSha256,
	sqlMetricsFormat: report.sqlMetricsFormat ?? null,
	settlementFreshReadEnabled:
		typeof report.settlementFreshReadEnabled === "boolean"
			? report.settlementFreshReadEnabled
			: null,
	sources: [postgres, runtimeSource, reportSource].map(({ text: _text, ...source }) => source),
	analysisSources,
	prefixLines: parsed.prefixLines,
	unmatchedContextLines: parsed.unmatchedContextLines,
	summary: {
		errorCount: errors.length,
		severities: countBy(errors, "severity"),
		statements: countBy(errors, "category"),
		attributions: countBy(errors, "attribution"),
		taskAttributedErrors: errors.filter((error) => error.attribution === "exact-client-scope")
			.length,
		caseAttributedErrors: errors.filter((error) => error.caseIndex !== null).length,
		runtimeFailureCount: runtimeFailures.length,
		runtimeFailureCodes: countBy(runtimeFailures, "errorCode"),
		unassignedRuntimeFailures: runtimeFailures.filter((row) => row.caseIndex === null).length,
	},
	errors,
	runtimeFailures,
	boundary: `${parsed.boundary} Task/run attribution requires the identical clientScope in recorded query metrics. Missing metrics or shared Node scopes do not establish a task. stderr failure codes are diagnostic data, not retry authorization.`,
	oneSecondCertified: false,
};
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ outputPath, ...result.summary, prefixLines: parsed.prefixLines }));
