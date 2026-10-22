import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import {
	analyzeConcurrentScanlessTiming,
	analyzeScanlessTiming,
	type EvidenceRow,
} from "./scanless-timing-evidence";

const [reportPath, logPath, outputPath] = process.argv.slice(2);
if (!reportPath || !logPath) {
	throw new Error(
		"Usage: tsx src/analyze-generation-budget.mts <report.json> <runtime.log> [evidence.json]",
	);
}
const [reportText, runtimeLog] = await Promise.all([readText(reportPath), readText(logPath)]);
const report = JSON.parse(reportText) as EvidenceRow;
const concurrent = typeof report.concurrency === "number" && report.concurrency > 1;
const evidence = concurrent
	? analyzeConcurrentScanlessTiming(report, runtimeLog)
	: analyzeScanlessTiming(report, runtimeLog);
const analysisSources = await Promise.all(
	["analyze-generation-budget.mts", "scanless-timing-evidence.ts", "scanless-concurrency.ts"].map(
		async (file) => ({
			file: `tooling/e2e/src/${file}`,
			sha256: createHash("sha256")
				.update(await readFile(new URL(file, import.meta.url)))
				.digest("hex"),
		}),
	),
);
const json = JSON.stringify({ ...evidence, analysisSources }, null, 2) + "\n";
if (outputPath) await writeFile(outputPath, json);
else console.log(json);
import assert from "node:assert/strict";

// Functional/structural assertions are independent of the unproven latency budget.
if ("cases" in evidence) {
	assert.equal(
		evidence.summary.allSucceeded,
		true,
		"COHORT_CONTAINS_FAILURE_TIMEOUT_OR_MISSING_CASE",
	);
	assert.equal(evidence.globalScannerTaskEntries, 0, "GLOBAL_SCAN_ON_NORMAL_PATH");
	assert.equal(
		evidence.attribution.unassignedExecutorCompletions,
		0,
		"UNATTRIBUTED_EXECUTOR_INTERVALS",
	);
	for (const item of evidence.cases) assertFunctional(item);
} else assertFunctional(evidence);

function assertFunctional(evidence: ReturnType<typeof analyzeScanlessTiming>) {
	assert.equal(evidence.functionalEvidence.jobStatus, "SUCCEEDED", "JOB_NOT_SUCCEEDED");
	assert.equal(evidence.functionalEvidence.generationAttempts, 1, "ORIGINAL_ATTEMPT_COUNT");
	assert.equal(evidence.functionalEvidence.providerSubmissions, 1, "PROVIDER_RESUBMITTED");
	assert.equal(evidence.functionalEvidence.inputReviewSubmissions, 1, "INPUT_REVIEW_RESUBMITTED");
	assert.equal(evidence.functionalEvidence.outputReviewSubmissions, 1, "OUTPUT_REVIEW_RESUBMITTED");
	assert.equal(evidence.functionalEvidence.reserveEntries, 1, "RESERVATION_COUNT");
	assert.equal(evidence.functionalEvidence.settleEntries, 1, "SETTLEMENT_COUNT");
	assert.equal(
		evidence.functionalEvidence.globalScannerTaskEntries,
		0,
		"GLOBAL_SCAN_ON_NORMAL_PATH",
	);
	assert.equal(
		evidence.milliseconds.reviewHeavyOverlap,
		0,
		"REVIEW_OCCUPIED_HEAVY_SLOT_OR_TRACE_MISSING",
	);
}

async function readText(file: string) {
	const bytes = await readFile(file);
	// Windows PowerShell native redirection may use BOM-prefixed UTF-16LE;
	// preserve the raw file while decoding its actual transport encoding.
	return bytes
		.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? "utf16le" : "utf8")
		.replace(/^\uFEFF/, "");
}
