import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { inspect } from "node:util";

import {
	analyzeScanlessTiming,
	analyzeConcurrentScanlessTiming,
	attributeConcurrentRuntime,
	intervalIntersectionMs,
	intervalUnionMs,
	mergeIntervals,
	observedRemainingWallBudget,
	parseRuntimeEvidence,
	type EvidenceRow,
} from "./scanless-timing-evidence";

function log(...entries: Array<[string, EvidenceRow]>) {
	return entries.map(([tag, row]) => `${tag} ${inspect(row, { compact: false })}`).join("\n");
}

void test("offline timing keeps real-upload preparation beside click-only latency", () => {
	const report = {
		concurrency: 2,
		cases: [
			{
				caseIndex: 0,
				outcome: "succeeded",
				browserTimes: { click: 4000, visible: 5000 },
				measurementModes: { inputReviewMode: "upload-reviewed" },
				measurementTimeline: {
					preparationToVisibleMs: 4900,
					uploadToVisibleMs: 4900,
					uploadToClickMs: 3900,
				},
				preClickReview: { status: "APPROVED", requestedAt: 3800, observedAt: 3900 },
			},
		],
	};
	const result = analyzeConcurrentScanlessTiming(report, "");
	assert.equal(result.milliseconds.clickToVisible.p50, 1000);
	assert.equal(result.milliseconds.preparationToVisible.p50, 4900);
	assert.equal(result.milliseconds.uploadToVisible.p50, 4900);
	assert.equal(result.milliseconds.uploadToClick.p50, 3900);
	assert.equal(result.summary.uploadToVisibleMs.p50, 4900);
	assert.equal(result.summary.missing, 1);
	assert.equal(result.summary.uploadToVisibleMs.sampleCount, 1);
	assert.deepEqual(result.cases[0]!.preClickReview, report.cases[0]!.preClickReview);
});

void test("compact query telemetry preserves every field and order alongside legacy executor logs", () => {
	const query = {
		at: 31,
		startedAt: 20.5,
		completedAt: 31,
		durationMs: 10.5,
		clientScope: "request:client",
		runId: "run-1",
		taskId: "media-prepare-event",
		jobId: "job-1",
		assetId: "asset-1",
	};
	const started = { phase: "started", startedAt: 10 };
	const finished = { phase: "completed", completedAt: 40, outcome: "failed" };
	const combined = [
		log(["job.executor", started]),
		`media.database.query ${JSON.stringify(query)}`,
		log(["job.executor", finished]),
	].join("\n");
	assert.deepEqual(parseRuntimeEvidence(combined), [
		{ tag: "job.executor", ...started },
		{ tag: "media.database.query", ...query },
		{ tag: "job.executor", ...finished },
	]);
	assert.deepEqual(parseRuntimeEvidence(log(["media.database.query", query])), [
		{ tag: "media.database.query", ...query },
	]);
});

void test("malformed compact telemetry cannot execute code or replace its logged tag", () => {
	assert.deepEqual(
		parseRuntimeEvidence(
			'media.database.query {"durationMs":invalid}\n' +
				'media.database.query {"tag":"job.executor","durationMs":3}\n',
		),
		[{ tag: "media.database.query", durationMs: 3 }],
	);
});

void test("stderr failure diagnostics retain closed fields and source lines for exact run attribution", () => {
	const failure = {
		event: "job_execution_failed",
		taskId: "media-settle-generation",
		runId: "run-1",
		attempt: 2,
		errorCode: "SETTLEMENT_TRANSACTION_CONFLICT",
		phase: "TRANSACTION_ROLLED_BACK",
		tag: "injected",
		privatePayload: "ignored",
	};
	const records = parseRuntimeEvidence(
		[
			"ignored first line",
			`stderr: ${JSON.stringify(failure)}`,
			"stderr: {malformed}",
			'stderr: {"event":"other","runId":"run-1"}',
			log([
				"media.task.started",
				{ jobId: "job-1", runId: "run-1", taskId: "media-settle-generation" },
			]),
		].join("\n"),
	);
	assert.deepEqual(records[0], {
		tag: "job_execution_failed",
		sourceLine: 2,
		taskId: "media-settle-generation",
		runId: "run-1",
		attempt: 2,
		errorCode: "SETTLEMENT_TRANSACTION_CONFLICT",
		phase: "TRANSACTION_ROLLED_BACK",
	});
	assert.equal(records.length, 2);
	const assignment = attributeConcurrentRuntime(
		{ cases: [{ caseIndex: 7, job: { id: "job-1" } }] },
		records,
	);
	assert.equal(assignment[0]!.caseIndex, 7);
	assert.equal(assignment[0]!.attribution, "unambiguous-run-id");
});

function noOpWakeContinuationEvidence() {
	// Reduced from the two unassigned prepare intervals in the saved v5 cohort.
	const identities = [
		{
			caseIndex: 38,
			jobId: "cmvipetcv00n8uwbkxh4h6utk",
			assetId: "asset_QPmdflNqcpiMtztIascI3THlS_i5Gkgc",
			parentRunId: "job-3cccc928d23862c35eb35f9da8ff5b3eb763a4ffc4631a8cc5753248c759901d",
			eventId: "cmvipfbe600gppsp75pqpmtwl",
			settlementRunId: "job-0fdc20a429a7f5715201b2ee7e829a84d0f6cd141e266027fc7180691b05cba7",
			runId: "job-c4e1bc4cdffc382d46cfac1c139521192cab748b1476a757e5fc9b9cc59d1842",
		},
		{
			caseIndex: 45,
			jobId: "cmvipetcx00n9uwbktoun8u4k",
			assetId: "asset_5GEgSRo9MtY-mQIAToopwgnqmy5xgoR4",
			parentRunId: "job-0d67ec9919c1e503996928bb3f8656c4e1d45192ebbb2d087a1103bdf88308e5",
			eventId: "cmvipfbe700gtpsp7ui2p0uoa",
			settlementRunId: "job-35c9b1803dd1f1710a04fa01fd405b4290411e354864d3ec63b06b0aee789b96",
			runId: "job-e65814a6f9ec073675b1b9e01f59129f9364bfd2b1fa5c5be5558dbc95c7b47f",
		},
	];
	const report: EvidenceRow = {
		cases: identities.map(({ caseIndex, jobId, assetId }) => ({
			caseIndex,
			job: { id: jobId, outputAssetId: assetId },
		})),
	};
	const runtime: EvidenceRow[] = identities.flatMap((item) => [
		{
			tag: "media.task.started",
			taskId: "media-verify-upload",
			runId: item.parentRunId,
			assetId: item.assetId,
		},
		{
			tag: "job.executor",
			taskId: "media-verify-upload",
			runId: item.parentRunId,
			phase: "completed",
			outcome: "ok",
		},
		{
			tag: "media.task.started",
			taskId: "media-settle-generation",
			runId: item.settlementRunId,
			jobId: item.jobId,
			outboxEventId: item.eventId,
		},
		{ tag: "media.task.started", taskId: "media-prepare-event", runId: item.runId },
		{
			tag: "media.database.query",
			taskId: "media-prepare-event",
			runId: item.runId,
			durationMs: 7,
		},
		{
			tag: "job.executor",
			taskId: "media-prepare-event",
			runId: item.runId,
			phase: "completed",
			outcome: "ok",
		},
	]);
	return { identities, report, runtime };
}

void test("v5 no-op prepare intervals retain all rows and resolve exact singleton wake continuation hashes", () => {
	const { report, runtime, identities } = noOpWakeContinuationEvidence();
	const result = attributeConcurrentRuntime(report, runtime);
	assert.equal(result.length, runtime.length);
	for (const item of identities) {
		const linked = result.filter(({ row }) => row.runId === item.runId);
		assert.equal(linked.length, 3);
		for (const row of linked) {
			assert.equal(row.caseIndex, item.caseIndex);
			assert.equal(row.attribution, "deterministic-wake-continuation");
		}
	}
});

void test("wake hash attribution requires a completed explicit parent and observed event identity", () => {
	const { report, runtime, identities } = noOpWakeContinuationEvidence();
	for (const missing of ["parent-start", "parent-completion", "event"]) {
		const reduced = runtime.filter((row) =>
			missing === "parent-start"
				? !(row.tag === "media.task.started" && row.taskId === "media-verify-upload")
				: missing === "parent-completion"
					? !(row.tag === "job.executor" && row.taskId === "media-verify-upload")
					: row.outboxEventId === undefined,
		);
		const result = attributeConcurrentRuntime(report, reduced);
		assert.ok(
			result
				.filter(({ row }) => identities.some((item) => item.runId === row.runId))
				.every((row) => row.caseIndex === null),
			missing,
		);
	}
});

void test("wake hash attribution never guesses missing event sets, deadlines or JSON field order", () => {
	const { report, runtime, identities } = noOpWakeContinuationEvidence();
	const first = identities[0]!;
	const request = { taskId: "media-deliver-events", payload: { eventIds: [first.eventId] } };
	const variants = [
		{ request, wakeContinuation: first.parentRunId },
		{ wakeContinuation: first.parentRunId, request, notBefore: 123 },
		{
			wakeContinuation: first.parentRunId,
			request: { ...request, payload: { eventIds: [first.eventId, identities[1]!.eventId] } },
		},
	];
	for (const input of variants) {
		const differentHash = `job-${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
		const changed = runtime.map((row) =>
			row.runId === first.runId ? { ...row, runId: differentHash } : row,
		);
		const result = attributeConcurrentRuntime(report, changed);
		assert.ok(
			result
				.filter(({ row }) => row.runId === differentHash)
				.every((row) => row.caseIndex === null),
		);
	}
});

void test("ambiguous wake parents or event ownership cannot supply a derived case", () => {
	const { report, runtime, identities } = noOpWakeContinuationEvidence();
	const first = identities[0]!,
		other = identities[1]!;
	for (const conflict of [
		{
			tag: "media.task.started",
			runId: first.parentRunId,
			taskId: "media-verify-upload",
			assetId: other.assetId,
		},
		{
			tag: "media.task.started",
			runId: other.settlementRunId,
			taskId: "media-settle-generation",
			jobId: other.jobId,
			outboxEventId: first.eventId,
		},
	]) {
		const result = attributeConcurrentRuntime(report, [...runtime, conflict]);
		assert.ok(
			result.filter(({ row }) => row.runId === first.runId).every((row) => row.caseIndex === null),
		);
	}
});

function example() {
	const report: EvidenceRow = {
		label: "fixture",
		artifactSha256: "a".repeat(64),
		job: {
			id: "job",
			inputAssetId: "input",
			outputAssetId: "output",
			assetReadyObservedUpdatedAt: "2099-01-01T00:00:00Z",
		},
		browserTimes: {
			click: 0,
			received: 280,
			decoded: 290,
			visible: 300,
			monotonic: { click: 1000, visible: 1300 },
		},
		outputBytes: 1_000_000,
		sourceDownloadRequests: 1,
		observations: [
			{ stage: "waffo.start", at: 0 },
			{ stage: "waffo.end", at: 5 },
			{ stage: "seeapi.request", role: "input", id: "review-input", at: 20 },
			{ stage: "seeapi.submit", role: "input", id: "review-input", at: 30, readyAt: 40 },
			{ stage: "seeapi.query", role: "input", id: "review-input", at: 35, done: false },
			{ stage: "seeapi.query", role: "input", id: "review-input", at: 42, done: true },
			{ stage: "kie.accepted", id: "generation", at: 70, readyAt: 100 },
			{ stage: "seeapi.request", role: "output", id: "review-output", at: 220 },
			{ stage: "seeapi.submit", role: "output", id: "review-output", at: 230, readyAt: 240 },
			{ stage: "seeapi.query", role: "output", id: "review-output", at: 245, done: true },
			{
				stage: "storage.http",
				method: "PUT",
				startedAt: 110,
				headersAt: 120,
				responseContentLength: "0",
			},
		],
	};
	const events: Array<[string, EvidenceRow]> = [
		["media.upload.verification", { assetId: "input", stage: "verification_started", at: 10 }],
		[
			"media.upload.verification",
			{ assetId: "input", stage: "moderation_result", decision: "ALLOW", at: 45 },
		],
		[
			"media.upload.verification",
			{ assetId: "input", stage: "verdict_committed", status: "READY", at: 60 },
		],
		[
			"job.executor",
			{
				executor: "jobs-primary",
				taskId: "first",
				runId: "run",
				phase: "completed",
				startedAt: 100,
				completedAt: 150,
				capacityWaitMs: 3,
			},
		],
		[
			"job.executor",
			{
				executor: "jobs-primary",
				taskId: "second",
				runId: "run",
				phase: "completed",
				startedAt: 160,
				completedAt: 200,
				capacityWaitMs: 0,
			},
		],
		["media.upload.verification", { assetId: "output", stage: "verification_started", at: 210 }],
		[
			"media.upload.verification",
			{ assetId: "output", stage: "moderation_result", decision: "ALLOW", at: 250 },
		],
		[
			"media.upload.verification",
			{ assetId: "output", stage: "verdict_committed", status: "READY", at: 270 },
		],
	];
	return { report, events };
}

void test("handoff due timestamps cannot become latency without clock alignment", () => {
	const { report, events } = example();
	events.push([
		"media.task.started",
		{
			taskId: "media-verify-upload",
			outboxEventId: "output-review-event",
			dueAt: 1020,
			startedAt: 200,
			dueToStartMs: -820,
		},
	]);
	const evidence = analyzeScanlessTiming(report, log(...events));
	assert.equal(evidence.handoffs[0]?.dueToStartMs, null);
	assert.equal(evidence.handoffs[0]?.dueAt, 1020);
	assert.equal(evidence.handoffs[0]?.startedAt, 200);
	assert.equal(evidence.handoffs[0]?.unverifiedReportedDueToStartMs, -820);
	assert.equal(evidence.handoffs[0]?.clockAlignment, "unverified");
	assert.equal(evidence.milliseconds.clickToVisible, 300);
	assert.equal(evidence.milliseconds.controllableOverhead, null);
	const positive = analyzeScanlessTiming(report, [
		{ tag: "media.task.started", dueAt: 100, startedAt: 200, dueToStartMs: 100 },
	]);
	assert.equal(positive.handoffs[0]?.dueToStartMs, null);
	assert.equal(positive.handoffs[0]?.unverifiedReportedDueToStartMs, 100);
});

void test("evidence records fresh-read protocol explicitly and leaves legacy configuration unknown", () => {
	for (const storageFreshReadEnabled of [true, false, undefined]) {
		const { report } = example();
		report.storageFreshReadEnabled = storageFreshReadEnabled;
		report.loginBonusReadCommittedEnabled = storageFreshReadEnabled;
		report.settlementFreshReadEnabled = storageFreshReadEnabled;
		assert.equal(
			analyzeScanlessTiming(report, []).storageFreshReadEnabled,
			storageFreshReadEnabled ?? null,
		);
		assert.equal(
			analyzeScanlessTiming(report, []).loginBonusReadCommittedEnabled,
			storageFreshReadEnabled ?? null,
		);
		assert.equal(
			analyzeScanlessTiming(report, []).settlementFreshReadEnabled,
			storageFreshReadEnabled ?? null,
		);
		const cohort = analyzeConcurrentScanlessTiming(
			{
				concurrency: 2,
				storageFreshReadEnabled,
				loginBonusReadCommittedEnabled: storageFreshReadEnabled,
				settlementFreshReadEnabled: storageFreshReadEnabled,
				cases: [{ ...report, caseIndex: 0, outcome: "succeeded" }],
			},
			"",
		);
		assert.equal(cohort.storageFreshReadEnabled, storageFreshReadEnabled ?? null);
		assert.equal(cohort.summary.storageFreshReadEnabled, storageFreshReadEnabled ?? null);
		assert.equal(cohort.loginBonusReadCommittedEnabled, storageFreshReadEnabled ?? null);
		assert.equal(cohort.summary.loginBonusReadCommittedEnabled, storageFreshReadEnabled ?? null);
		assert.equal(cohort.settlementFreshReadEnabled, storageFreshReadEnabled ?? null);
		assert.equal(cohort.summary.settlementFreshReadEnabled, storageFreshReadEnabled ?? null);
		assert(
			cohort.cases.every(
				(item) => item.settlementFreshReadEnabled === (storageFreshReadEnabled ?? null),
			),
		);
		assert(
			cohort.cases.every(
				(item) => item.storageFreshReadEnabled === (storageFreshReadEnabled ?? null),
			),
		);
		assert.equal(cohort.summary.missing, 1);
	}
});

function budgetFixture(): EvidenceRow {
	return {
		caseIndex: 0,
		outcome: "succeeded",
		job: { id: "budget-job", status: "SUCCEEDED" },
		browserTimes: { click: 0, visible: 1000, monotonic: { click: 20, visible: 1020 } },
		fixtureTiming: {
			processingClockVersion: 1,
			promptReviewDelayMs: 100,
			reviewDelayMs: 100,
			generationDelayMs: 200,
			generationResponseDelayMs: 999,
		},
		identityMap: ["prompt", "input", "generation", "output"].map((id) => ({ id, caseIndex: 0 })),
		observations: [
			{
				stage: "waffo.start",
				caseIndex: 0,
				requestId: "prompt",
				at: 0,
				plannedReadyAt: 100,
				processingDelayMs: 100,
			},
			{ stage: "waffo.end", caseIndex: 0, requestId: "prompt", at: 100 },
			{ stage: "seeapi.submit", caseIndex: 0, id: "input", role: "input", at: 150, readyAt: 250 },
			{ stage: "kie.accepted", caseIndex: 0, id: "generation", at: 300, readyAt: 500 },
			{ stage: "seeapi.submit", caseIndex: 0, id: "output", role: "output", at: 600, readyAt: 700 },
		],
	};
}

void test("late fixture timers remain in remaining wall time and HTTP/SQL spans receive no deduction", () => {
	const baseline = budgetFixture();
	const delayed = structuredClone(baseline);
	const observations = delayed.observations as EvidenceRow[];
	observations[1]!.at = 800;
	for (const row of observations.slice(2)) {
		row.at = Number(row.at) + 700;
		row.readyAt = Number(row.readyAt) + 700;
	}
	delayed.browserTimes = { click: 0, visible: 1700, monotonic: { click: 20, visible: 1720 } };
	observations.push(
		{ stage: "kie.completed", caseIndex: 0, id: "generation", at: 1450 },
		{
			stage: "kie.fixture.response_delay",
			caseIndex: 0,
			id: "generation",
			startedAt: 1000,
			completedAt: 1600,
		},
		{ stage: "storage.http", method: "PUT", startedAt: 1400, headersAt: 1690 },
	);
	assert.equal(observedRemainingWallBudget(baseline).observedRemainingWallUpperBound, 500);
	const result = analyzeScanlessTiming(delayed, [
		{ tag: "media.database.query", startedAt: 100, completedAt: 1699, durationMs: 1599 },
	]);
	assert.equal(result.milliseconds.observedRemainingWallUpperBound, 1200);
	assert.equal(result.observedRemainingWallEvidence.declaredFixtureProcessingUnionMs, 500);
	assert.equal(result.milliseconds.controllableOverhead, null);
	assert.equal(result.oneSecondCertified, false);
});

void test("legacy prompt timer envelopes are not retroactively declared supplier processing", () => {
	const report = budgetFixture();
	const prompt = (report.observations as EvidenceRow[])[0]!;
	delete prompt.plannedReadyAt;
	delete prompt.processingDelayMs;
	(report.observations as EvidenceRow[])[1]!.at = 105;
	const result = observedRemainingWallBudget(report);
	assert.equal(result.declaredFixtureProcessingUnionMs, 400);
	assert.equal(result.observedRemainingWallUpperBound, 600);
	assert.equal(
		result.rejectedFixtureIntervals[0]!.reason,
		"prompt-review-has-no-valid-declared-deadline",
	);
});

void test("remaining wall excludes only clipped union rather than summing overlapping fixture waits", () => {
	const report = budgetFixture();
	const observations = report.observations as EvidenceRow[];
	Object.assign(observations[2]!, { at: 50, readyAt: 150 });
	Object.assign(observations[3]!, { at: 100, readyAt: 300 });
	Object.assign(observations[4]!, { at: 250, readyAt: 350 });
	report.browserTimes = { click: 100, visible: 1000, monotonic: { click: 20, visible: 920 } };
	const result = observedRemainingWallBudget(report);
	assert.equal(
		result.selectedFixtureIntervals.reduce((total, span) => total + span.declaredDelayMs, 0),
		500,
	);
	assert.equal(result.declaredFixtureProcessingUnionMs, 250);
	assert.equal(result.observedRemainingWallUpperBound, 650);
});

void test("conflicting identity, repeated supplier calls and mismatched deadlines cannot lower the upper bound", () => {
	for (const mutate of [
		(report: EvidenceRow) => {
			(report.observations as EvidenceRow[])[3]!.caseIndex = 1;
		},
		(report: EvidenceRow) => {
			(report.observations as EvidenceRow[])[3]!.jobId = "other-job";
		},
		(report: EvidenceRow) => {
			(report.identityMap as EvidenceRow[]).push({ id: "generation", caseIndex: 1 });
		},
		(report: EvidenceRow) => {
			(report.observations as EvidenceRow[]).push({
				...(report.observations as EvidenceRow[])[3]!,
			});
		},
		(report: EvidenceRow) => {
			(report.observations as EvidenceRow[])[3]!.readyAt = 501;
		},
	]) {
		const report = budgetFixture();
		mutate(report);
		const result = observedRemainingWallBudget(report);
		assert.equal(result.observedRemainingWallUpperBound, 700);
		assert(result.rejectedFixtureIntervals.length > 0);
	}
	const report = budgetFixture();
	delete report.identityMap;
	assert.equal(observedRemainingWallBudget(report).observedRemainingWallUpperBound, 1000);
});

void test("clock differences are explicit, larger elapsed is retained and inconsistent clocks are unmeasured", () => {
	const report = budgetFixture();
	report.browserTimes = { click: 0, visible: 1000, monotonic: { click: 20, visible: 1021 } };
	const result = observedRemainingWallBudget(report);
	assert.equal(result.observedRemainingWallUpperBound, 501);
	assert.equal(result.epochMinusMonotonicMs, -1);
	assert.equal(result.conservativeElapsedMs, 1001);
	(report.browserTimes as EvidenceRow).monotonic = { click: 20, visible: 1100 };
	assert.equal(observedRemainingWallBudget(report).observedRemainingWallUpperBound, null);
	delete (report.browserTimes as EvidenceRow).monotonic;
	assert.equal(observedRemainingWallBudget(report).observedRemainingWallUpperBound, null);
});

void test("failed, timed-out and missing users remain in the upper-bound cohort denominator", () => {
	const succeeded = budgetFixture();
	const result = analyzeConcurrentScanlessTiming(
		{
			concurrency: 4,
			fixtureTiming: succeeded.fixtureTiming,
			identityMap: succeeded.identityMap,
			cases: [
				succeeded,
				{
					caseIndex: 1,
					outcome: "failed",
					job: { id: "failed", status: "FAILED" },
					browserTimes: succeeded.browserTimes,
				},
				{
					caseIndex: 2,
					outcome: "timeout",
					job: { id: "timeout", status: "RESERVED" },
					browserTimes: { click: 0, endedAt: 2000 },
				},
			],
		},
		"",
	);
	assert.equal(result.summary.expectedCount, 4);
	assert.equal(result.summary.succeeded, 1);
	assert.equal(result.summary.failed, 1);
	assert.equal(result.summary.timedOut, 1);
	assert.equal(result.summary.missing, 1);
	assert.equal(result.milliseconds.observedRemainingWallUpperBound.sampleCount, 1);
	assert.equal(result.milliseconds.observedRemainingWallUpperBound.max, 500);
	assert.equal(result.observedRemainingWallCoverage.unmeasuredCount, 3);
	assert.equal(result.observedRemainingWallCoverage.withinOneSecondCount, 1);
	assert(
		result.cases
			.slice(1)
			.every((item) => item.milliseconds.observedRemainingWallUpperBound === null),
	);
	assert.equal(result.oneSecondCertified, false);
});

void test("complete transfer-request trace can prove no observed heavy occupancy", () => {
	const { report, events } = example();
	const result = analyzeScanlessTiming(
		report,
		log(...events.filter(([tag]) => tag !== "job.executor"), [
			"job.executor",
			{
				executor: "jobs-transfer-request",
				phase: "completed",
				outcome: "ok",
				taskId: "media-finalize-generation",
				runId: "run",
				startedAt: 100,
				completedAt: 200,
				capacityWaitMs: 0,
			},
		]),
	);
	assert.equal(result.milliseconds.heavyWallTotal, 0);
	assert.equal(result.milliseconds.reviewHeavyOverlap, 0);
	assert.equal(result.executors[0]!.executor, "jobs-transfer-request");
	assert.equal(result.executors[0]!.wallMs.max, 100);
});

void test("a transfer reroute without its heavy trace is unknown, not zero occupancy", () => {
	const { report, events } = example();
	const result = analyzeScanlessTiming(
		report,
		log(...events.filter(([tag]) => tag !== "job.executor"), [
			"job.executor",
			{
				executor: "jobs-transfer-request",
				phase: "completed",
				outcome: "rerouted",
				taskId: "media-finalize-generation",
				runId: "run",
				startedAt: 100,
				completedAt: 200,
			},
		]),
	);
	assert.equal(result.milliseconds.heavyWallTotal, null);
	assert.equal(result.milliseconds.reviewHeavyOverlap, null);
});

void test("concurrent attribution uses explicit IDs and never overlapping SQL times", () => {
	const report = {
		concurrency: 2,
		cases: [
			{ caseIndex: 0, ownerId: "owner0", job: { id: "job0", inputAssetId: "asset0" } },
			{ caseIndex: 1, ownerId: "owner1", job: { id: "job1", inputAssetId: "asset1" } },
		],
	};
	const attributed = attributeConcurrentRuntime(report, [
		{ tag: "media.task.started", jobId: "job0", runId: "run0", startedAt: 10 },
		{ tag: "media.task.started", assetId: "asset1", runId: "run1", startedAt: 10 },
		{ tag: "media.database.query", runId: "run0", startedAt: 10, completedAt: 20 },
		{ tag: "media.database.query", runId: "run1", startedAt: 10, completedAt: 20 },
		{ tag: "media.database.query", clientScope: "node:shared", startedAt: 10, completedAt: 20 },
	]);
	assert.deepEqual(
		attributed.map((entry) => entry.caseIndex),
		[0, 1, 0, 1, null],
	);
	assert.equal(attributed[4]!.attribution, "unassigned");
});

void test("shared or conflicting run IDs remain ambiguous without losing precise identity", () => {
	const report = {
		cases: [
			{ caseIndex: 0, job: { id: "job0", inputAssetId: "asset0" } },
			{ caseIndex: 1, job: { id: "job1", inputAssetId: "asset1" } },
		],
	};
	const attributed = attributeConcurrentRuntime(report, [
		{ jobId: "job0", runId: "shared" },
		{ jobId: "job1", runId: "shared" },
		{ tag: "media.database.query", runId: "shared" },
		{ tag: "media.database.query", jobId: "job0", runId: "shared" },
		{ jobId: "job0", assetId: "asset1" },
	]);
	assert.deepEqual(
		attributed.map((entry) => entry.caseIndex),
		[0, 1, null, 0, null],
	);
	assert.equal(attributed[2]!.attribution, "ambiguous");
	assert.equal(attributed[4]!.attribution, "ambiguous");
});

void test("cohort analysis retains all 50 and every execution of a rerouted task", () => {
	const report: EvidenceRow = {
		label: "concurrent",
		concurrency: 50,
		cases: [
			{
				caseIndex: 0,
				outcome: "succeeded",
				job: { id: "job0" },
				browserTimes: { click: 0, visible: 300 },
			},
			{
				caseIndex: 1,
				outcome: "timeout",
				job: { id: "job1" },
				browserTimes: { click: 2, endedAt: 500 },
			},
		],
	};
	const result = analyzeConcurrentScanlessTiming(
		report,
		log(
			["media.task.started", { jobId: "job0", runId: "run0", startedAt: 10 }],
			[
				"job.executor",
				{
					executor: "jobs-transfer-request",
					taskId: "media-finalize-generation",
					runId: "run0",
					phase: "completed",
					outcome: "rerouted",
					startedAt: 10,
					completedAt: 20,
				},
			],
			[
				"job.executor",
				{
					executor: "jobs-primary",
					taskId: "media-finalize-generation",
					runId: "run0",
					phase: "completed",
					outcome: "ok",
					startedAt: 30,
					completedAt: 50,
				},
			],
			[
				"media.database.query",
				{ runId: "run0", clientScope: "request:0", durationMs: 5, startedAt: 10, completedAt: 15 },
			],
			[
				"media.database.query",
				{ clientScope: "node:shared", durationMs: 7, startedAt: 10, completedAt: 17 },
			],
		),
	);
	assert.equal(result.cases.length, 50);
	assert.equal(result.summary.succeeded, 1);
	assert.equal(result.summary.timedOut, 1);
	assert.equal(result.summary.missing, 48);
	assert.equal(result.summary.peakActiveBeforeVisibleOrFailure, 2);
	assert.equal(result.database.assignedQueryCount, 1);
	assert.equal(result.database.unassignedQueryCount, 1);
	assert.equal(result.cases[0]!.executors.length, 2);
	assert.equal(result.cases[0]!.heavyExecutions.length, 1);
	assert.equal(result.cases[0]!.milliseconds.heavyWallTotal, 20);
	assert.equal(result.oneSecondCertified, false);
});

void test("interval union clips and de-duplicates overlapping external branches", () => {
	const spans = [
		{ start: 0, end: 30 },
		{ start: 20, end: 50 },
		{ start: 50, end: 60 },
		{ start: 80, end: 90 },
	];
	assert.deepEqual(mergeIntervals(spans), [
		{ start: 0, end: 60 },
		{ start: 80, end: 90 },
	]);
	assert.equal(intervalUnionMs(spans, { start: 10, end: 85 }), 55);
	assert.equal(
		intervalIntersectionMs(spans, [
			{ start: 25, end: 40 },
			{ start: 35, end: 100 },
		]),
		45,
	);
	assert.throws(() => mergeIntervals([{ start: 10, end: 0 }]), /INVALID_EVIDENCE_INTERVAL/);
});

void test("concurrent SQL diagnostics off or absent stay unknown without dropping the cohort", () => {
	for (const sqlMetricsEnabled of [false, undefined]) {
		const result = analyzeConcurrentScanlessTiming(
			{ concurrency: 50, cases: [], sqlMetricsEnabled },
			"",
		);
		assert.equal(result.cases.length, 50);
		assert.equal(result.summary.missing, 50);
		for (const field of [
			"totalObservedQueryCount",
			"assignedQueryCount",
			"unassignedQueryCount",
			"ambiguousQueryCount",
			"requestClientEvents",
			"nodeClientEvents",
			"queryDurationSumMs",
			"querySpanUnionMs",
		] as const)
			assert.equal(result.database[field], null, field);
		assert.equal(result.milliseconds.controllableOverhead, null);
		assert.equal(result.oneSecondCertified, false);
	}
});

void test("enabled SQL diagnostics retain zero observed rows as a count rather than an I/O deduction", () => {
	const result = analyzeConcurrentScanlessTiming(
		{ concurrency: 2, cases: [], sqlMetricsEnabled: true },
		"",
	);
	assert.equal(result.database.totalObservedQueryCount, 0);
	assert.equal(result.database.queryDurationSumMs, 0);
	assert.equal(result.milliseconds.necessaryDatabaseIo, null);
	assert.equal(result.milliseconds.controllableOverhead, null);
});

void test("runtime log parser accepts primitive fields without executing log contents", () => {
	const parsed = parseRuntimeEvidence(
		log([
			"job.executor",
			{
				taskId: "task's",
				startedAt: 10,
				completedAt: 20,
				active: 0,
				outcome: null,
				nested: { startedAt: 999 },
			},
		]),
	);
	assert.deepEqual(parsed, [
		{
			tag: "job.executor",
			taskId: "task's",
			startedAt: 10,
			completedAt: 20,
			active: 0,
			outcome: null,
		},
	]);
	assert.equal(
		parseRuntimeEvidence("job.executor {\n  startedAt: (() => { throw 'no'; })(),\n}\n")[0]!
			.startedAt,
		undefined,
	);
});

void test("raw occupancy and real committed verdicts stay separate from successful query", () => {
	const { report, events } = example();
	const result = analyzeScanlessTiming(report, log(...events));
	assert.equal(result.milliseconds.clickToVisible, 300);
	assert.equal(result.milliseconds.clickToVisibleMonotonic, 300);
	assert.equal(result.milliseconds.readyCommitToBrowserReceived, 10);
	assert.equal(result.milliseconds.heavyWallTotal, 90);
	assert.equal(result.milliseconds.heavyWallUnion, 90);
	assert.equal(result.milliseconds.reviewHeavyOverlap, 0);
	assert.equal(result.milliseconds.externalFixtureProcessingUnionWithinVisibleWindow, 55);
	assert.deepEqual(result.reviews[1]!.milliseconds, {
		fixtureProcessing: 10,
		fixtureReadyToSuccessfulQuery: 5,
		fixtureReadyToResultReceived: 10,
		fixtureReadyToVerdictCommit: 30,
		resultReceivedToVerdictCommit: 20,
		verificationWall: 60,
	});
	assert.equal(result.milliseconds.necessaryDatabaseIo, null);
	assert.equal(result.milliseconds.necessaryNetworkIo, null);
	assert.equal(result.milliseconds.controllableOverhead, null);
	assert.equal(result.oneSecondCertified, false);
});

void test("review overlap includes the entire actual review span through commit", () => {
	const { report, events } = example();
	events[4]![1].completedAt = 260;
	const result = analyzeScanlessTiming(report, log(...events));
	assert.equal(result.milliseconds.reviewHeavyOverlap, 50);
});

void test("suspended executor intervals do not count as heavy occupancy", () => {
	const { report, events } = example();
	Object.assign(events[3]![1], {
		completedAt: 300,
		resourceHeldMs: 20,
		heldIntervals: [
			{ startedAt: 100, completedAt: 110 },
			{ startedAt: 290, completedAt: 300 },
		],
	});
	const result = analyzeScanlessTiming(report, log(...events));
	assert.equal(result.heavyExecutions[0]!.executionWallMs, 200);
	assert.equal(result.heavyExecutions[0]!.wallMs, 20);
	assert.equal(result.milliseconds.heavyWallTotal, 60);
	assert.equal(result.milliseconds.reviewHeavyOverlap, 0);
});

void test("invalid explicit holds cannot fall back to an executor envelope", () => {
	const { report, events } = example();
	events[3]![1].heldIntervals = [{ startedAt: 100, completedAt: 999 }];
	const result = analyzeScanlessTiming(report, log(...events));
	assert.equal(result.milliseconds.heavyWallTotal, null);
	assert.equal(result.milliseconds.reviewHeavyOverlap, null);
});

void test("notification transport time is matched to the output READY version", () => {
	const { report, events } = example();
	(report.browserTimes as EvidenceRow).notifications = [
		{ type: "ready", jobId: "job", receivedAt: 65 },
		{ type: "job-updated", jobId: "job", version: "job:1", receivedAt: 70 },
		{ type: "job-updated", jobId: "job", version: "asset:output:g1:ready", receivedAt: 275 },
	];
	const result = analyzeScanlessTiming(report, log(...events));
	assert.equal(result.milliseconds.readyCommitToBrowserNotification, 5);
	assert.equal(result.milliseconds.browserNotificationToStateReceived, 5);
});

void test("SQL event totals keep parallel spans distinct and exclude fixture setup", () => {
	const { report, events } = example();
	for (const [start, end] of [
		[-30, -10],
		[20, 50],
		[40, 80],
		[290, 320],
	])
		events.push([
			"media.database.query",
			{
				startedAt: start,
				completedAt: end,
				durationMs: end! - start!,
				clientScope: "request",
			},
		]);
	const result = analyzeScanlessTiming(report, log(...events));
	assert.equal(result.database.totalObservedQueryCount, 4);
	assert.equal(result.database.queriesTouchingVisibleWindow, 3);
	assert.equal(result.database.queryDurationSumMs, 100);
	assert.equal(result.database.querySpanUnionWithinVisibleWindowMs, 70);
	assert.equal(result.milliseconds.necessaryDatabaseIo, null);
});

void test("legacy executor elapsed time cannot substitute for missing interval timestamps", () => {
	const { report, events } = example();
	delete events[3]![1].startedAt;
	events[3]![1].elapsedMs = 50;
	const result = analyzeScanlessTiming(report, log(...events));
	assert.equal(result.milliseconds.heavyWallTotal, null);
	assert.equal(result.milliseconds.heavyWallUnion, null);
	assert.equal(result.milliseconds.reviewHeavyOverlap, null);
	assert(result.missingEvidence.some((item) => item.includes("every heavy execution")));
});

void test("missing commit markers never fall back to asset updatedAt or successful result time", () => {
	const { report, events } = example();
	events.pop();
	const result = analyzeScanlessTiming(report, log(...events));
	assert.equal(result.milliseconds.readyCommitToBrowserReceived, null);
	assert.equal(result.milliseconds.reviewHeavyOverlap, null);
	assert.equal(result.reviews[1]!.milliseconds.fixtureReadyToVerdictCommit, null);
	assert.equal(result.reviews[1]!.milliseconds.fixtureReadyToResultReceived, 10);
});

void test("ambiguous review submissions and reversed clocks remain unknown", () => {
	const { report, events } = example();
	(report.observations as EvidenceRow[]).push({
		stage: "seeapi.submit",
		role: "output",
		id: "other",
		at: 235,
		readyAt: 230,
	});
	const result = analyzeScanlessTiming(report, log(...events));
	assert.equal(result.reviews[1]!.verdictCommittedAt, null);
	assert.equal(result.reviews[2]!.milliseconds.fixtureProcessing, null);
	assert.equal(result.milliseconds.reviewHeavyOverlap, null);
});
