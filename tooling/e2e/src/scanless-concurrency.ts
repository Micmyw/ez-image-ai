/** Pure report accounting. Missing/failed/timed-out users never disappear. */
export type ConcurrentCase = {
	caseIndex: number;
	outcome: "succeeded" | "failed" | "timeout" | "missing";
	browserTimes?: Record<string, unknown>;
	measurementTimeline?: Record<string, unknown>;
};

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function sampleStatistics(values: readonly number[]) {
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
	const percentile = (fraction: number) =>
		sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]! : null;
	return {
		sampleCount: sorted.length,
		min: sorted[0] ?? null,
		max: sorted.at(-1) ?? null,
		p50: percentile(0.5),
		p95: percentile(0.95),
		p99: percentile(0.99),
	};
}

/** End is exclusive; adjacent tasks do not count as concurrent. */
export function peakConcurrentIntervals(intervals: readonly { start: number; end: number }[]) {
	const edges = intervals.flatMap(({ start, end }) => {
		if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
			throw new Error("INVALID_CONCURRENCY_INTERVAL");
		return end === start
			? []
			: [
					{ at: start, change: 1 },
					{ at: end, change: -1 },
				];
	});
	edges.sort((a, b) => a.at - b.at || a.change - b.change);
	let active = 0;
	let peak = 0;
	for (const edge of edges) {
		active += edge.change;
		peak = Math.max(peak, active);
	}
	return peak;
}

export function summarizeConcurrentCases(expectedCount: number, cases: readonly ConcurrentCase[]) {
	if (!Number.isSafeInteger(expectedCount) || expectedCount < 1)
		throw new Error("INVALID_EXPECTED_CASE_COUNT");
	const indexed = new Map<number, ConcurrentCase>();
	for (const item of cases) {
		if (
			!Number.isSafeInteger(item.caseIndex) ||
			item.caseIndex < 0 ||
			item.caseIndex >= expectedCount
		)
			throw new Error("CASE_INDEX_OUTSIDE_DENOMINATOR");
		if (indexed.has(item.caseIndex)) throw new Error("DUPLICATE_CASE_INDEX");
		indexed.set(item.caseIndex, item);
	}
	const complete = Array.from(
		{ length: expectedCount },
		(_, caseIndex) => indexed.get(caseIndex) ?? { caseIndex, outcome: "missing" as const },
	);
	const clicks = complete
		.map((item) => finite(item.browserTimes?.click))
		.filter((value): value is number => value !== null);
	const spans = complete
		.map((item) => {
			const start = finite(item.browserTimes?.click);
			const end = finite(item.browserTimes?.visible) ?? finite(item.browserTimes?.endedAt);
			return start !== null && end !== null && end >= start ? { start, end } : null;
		})
		.filter((span): span is { start: number; end: number } => span !== null);
	const visible = complete
		.map((item) => {
			const start = finite(item.browserTimes?.click);
			const end = finite(item.browserTimes?.visible);
			return start !== null && end !== null && end >= start ? end - start : null;
		})
		.filter((value): value is number => value !== null);
	const timelineMetric = (name: string) =>
		sampleStatistics(
			complete
				.map((item) => finite(item.measurementTimeline?.[name]))
				.filter((value): value is number => value !== null),
		);
	return {
		expectedCount,
		observedCount: indexed.size,
		succeeded: complete.filter((item) => item.outcome === "succeeded").length,
		failed: complete.filter((item) => item.outcome === "failed").length,
		timedOut: complete.filter((item) => item.outcome === "timeout").length,
		missing: complete.filter((item) => item.outcome === "missing").length,
		allSucceeded: complete.every((item) => item.outcome === "succeeded"),
		clickCount: clicks.length,
		submissionStartSpreadMs: clicks.length ? Math.max(...clicks) - Math.min(...clicks) : null,
		peakActiveBeforeVisibleOrFailure: spans.length ? peakConcurrentIntervals(spans) : null,
		clickToVisibleMs: sampleStatistics(visible),
		preparationToVisibleMs: timelineMetric("preparationToVisibleMs"),
		uploadToVisibleMs: timelineMetric("uploadToVisibleMs"),
		uploadToClickMs: timelineMetric("uploadToClickMs"),
		cases: complete.map((item) => ({ caseIndex: item.caseIndex, outcome: item.outcome })),
		oneSecondCertified: false,
	};
}
