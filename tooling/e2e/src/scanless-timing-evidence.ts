/** Offline evidence only: external fixture intervals are never treated as a
 * complete decomposition of necessary I/O or proof of a one-second budget.
 */
import { createHash } from "node:crypto";

import {
	peakConcurrentIntervals,
	sampleStatistics,
	summarizeConcurrentCases,
} from "./scanless-concurrency";
export type EvidenceRow = Record<string, unknown>;
export type Interval = { start: number; end: number };

function number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function string(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function boolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function record(value: unknown): EvidenceRow {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as EvidenceRow)
		: {};
}

function rows(value: unknown): EvidenceRow[] {
	return Array.isArray(value) ? value.map(record) : [];
}

function interval(start: unknown, end: unknown): Interval | null {
	const from = number(start);
	const to = number(end);
	return from !== null && to !== null && to >= from ? { start: from, end: to } : null;
}

function duration(start: unknown, end: unknown): number | null {
	const span = interval(start, end);
	return span === null ? null : span.end - span.start;
}

export function mergeIntervals(intervals: readonly Interval[], within?: Interval): Interval[] {
	const ordered = intervals
		.map((span) => {
			if (!interval(span.start, span.end)) throw new Error("INVALID_EVIDENCE_INTERVAL");
			return within
				? { start: Math.max(span.start, within.start), end: Math.min(span.end, within.end) }
				: { ...span };
		})
		.filter((span) => span.end > span.start)
		.sort((left, right) => left.start - right.start);
	const merged: Interval[] = [];
	for (const span of ordered) {
		const previous = merged.at(-1);
		if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
		else merged.push(span);
	}
	return merged;
}

export function intervalUnionMs(intervals: readonly Interval[], within?: Interval): number {
	return mergeIntervals(intervals, within).reduce(
		(total, span) => total + span.end - span.start,
		0,
	);
}

export function intervalIntersectionMs(
	left: readonly Interval[],
	right: readonly Interval[],
): number {
	const intersections: Interval[] = [];
	for (const a of mergeIntervals(left)) {
		for (const b of mergeIntervals(right)) {
			const intersection = interval(Math.max(a.start, b.start), Math.min(a.end, b.end));
			if (intersection) intersections.push(intersection);
		}
	}
	return intervalUnionMs(intersections);
}

/** Parse only primitive fields from console blocks. Never eval runtime logs. */
export function parseRuntimeEvidence(log: string): EvidenceRow[] {
	const parsed: Array<{ index: number; row: EvidenceRow }> = [];
	for (const match of log.matchAll(/^([a-zA-Z][\w.-]+) \{\r?\n([\s\S]*?)^\}/gm)) {
		const row: EvidenceRow = { tag: match[1] };
		for (const field of match[2]!.matchAll(/^  ([\w]+): (.+?),?\r?$/gm)) {
			const key = field[1]!;
			const token = field[2]!.replace(/,$/, "").trim();
			if (token === "null") row[key] = null;
			else if (token === "true" || token === "false") row[key] = token === "true";
			else if (/^-?\d+(?:\.\d+)?$/.test(token)) row[key] = Number(token);
			else if (/^'(?:[^'\\]|\\.)*'$/.test(token))
				row[key] = token.slice(1, -1).replace(/\\(['\\])/g, "$1");
			else if (/^"(?:[^"\\]|\\.)*"$/.test(token)) row[key] = JSON.parse(token);
		}
		if (/^  heldIntervals:/m.test(match[2]!)) {
			row.heldIntervals = null;
			const list = /^  heldIntervals:\s*\[([\s\S]*?)\],?\r?$/m.exec(match[2]!);
			if (list) {
				const shape =
					/\{\s*startedAt:\s*(-?\d+(?:\.\d+)?),\s*completedAt:\s*(-?\d+(?:\.\d+)?),?\s*\}/g;
				const spans = [...list[1]!.matchAll(shape)].map((entry) => ({
					startedAt: Number(entry[1]),
					completedAt: Number(entry[2]),
				}));
				if (list[1]!.replace(shape, "").replace(/[\s,]/g, "") === "") row.heldIntervals = spans;
			}
		}
		parsed.push({ index: match.index, row });
	}
	for (const match of log.matchAll(/^([a-zA-Z][\w.-]+) (\{[^\r\n]*\})\r?$/gm)) {
		try {
			const fields = JSON.parse(match[2]!);
			if (fields && typeof fields === "object" && !Array.isArray(fields))
				parsed.push({ index: match.index, row: { ...fields, tag: match[1] } });
		} catch {
			// Only JSON is accepted; logger text is evidence, never executable code.
		}
	}
	let scannedThrough = 0;
	let sourceLine = 1;
	for (const match of log.matchAll(/^stderr: (\{[^\r\n]*\})\r?$/gm)) {
		let newline = log.indexOf("\n", scannedThrough);
		while (newline >= 0 && newline < match.index) {
			sourceLine++;
			scannedThrough = newline + 1;
			newline = log.indexOf("\n", scannedThrough);
		}
		try {
			const fields = record(JSON.parse(match[1]!));
			if (fields.event !== "job_execution_failed") continue;
			const row: EvidenceRow = { tag: "job_execution_failed", sourceLine };
			for (const key of ["taskId", "runId", "errorCode", "phase"])
				if (typeof fields[key] === "string") row[key] = fields[key];
			if (number(fields.attempt) !== null) row.attempt = fields.attempt;
			parsed.push({ index: match.index, row });
		} catch {
			// Closed stderr diagnostics are data, never executable code or retry authorization.
		}
	}
	return parsed.sort((a, b) => a.index - b.index).map(({ row }) => row);
}

function firstTimestamp(records: EvidenceRow[], predicate: (row: EvidenceRow) => boolean) {
	const timestamps = records.filter(predicate).map((row) => number(row.at));
	const known = timestamps.filter((at): at is number => at !== null);
	return known.length ? Math.min(...known) : null;
}

/** A local observed wall-time upper bound, not a CPU/I/O decomposition or SLO certification. */
export function observedRemainingWallBudget(report: EvidenceRow) {
	const observations = rows(report.observations);
	const identities = rows(report.identityMap);
	const timing = record(report.fixtureTiming);
	const job = record(report.job);
	const browser = record(report.browserTimes);
	const monotonic = record(browser.monotonic);
	const visibleWindow = interval(browser.click, browser.visible);
	const epochElapsed = duration(browser.click, browser.visible);
	const monotonicElapsed = duration(monotonic.click, monotonic.visible);
	const clockDelta =
		epochElapsed === null || monotonicElapsed === null ? null : epochElapsed - monotonicElapsed;
	// Date.now has millisecond readout resolution at both endpoints. Larger
	// discrepancies invalidate this local bound instead of silently picking a clock.
	const clockReadoutAllowanceMs = 2;
	const clockConsistent = clockDelta !== null && Math.abs(clockDelta) <= clockReadoutAllowanceMs;
	const caseIndex = number(report.caseIndex);
	const caseIdentityValid =
		caseIndex !== null &&
		Number.isSafeInteger(caseIndex) &&
		caseIndex >= 0 &&
		!!string(job.id)?.trim();
	const completed = report.outcome === "succeeded" && job.status === "SUCCEEDED";
	const selected: Array<Interval & { source: string; fixtureId: string; declaredDelayMs: number }> =
		[];
	const rejected: Array<{ source: string; fixtureId: string | null; reason: string }> = [];
	const candidates = observations.filter((row) =>
		["kie.accepted", "seeapi.submit", "waffo.start"].includes(String(row.stage)),
	);
	const sourceOf = (row: EvidenceRow) =>
		row.stage === "seeapi.submit" ? `seeapi:${String(row.role)}` : String(row.stage);
	for (const row of candidates) {
		const source = sourceOf(row);
		const fixtureId = string(row.stage === "waffo.start" ? row.requestId : row.id);
		const reject = (reason: string) => rejected.push({ source, fixtureId, reason });
		const owners = identities.filter((identity) => identity.id === fixtureId);
		if (
			!caseIdentityValid ||
			row.caseIndex !== caseIndex ||
			!fixtureId?.trim() ||
			owners.length !== 1 ||
			owners[0]!.caseIndex !== caseIndex ||
			(row.jobId !== undefined && row.jobId !== job.id)
		) {
			reject("unverified-or-conflicting-case-identity");
			continue;
		}
		if (
			candidates.filter((candidate) => sourceOf(candidate) === source).length !== 1 ||
			candidates.filter((candidate) =>
				candidate.stage === "waffo.start"
					? candidate.requestId === fixtureId
					: candidate.id === fixtureId,
			).length !== 1
		) {
			reject("ambiguous-or-repeated-fixture-processing");
			continue;
		}
		let end: unknown = row.readyAt;
		let declaredDelay =
			row.stage === "kie.accepted"
				? number(timing.generationDelayMs)
				: number(timing.reviewDelayMs);
		if (row.stage === "seeapi.submit" && !["input", "output"].includes(String(row.role))) {
			reject("unknown-review-role");
			continue;
		}
		if (row.stage === "waffo.start") {
			end = row.plannedReadyAt;
			declaredDelay = number(timing.promptReviewDelayMs);
			const ended = observations.filter(
				(candidate) =>
					candidate.stage === "waffo.end" &&
					candidate.requestId === fixtureId &&
					candidate.caseIndex === caseIndex,
			);
			if (
				timing.processingClockVersion !== 1 ||
				declaredDelay !== row.processingDelayMs ||
				ended.length !== 1 ||
				number(end) === null ||
				number(ended[0]!.at) === null ||
				Number(ended[0]!.at) < Number(end)
			) {
				reject("prompt-review-has-no-valid-declared-deadline");
				continue;
			}
		}
		const span = interval(row.at, end);
		if (
			!span ||
			declaredDelay === null ||
			declaredDelay < 0 ||
			span.end - span.start !== declaredDelay ||
			(row.processingDelayMs !== undefined && row.processingDelayMs !== declaredDelay)
		) {
			reject("invalid-or-mismatched-declared-processing-duration");
			continue;
		}
		selected.push({ ...span, source, fixtureId, declaredDelayMs: declaredDelay });
	}
	const eligible = completed && caseIdentityValid && visibleWindow !== null && clockConsistent;
	const elapsed =
		epochElapsed === null || monotonicElapsed === null
			? null
			: Math.max(epochElapsed, monotonicElapsed);
	const excludedUnion = visibleWindow ? intervalUnionMs(selected, visibleWindow) : null;
	return {
		observedRemainingWallUpperBound:
			eligible && elapsed !== null && excludedUnion !== null ? elapsed - excludedUnion : null,
		epochElapsedMs: epochElapsed,
		monotonicElapsedMs: monotonicElapsed,
		conservativeElapsedMs: elapsed,
		epochMinusMonotonicMs: clockDelta,
		clockReadoutAllowanceMs,
		clockConsistent,
		declaredFixtureProcessingUnionMs: excludedUnion,
		selectedFixtureIntervals: selected,
		rejectedFixtureIntervals: rejected,
		incompleteReasons: [
			...(!completed ? ["case-not-fully-succeeded"] : []),
			...(!caseIdentityValid ? ["missing-case-or-job-identity"] : []),
			...(!visibleWindow ? ["missing-or-reversed-click-visible-clock"] : []),
			...(!clockConsistent ? ["missing-or-inconsistent-browser-clocks"] : []),
		],
		boundary:
			"Local observed remaining wall time under the shared browser/fixture host-clock assumption; PostgreSQL timestamps are not used. Only uniquely owned declared fixture-processing deadlines are excluded, clipped and unioned per case; late timers, response delays, SQL, transfers, queues and rendering receive no additional subtraction. Concurrent I/O inside an excluded external window is not cumulative service time. Unknown processing stays in the upper bound. A value above 1000ms is inconclusive about the necessary-I/O-adjusted target; this is not cloud/full-SaaS or one-second certification.",
	};
}

export function analyzeScanlessTiming(report: EvidenceRow, log: string | readonly EvidenceRow[]) {
	const observations = rows(report.observations);
	const runtime = typeof log === "string" ? parseRuntimeEvidence(log) : [...log];
	const job = record(report.job);
	const browserTimes = record(report.browserTimes);
	const measurementTimeline = record(report.measurementTimeline);
	const monotonic = record(browserTimes.monotonic);
	const visibleWindow = interval(browserTimes.click, browserTimes.visible);
	const remainingWall = observedRemainingWallBudget(report);
	const verification = runtime.filter((row) => row.tag === "media.upload.verification");
	const outputTransfer = runtime.find(
		(row) => row.tag === "media.output.transfer" && row.jobId === job.id,
	);
	const inputAssetId =
		string(job.inputAssetId) ??
		string(observations.find((row) => row.stage === "admission.committed")?.assetId);
	const outputAssetId = string(job.outputAssetId) ?? string(outputTransfer?.assetId);
	const submissions = observations.filter((row) => row.stage === "seeapi.submit");
	const reviews = submissions.map((submission) => {
		const role = string(submission.role);
		const assetId = role === "input" ? inputAssetId : role === "output" ? outputAssetId : null;
		// The isolated harness guarantees one review submission per role. Do not
		// guess which verdict matches if a caller provides a retry/multi-job log.
		const uniqueRole = submissions.filter((row) => row.role === role).length === 1;
		const assetRows =
			assetId && uniqueRole ? verification.filter((row) => row.assetId === assetId) : [];
		const readyAt = number(submission.readyAt);
		const startedAt = firstTimestamp(assetRows, (row) => row.stage === "verification_started");
		const requestedAt = firstTimestamp(
			observations,
			(row) => row.stage === "seeapi.request" && row.id === submission.id,
		);
		const queriedAt = firstTimestamp(
			observations,
			(row) => row.stage === "seeapi.query" && row.id === submission.id && row.done === true,
		);
		const resultReceivedAt = firstTimestamp(
			assetRows,
			(row) => row.stage === "moderation_result" && row.decision === "ALLOW",
		);
		const committedAt = firstTimestamp(
			assetRows,
			(row) => row.stage === "verdict_committed" && row.status === "READY",
		);
		return {
			role,
			providerTaskId: string(submission.id),
			assetId,
			verificationStartedAt: startedAt,
			fixtureRequestStartedAt: requestedAt,
			fixtureAcceptedAt: number(submission.at),
			fixtureReadyAt: readyAt,
			firstSuccessfulAuthenticatedQueryAt: queriedAt,
			resultReceivedAt,
			verdictCommittedAt: committedAt,
			milliseconds: {
				fixtureProcessing: duration(submission.at, readyAt),
				fixtureReadyToSuccessfulQuery: duration(readyAt, queriedAt),
				fixtureReadyToResultReceived: duration(readyAt, resultReceivedAt),
				fixtureReadyToVerdictCommit: duration(readyAt, committedAt),
				resultReceivedToVerdictCommit: duration(resultReceivedAt, committedAt),
				verificationWall: duration(startedAt, committedAt),
			},
			queryCount: observations.filter(
				(row) => row.stage === "seeapi.query" && row.id === submission.id,
			).length,
			callbackResponses: observations
				.filter((row) => row.stage === "seeapi.callback.returned" && row.id === submission.id)
				.map((row) => ({
					at: number(row.at),
					status: number(row.status),
					attempt: number(row.attempt),
				})),
		};
	});
	const heavyRows = runtime.filter(
		(row) =>
			row.tag === "job.executor" && row.executor === "jobs-primary" && row.phase === "completed",
	);
	const heavy = heavyRows.map((row) => {
		const execution = interval(row.startedAt, row.completedAt);
		let held: Interval[] | null = execution ? [execution] : null;
		if (Object.hasOwn(row, "heldIntervals")) {
			held = null;
			if (Array.isArray(row.heldIntervals)) {
				const entries = rows(row.heldIntervals).map((span) =>
					interval(span.startedAt, span.completedAt),
				);
				if (
					execution &&
					entries.every(
						(span) => span !== null && span.start >= execution.start && span.end <= execution.end,
					)
				)
					held = entries as Interval[];
			}
		}
		const heldMs =
			held === null ? null : held.reduce((total, span) => total + span.end - span.start, 0);
		return {
			taskId: string(row.taskId),
			runId: string(row.runId),
			startedAt: number(row.startedAt),
			completedAt: number(row.completedAt),
			executionWallMs: duration(row.startedAt, row.completedAt),
			wallMs: heldMs,
			heldIntervals: held,
			reportedResourceHeldMs: number(row.resourceHeldMs),
			intervalSource: Object.hasOwn(row, "heldIntervals") ? "explicit-holds" : "executor-envelope",
			capacityWaitMs: number(row.capacityWaitMs),
			outcome: string(row.outcome),
		};
	});
	const heavySpans = heavy.flatMap((row) => row.heldIntervals ?? []);
	const transferRows = runtime.filter(
		(row) =>
			row.tag === "job.executor" &&
			row.executor === "jobs-transfer-request" &&
			row.phase === "completed",
	);
	// A complete stateless transfer trace demonstrates a path with no observed
	// heavy invocation. Missing all executor traces cannot be called zero cost.
	const heavyComplete =
		(heavy.length > 0 ||
			(transferRows.length > 0 &&
				transferRows.every(
					(row) => row.outcome === "ok" && interval(row.startedAt, row.completedAt) !== null,
				))) &&
		heavy.every((row) => row.heldIntervals !== null);
	const reviewSpans = reviews
		.map((review) => interval(review.verificationStartedAt, review.verdictCommittedAt))
		.filter((span): span is Interval => span !== null);
	const reviewsComplete = reviews.length === 2 && reviewSpans.length === 2;
	const externalFixtureSpans: Array<Interval & { source: string }> = [];
	for (const row of observations) {
		if (row.stage === "kie.accepted" || row.stage === "seeapi.submit") {
			const span = interval(row.at, row.readyAt);
			if (span)
				externalFixtureSpans.push({
					...span,
					source: `${row.stage}:${string(row.role) ?? string(row.id) ?? "unknown"}`,
				});
		}
		if (row.stage === "waffo.start") {
			const end = observations.find(
				(candidate) =>
					candidate.stage === "waffo.end" &&
					Number(candidate.at) >= Number(row.at) &&
					(row.requestId === undefined || candidate.requestId === row.requestId),
			);
			const span = interval(row.at, end?.at);
			if (span) externalFixtureSpans.push({ ...span, source: "waffo" });
		}
	}
	const readyAt = reviews.find((review) => review.role === "output")?.verdictCommittedAt ?? null;
	const browserNotifications = rows(browserTimes.notifications);
	const readyNotifications = browserNotifications.filter(
		(row) =>
			row.type === "job-updated" &&
			row.jobId === job.id &&
			typeof row.version === "string" &&
			outputAssetId !== null &&
			row.version.startsWith(`asset:${outputAssetId}:`) &&
			row.version.endsWith(":ready"),
	);
	const notificationAt = readyNotifications.length
		? Math.min(...readyNotifications.map((row) => number(row.receivedAt) ?? Infinity))
		: null;
	const storage = observations.filter((row) => row.stage === "storage.http");
	const sqlRows = runtime.filter((row) => row.tag === "media.database.query");
	const requestSqlCount = sqlRows.filter((row) =>
		string(row.clientScope)?.startsWith("request:"),
	).length;
	const nodeSqlCount = sqlRows.filter((row) => string(row.clientScope)?.startsWith("node:")).length;
	const visibleSql = visibleWindow
		? sqlRows.filter((row) => {
				const span = interval(row.startedAt, row.completedAt);
				return span !== null && span.start <= visibleWindow.end && span.end >= visibleWindow.start;
			})
		: [];
	const sqlSpans = visibleSql
		.map((row) => interval(row.startedAt, row.completedAt))
		.filter((span): span is Interval => span !== null);
	const requestCounts: Record<string, number> = {};
	const settlementCompleted = runtime
		.filter(
			(row) =>
				row.tag === "job.executor" &&
				row.phase === "completed" &&
				row.taskId === "media-settle-generation" &&
				row.outcome === "ok",
		)
		.map((row) => number(row.completedAt))
		.filter((at): at is number => at !== null);
	const settlementCompletedAt = settlementCompleted.length
		? Math.min(...settlementCompleted)
		: null;
	for (const row of storage) {
		const method = string(row.method) ?? "unknown";
		requestCounts[method] = (requestCounts[method] ?? 0) + 1;
	}
	return {
		label: string(report.label),
		artifactSha256: string(report.artifactSha256),
		harnessSources: report.harnessSources ?? null,
		sqlMetricsFormat: string(report.sqlMetricsFormat),
		storageFreshReadEnabled: boolean(report.storageFreshReadEnabled),
		loginBonusReadCommittedEnabled: boolean(report.loginBonusReadCommittedEnabled),
		settlementFreshReadEnabled: boolean(report.settlementFreshReadEnabled),
		jobId: string(job.id),
		measurementModes: record(report.measurementModes),
		measurementTimeline,
		preClickReview: report.preClickReview ?? null,
		functionalEvidence: {
			jobStatus: string(job.status),
			generationAttempts: number(job.attempts),
			providerSubmissions: observations.filter((row) => row.stage === "kie.accepted").length,
			inputReviewSubmissions: submissions.filter((row) => row.role === "input").length,
			outputReviewSubmissions: submissions.filter((row) => row.role === "output").length,
			reserveEntries: rows(report.ledger).filter((row) => row.type === "RESERVE").length,
			settleEntries: rows(report.ledger).filter((row) => row.type === "SETTLE").length,
			globalScannerTaskEntries: runtime.some((row) => row.tag === "media.task.started")
				? runtime.filter(
						(row) => row.tag === "media.task.started" && row.taskId === "media-deliver-outbox",
					).length
				: null,
		},
		outputFixture: report.outputFixture ?? null,
		browser: report.browser ?? { mode: "minimal-preview-polling", isFullSaasUi: false },
		boundary: report.cohortSize
			? "Explicitly ID-correlated job within one concurrent local workerd/PostgreSQL/MinIO cohort; supplier fixtures and minimal browser, not cloud/full-SaaS certification."
			: "Single-job local workerd/PostgreSQL/MinIO evidence; external suppliers are fixtures. Browser/fixture/runtime observations use the local host clock; PostgreSQL-produced timestamps have no established clock alignment. No cloud or full-SaaS certification.",
		milliseconds: {
			clickToVisible: duration(browserTimes.click, browserTimes.visible),
			preparationToVisible: number(measurementTimeline.preparationToVisibleMs),
			uploadToVisible: number(measurementTimeline.uploadToVisibleMs),
			uploadToClick: number(measurementTimeline.uploadToClickMs),
			clickToAdmissionRequestReceived: duration(
				browserTimes.click,
				firstTimestamp(observations, (row) => row.stage === "click"),
			),
			clickToAdmissionReturned: duration(
				browserTimes.click,
				firstTimestamp(observations, (row) => row.stage === "admission.returned"),
			),
			clickToSettlementExecutorCompleted: duration(browserTimes.click, settlementCompletedAt),
			clickToVisibleMonotonic: duration(monotonic.click, monotonic.visible),
			readyCommitToBrowserReceived: duration(readyAt, browserTimes.received),
			readyCommitToBrowserNotification: duration(readyAt, notificationAt),
			browserNotificationToStateReceived: duration(notificationAt, browserTimes.received),
			browserReceivedToDecoded: duration(browserTimes.received, browserTimes.decoded),
			browserDecodedToVisible: duration(browserTimes.decoded, browserTimes.visible),
			heavyWallTotal: heavyComplete ? heavy.reduce((total, row) => total + row.wallMs!, 0) : null,
			heavyWallUnion: heavyComplete ? intervalUnionMs(heavySpans) : null,
			reviewHeavyOverlap:
				heavyComplete && reviewsComplete ? intervalIntersectionMs(heavySpans, reviewSpans) : null,
			externalFixtureProcessingUnionWithinVisibleWindow:
				visibleWindow && externalFixtureSpans.length
					? intervalUnionMs(externalFixtureSpans, visibleWindow)
					: null,
			observedRemainingWallUpperBound: remainingWall.observedRemainingWallUpperBound,
			necessaryDatabaseIo: null,
			necessaryNetworkIo: null,
			controllableOverhead: null,
		},
		observedRemainingWallEvidence: remainingWall,
		heavyExecutions: heavy,
		settlementExecutorCompletedAt: settlementCompletedAt,
		executors: executorEvidence(runtime),
		browserApiResources: rows(browserTimes.apiResources).map((row) => ({
			path: string(row.path),
			epochStart: number(row.epochStart),
			durationMs: number(row.duration),
			fetchToRequestStartMs: duration(row.fetchStart, row.requestStart),
			connectionMs: duration(row.connectStart, row.connectEnd),
			requestToResponseStartMs: duration(row.requestStart, row.responseStart),
			responseBodyMs: duration(row.responseStart, row.responseEnd),
			nextHopProtocol: string(row.nextHopProtocol),
		})),
		handoffs: runtime
			.filter((row) => row.tag === "media.task.started" && number(row.dueAt) !== null)
			.map((row) => ({
				taskId: string(row.taskId),
				outboxEventId: string(row.outboxEventId),
				dueAt: number(row.dueAt),
				startedAt: number(row.startedAt),
				dueToStartMs: null,
				unverifiedReportedDueToStartMs: number(row.dueToStartMs),
				clockAlignment: "unverified",
				boundary:
					"Outbox due/originalDue timestamps can use PostgreSQL time while task start uses the runtime host clock. Their difference is diagnostic raw data, not scheduling latency; no fixed-offset correction is applied.",
			})),
		browserNotifications,
		database: {
			totalObservedQueryCount: sqlRows.length || null,
			requestClientEvents: requestSqlCount,
			nodeClientEvents: nodeSqlCount,
			queriesTouchingVisibleWindow: visibleWindow && sqlRows.length ? visibleSql.length : null,
			queryDurationSumMs:
				visibleSql.length && visibleSql.every((row) => number(row.durationMs) !== null)
					? visibleSql.reduce((total, row) => total + number(row.durationMs)!, 0)
					: null,
			querySpanUnionWithinVisibleWindowMs:
				visibleWindow && sqlSpans.length ? intervalUnionMs(sqlSpans, visibleWindow) : null,
			queries: visibleSql.map((row) => ({
				startedAt: number(row.startedAt),
				completedAt: number(row.completedAt),
				durationMs: number(row.durationMs),
				clientScope: string(row.clientScope),
				runId: string(row.runId),
				taskId: string(row.taskId),
				jobId: string(row.jobId),
				assetId: string(row.assetId),
			})),
			boundary:
				"Observed Prisma client query events, not every database command (BEGIN/COMMIT may be absent). No SQL or parameters. Durations include client/driver effects, can overlap, and are not proven necessary database service or transport time.",
		},
		reviews,
		externalFixtureIntervals: externalFixtureSpans,
		transfer: {
			outputBytes: number(report.outputBytes),
			sourceDownloadRequests: number(report.sourceDownloadRequests),
			workerStorageRequestCounts: requestCounts,
			supplierDownloads: observations
				.filter((row) =>
					[
						"supplier.output.download",
						"supplier.review.asset_download",
						"supplier.generation.asset_download",
					].includes(string(row.stage) ?? ""),
				)
				.map((row) => ({
					stage: string(row.stage),
					role: string(row.role),
					responseBytes: number(row.responseBytes),
					at: number(row.at),
				})),
			workerStorageSpans: storage.map((row) => ({
				method: string(row.method),
				startedAt: number(row.startedAt),
				headersAt: number(row.headersAt),
				requestToHeadersMs: duration(row.startedAt, row.headersAt),
				responseContentLength: row.responseContentLength ?? null,
				requestBodyBytes: number(row.requestBodyBytes),
			})),
		},
		oneSecondCertified: false,
		missingEvidence: [
			...(requestSqlCount === 0
				? [
						"No Worker request-client SQL events; present SQL totals do not cover runtime database calls.",
					]
				: []),
			...(!heavyComplete ? ["Explicit start/end timestamps for every heavy execution."] : []),
			...(!reviewsComplete
				? ["Explicit review start and committed verdict timestamps for both assets."]
				: []),
			"Necessary database service/transport time separated from redundant work, connection and lock waits.",
			"Necessary network transfer time separated from bridge buffering, server work and repeated requests.",
			"Actual full SaaS notification/decode/render and representative cloud/load/peak-memory samples.",
		],
		limitations: [
			"Observed asset updatedAt is deliberately not used as the READY commit timestamp.",
			"Outbox due-to-start differences are unmeasured without clock alignment, including positive reported differences; PostgreSQL and runtime clocks may vary independently.",
			"Review overlap covers verification start through evidence commit, including provider wait; missing spans stay null.",
			report.cohortSize
				? "Per-job runtime rows are attributed by explicit IDs or an unambiguous runId; unassigned SQL stays in the cohort totals."
				: "Heavy totals cover all jobs-primary completed events in this isolated single-job log; use the cohort analyzer for concurrent-job logs.",
			"Explicit heldIntervals take precedence over executor envelopes; suspended/header/resume waits are not automatically exempted from the end-to-end budget.",
			"Fixture interval union is descriptive only; it is not a critical-path or unavoidable-I/O deduction.",
			"The legacy descriptive fixture union includes the actual prompt response envelope; the new remaining-wall upper bound uses only validated declared deadlines and never that envelope.",
			"Storage bridge spans end at response headers and include local transport effects; they do not measure complete transfer or cloud memory.",
		],
	};
}

function executorEvidence(runtime: readonly EvidenceRow[]) {
	const completed = runtime.filter(
		(row) => row.tag === "job.executor" && row.phase === "completed",
	);
	return [...new Set(completed.map((row) => string(row.executor) ?? "unknown"))]
		.sort()
		.map((executor) => {
			const entries = completed.filter((row) => (string(row.executor) ?? "unknown") === executor);
			const spans = entries
				.map((row) => interval(row.startedAt, row.completedAt))
				.filter((span): span is Interval => span !== null);
			const waits = entries
				.map((row) => number(row.capacityWaitMs))
				.filter((value): value is number => value !== null);
			return {
				executor,
				completedCount: entries.length,
				completeIntervalCount: spans.length,
				peakActive: spans.length ? peakConcurrentIntervals(spans) : null,
				wallMs: sampleStatistics(spans.map((span) => span.end - span.start)),
				capacityWaitMs: sampleStatistics(waits),
				executions: entries.map((row) => ({
					taskId: string(row.taskId),
					runId: string(row.runId),
					startedAt: number(row.startedAt),
					completedAt: number(row.completedAt),
					capacityWaitMs: number(row.capacityWaitMs),
					outcome: string(row.outcome),
				})),
			};
		});
}

/** Only explicit identity relationships are admissible; clock overlap is never identity. */
export function attributeConcurrentRuntime(report: EvidenceRow, runtime: readonly EvidenceRow[]) {
	const identityCases = new Map<string, Set<number>>();
	const add = (id: unknown, caseIndex: number) => {
		if (typeof id !== "string" || !id) return false;
		const assigned = identityCases.get(id) ?? new Set<number>();
		const before = assigned.size;
		assigned.add(caseIndex);
		identityCases.set(id, assigned);
		return before !== assigned.size;
	};
	const fields = ["jobId", "assetId", "attemptId", "outboxEventId", "requestId", "ownerId"];
	for (const item of rows(report.cases)) {
		const caseIndex = number(item.caseIndex);
		if (caseIndex === null) continue;
		const job = record(item.job);
		for (const id of [item.ownerId, job.id, job.inputAssetId, job.outputAssetId])
			add(id, caseIndex);
		if (Array.isArray(job.attemptIds)) for (const id of job.attemptIds) add(id, caseIndex);
		for (const notification of rows(record(item.notifications).events))
			add(notification.id, caseIndex);
	}
	for (const identity of rows(report.identityMap)) {
		const caseIndex = number(identity.caseIndex);
		if (caseIndex !== null) add(identity.id, caseIndex);
	}
	const direct = (row: EvidenceRow) =>
		new Set(
			fields.flatMap((key) =>
				typeof row[key] === "string" ? [...(identityCases.get(row[key] as string) ?? [])] : [],
			),
		);
	// Rows that carry both a known job and a newly created asset/event introduce
	// exact edges. Fixed point propagation also detects conflicting identities.
	for (let pass = 0; pass <= runtime.length; pass++) {
		let changed = false;
		for (const row of runtime) {
			const candidates = direct(row);
			if (candidates.size === 1)
				for (const field of fields) changed = add(row[field], [...candidates][0]!) || changed;
		}
		if (!changed) break;
	}
	const runCases = new Map<string, Set<number>>();
	for (const row of runtime) {
		const runId = string(row.runId);
		if (runId === null) continue;
		const known = runCases.get(runId) ?? new Set<number>();
		for (const candidate of direct(row)) known.add(candidate);
		runCases.set(runId, known);
	}
	// A wake may resume a singleton event that another run has already handled.
	// That continuation then logs only prepare/SQL/completion, without a child
	// carrying a job ID. Reconstruct only the exact no-deadline singleton identity
	// emitted by apps/workflows/src/wake.ts; no clocks or arbitrary report IDs.
	const completedWakeParents = new Set(
		runtime
			.filter(
				(row) =>
					row.tag === "job.executor" &&
					row.phase === "completed" &&
					row.outcome === "ok" &&
					["media-verify-upload", "media-poll-generation"].includes(String(row.taskId)),
			)
			.map((row) => `${String(row.runId)}:${String(row.taskId)}`),
	);
	const prepareRuns = new Set(
		runtime
			.filter((row) => row.tag === "media.task.started" && row.taskId === "media-prepare-event")
			.map((row) => string(row.runId))
			.filter((id): id is string => id !== null),
	);
	const eventCases = new Map<string, number>();
	const observedEventCases = new Map<string, Set<number>>();
	const parentCases = new Map<string, number>();
	for (const row of runtime) {
		if (row.tag !== "media.task.started") continue;
		const cases = direct(row);
		const eventId = string(row.outboxEventId);
		if (eventId) {
			const observed = observedEventCases.get(eventId) ?? new Set<number>();
			for (const owner of cases) observed.add(owner);
			observedEventCases.set(eventId, observed);
		}
		if (cases.size !== 1) continue;
		const caseIndex = [...cases][0]!;
		const runId = string(row.runId);
		if (
			runId &&
			/^job-[a-f0-9]{64}$/.test(runId) &&
			runCases.get(runId)?.size === 1 &&
			completedWakeParents.has(`${runId}:${String(row.taskId)}`)
		)
			parentCases.set(runId, caseIndex);
	}
	for (const [eventId, cases] of observedEventCases)
		if (cases.size === 1 && identityCases.get(eventId)?.size === 1)
			eventCases.set(eventId, [...cases][0]!);
	type WakeProof = {
		caseIndex: number;
		wakeContinuation: string;
		request: { taskId: "media-deliver-events"; payload: { eventIds: [string] } };
	};
	const wakeProofs = new Map<string, WakeProof[]>();
	for (const [parentRunId, caseIndex] of parentCases) {
		for (const [eventId, eventCase] of eventCases) {
			if (eventCase !== caseIndex) continue;
			// Field order is part of this historical JSON/SHA-256 contract. Do not
			// sort fields, infer notBefore, or expand an unobserved event set.
			const input = {
				wakeContinuation: parentRunId,
				request: {
					taskId: "media-deliver-events" as const,
					payload: { eventIds: [eventId] as [string] },
				},
			};
			const runId = `job-${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
			if (!prepareRuns.has(runId)) continue;
			const proofs = wakeProofs.get(runId) ?? [];
			proofs.push({ caseIndex, ...input });
			wakeProofs.set(runId, proofs);
		}
	}
	return runtime.map((row) => {
		const known = direct(row);
		const runId = string(row.runId);
		const viaRun = runId === null ? new Set<number>() : (runCases.get(runId) ?? new Set<number>());
		const proofs = runId === null ? [] : (wakeProofs.get(runId) ?? []);
		const derived = new Set([...viaRun, ...proofs.map((proof) => proof.caseIndex)]);
		// Shared runs never override a more precise directly supplied identity.
		const candidates = known.size ? known : derived;
		const exactWake = !known.size && !viaRun.size && candidates.size === 1 && proofs.length === 1;
		return {
			row,
			caseIndex: candidates.size === 1 ? [...candidates][0]! : null,
			...(exactWake ? { wakeContinuationEvidence: proofs[0]! } : {}),
			attribution:
				candidates.size > 1
					? "ambiguous"
					: candidates.size === 0
						? "unassigned"
						: known.size
							? "explicit-id"
							: exactWake
								? "deterministic-wake-continuation"
								: "unambiguous-run-id",
		};
	});
}

export function analyzeConcurrentScanlessTiming(report: EvidenceRow, log: string) {
	const expectedCount = number(report.concurrency);
	if (expectedCount === null || !Number.isSafeInteger(expectedCount) || expectedCount < 1)
		throw new Error("MISSING_CONCURRENT_DENOMINATOR");
	const runtime = parseRuntimeEvidence(log);
	const attributed = attributeConcurrentRuntime(report, runtime);
	const inputCases = rows(report.cases);
	const cases = Array.from({ length: expectedCount }, (_, caseIndex) => {
		const matches = inputCases.filter((item) => item.caseIndex === caseIndex);
		if (matches.length > 1) throw new Error("DUPLICATE_CASE_INDEX");
		const item = matches[0];
		const outcome: "succeeded" | "failed" | "timeout" | "missing" =
			item?.outcome === "succeeded" || item?.outcome === "failed" || item?.outcome === "timeout"
				? item.outcome
				: "missing";
		const evidence = analyzeScanlessTiming(
			{
				label: `${string(report.label) ?? "cohort"}:case-${caseIndex}`,
				artifactSha256: report.artifactSha256,
				harnessSources: report.harnessSources,
				sqlMetricsFormat: report.sqlMetricsFormat,
				outputFixture: report.outputFixture,
				outputBytes: report.outputBytes,
				browser: report.browser,
				...item,
				caseIndex,
				outcome,
				identityMap: report.identityMap,
				fixtureTiming: report.fixtureTiming,
				storageFreshReadEnabled: report.storageFreshReadEnabled,
				loginBonusReadCommittedEnabled: report.loginBonusReadCommittedEnabled,
				settlementFreshReadEnabled: report.settlementFreshReadEnabled,
				cohortSize: expectedCount,
			},
			attributed.filter((entry) => entry.caseIndex === caseIndex).map((entry) => entry.row),
		);
		return {
			caseIndex,
			outcome,
			errors: item?.errors ?? [],
			browserTimes: record(item?.browserTimes),
			...evidence,
		};
	});
	const summary = {
		...summarizeConcurrentCases(expectedCount, cases),
		storageFreshReadEnabled: boolean(report.storageFreshReadEnabled),
		loginBonusReadCommittedEnabled: boolean(report.loginBonusReadCommittedEnabled),
		settlementFreshReadEnabled: boolean(report.settlementFreshReadEnabled),
	};
	const unfinishedJobSpans = cases
		.map((item) =>
			interval(
				item.browserTimes.click,
				item.settlementExecutorCompletedAt ?? item.browserTimes.endedAt,
			),
		)
		.filter((span): span is Interval => span !== null);
	const sql = attributed.filter((entry) => entry.row.tag === "media.database.query");
	const sqlDiagnosticsAvailable =
		report.sqlMetricsEnabled === true || (report.sqlMetricsEnabled !== false && sql.length > 0);
	const observedSql = (value: number) => (sqlDiagnosticsAvailable ? value : null);
	const sqlSpans = sql
		.map(({ row }) => interval(row.startedAt, row.completedAt))
		.filter((span): span is Interval => span !== null);
	const unassigned = attributed.filter((entry) => entry.caseIndex === null);
	const metric = (key: keyof ReturnType<typeof analyzeScanlessTiming>["milliseconds"]) =>
		sampleStatistics(
			cases
				.map((item) => item.milliseconds[key])
				.filter((value): value is number => value !== null),
		);
	return {
		label: string(report.label),
		artifactSha256: string(report.artifactSha256),
		harnessSources: report.harnessSources ?? null,
		sqlMetricsFormat: string(report.sqlMetricsFormat),
		storageFreshReadEnabled: boolean(report.storageFreshReadEnabled),
		loginBonusReadCommittedEnabled: boolean(report.loginBonusReadCommittedEnabled),
		settlementFreshReadEnabled: boolean(report.settlementFreshReadEnabled),
		boundary:
			"One shared local runtime/database/executor namespace; independent users in one Chromium. All expected users remain in the denominator. Supplier timings are fixtures; this is not cloud/full-SaaS proof.",
		summary,
		jobConcurrency: {
			peakActiveUntilSettlementOrFailure: unfinishedJobSpans.length
				? peakConcurrentIntervals(unfinishedJobSpans)
				: null,
			intervalCount: unfinishedJobSpans.length,
			expectedCount,
			boundary:
				"Click through successful settlement executor completion, or observed failure/timeout. Missing terminal traces remain unknown.",
		},
		milliseconds: {
			clickToVisible: metric("clickToVisible"),
			preparationToVisible: metric("preparationToVisible"),
			uploadToVisible: metric("uploadToVisible"),
			uploadToClick: metric("uploadToClick"),
			observedRemainingWallUpperBound: metric("observedRemainingWallUpperBound"),
			clickToAdmissionRequestReceived: metric("clickToAdmissionRequestReceived"),
			clickToAdmissionReturned: metric("clickToAdmissionReturned"),
			clickToSettlementExecutorCompleted: metric("clickToSettlementExecutorCompleted"),
			readyCommitToBrowserReceived: metric("readyCommitToBrowserReceived"),
			readyCommitToBrowserNotification: metric("readyCommitToBrowserNotification"),
			heavyWallTotal: metric("heavyWallTotal"),
			reviewHeavyOverlap: metric("reviewHeavyOverlap"),
			reviewReadyToVerdictCommit: sampleStatistics(
				cases
					.flatMap((item) =>
						item.reviews.map((review) => review.milliseconds.fixtureReadyToVerdictCommit),
					)
					.filter((value): value is number => value !== null),
			),
			necessaryDatabaseIo: null,
			necessaryNetworkIo: null,
			controllableOverhead: null,
		},
		observedRemainingWallCoverage: {
			expectedCount,
			measuredCount: cases.filter(
				(item) => item.milliseconds.observedRemainingWallUpperBound !== null,
			).length,
			unmeasuredCount: cases.filter(
				(item) => item.milliseconds.observedRemainingWallUpperBound === null,
			).length,
			withinOneSecondCount: cases.filter(
				(item) =>
					item.milliseconds.observedRemainingWallUpperBound !== null &&
					item.milliseconds.observedRemainingWallUpperBound <= 1000,
			).length,
			aboveOneSecondUpperBoundCount: cases.filter(
				(item) =>
					item.milliseconds.observedRemainingWallUpperBound !== null &&
					item.milliseconds.observedRemainingWallUpperBound > 1000,
			).length,
			boundary:
				"All expected cases remain in summary and cases. Unfinished or clock-inconsistent cases have no successful finite upper bound. Above-threshold upper bounds are inconclusive, not automatic controllable-overhead failures.",
		},
		executors: executorEvidence(runtime),
		globalScannerTaskEntries: runtime.filter(
			(row) => row.tag === "media.task.started" && row.taskId === "media-deliver-outbox",
		).length,
		database: {
			diagnosticsAvailable: sqlDiagnosticsAvailable,
			totalObservedQueryCount: observedSql(sql.length),
			assignedQueryCount: observedSql(sql.filter((entry) => entry.caseIndex !== null).length),
			unassignedQueryCount: observedSql(sql.filter((entry) => entry.caseIndex === null).length),
			ambiguousQueryCount: observedSql(
				sql.filter((entry) => entry.attribution === "ambiguous").length,
			),
			requestClientEvents: observedSql(
				sql.filter(({ row }) => string(row.clientScope)?.startsWith("request:")).length,
			),
			nodeClientEvents: observedSql(
				sql.filter(({ row }) => string(row.clientScope)?.startsWith("node:")).length,
			),
			queryDurationSumMs: observedSql(
				sql.reduce((sum, { row }) => sum + (number(row.durationMs) ?? 0), 0),
			),
			querySpanUnionMs: observedSql(intervalUnionMs(sqlSpans)),
			boundary:
				"Aggregate includes setup/inspection events; per-case rows include only explicit ID/run correlations. Disabled or absent SQL diagnostics remain unknown, not zero. Shared Node events remain unassigned. SQL spans are observed client times, never unavoidable-I/O deductions.",
		},
		attribution: {
			assignedRows: attributed.length - unassigned.length,
			unassignedRows: unassigned.length,
			ambiguousRows: unassigned.filter((entry) => entry.attribution === "ambiguous").length,
			unassignedExecutorCompletions: unassigned.filter(
				({ row }) => row.tag === "job.executor" && row.phase === "completed",
			).length,
		},
		cases,
		oneSecondCertified: false,
		missingEvidence: [
			"Necessary database/transport time separated from redundant queries, connection setup and lock waiting.",
			"Full SaaS UI, representative cloud load, peak memory and timing proof remain separate from this fixed-supplier local cohort.",
			...(sql.some((entry) => entry.caseIndex === null)
				? [
						"Not all SQL events have safe per-job identity; no timestamp-based attribution was applied.",
					]
				: []),
		],
	};
}
