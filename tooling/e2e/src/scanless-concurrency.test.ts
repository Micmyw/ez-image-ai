import assert from "node:assert/strict";
import test from "node:test";

import { peakConcurrentIntervals, summarizeConcurrentCases } from "./scanless-concurrency";

void test("all 50 remain in denominator including failure, timeout and absent record", () => {
	const summary = summarizeConcurrentCases(50, [
		{ caseIndex: 0, outcome: "succeeded", browserTimes: { click: 10, visible: 100 } },
		{ caseIndex: 1, outcome: "failed", browserTimes: { click: 11, endedAt: 90 } },
		{ caseIndex: 2, outcome: "timeout", browserTimes: { click: 12, endedAt: 200 } },
	]);
	assert.equal(summary.expectedCount, 50);
	assert.equal(summary.observedCount, 3);
	assert.equal(summary.succeeded, 1);
	assert.equal(summary.failed, 1);
	assert.equal(summary.timedOut, 1);
	assert.equal(summary.missing, 47);
	assert.equal(summary.cases.length, 50);
	assert.equal(summary.allSucceeded, false);
	assert.equal(summary.oneSecondCertified, false);
	assert.equal(summary.submissionStartSpreadMs, 2);
	assert.equal(summary.peakActiveBeforeVisibleOrFailure, 3);
	assert.equal(summary.clickToVisibleMs.sampleCount, 1);
});

void test("50 sequential successes do not masquerade as concurrent load", () => {
	const summary = summarizeConcurrentCases(
		50,
		Array.from({ length: 50 }, (_, caseIndex) => ({
			caseIndex,
			outcome: "succeeded" as const,
			browserTimes: { click: caseIndex * 100, visible: (caseIndex + 1) * 100 },
		})),
	);
	assert.equal(summary.allSucceeded, true);
	assert.equal(summary.peakActiveBeforeVisibleOrFailure, 1);
	assert.equal(summary.submissionStartSpreadMs, 4900);
	assert.equal(summary.clickToVisibleMs.max, 100);
});

void test("full concurrent cohort preserves slowest and visible accounting failures", () => {
	const summary = summarizeConcurrentCases(
		50,
		Array.from({ length: 50 }, (_, caseIndex) => ({
			caseIndex,
			outcome: caseIndex === 49 ? ("failed" as const) : ("succeeded" as const),
			browserTimes: { click: caseIndex, visible: 1000 + caseIndex * 2 },
		})),
	);
	assert.equal(summary.peakActiveBeforeVisibleOrFailure, 50);
	assert.equal(summary.clickToVisibleMs.sampleCount, 50);
	assert.equal(summary.clickToVisibleMs.max, 1049);
	assert.equal(summary.failed, 1);
	assert.equal(summary.allSucceeded, false);
});

void test("duplicates and invalid indexes cannot inflate denominator", () => {
	assert.throws(
		() =>
			summarizeConcurrentCases(1, [
				{ caseIndex: 0, outcome: "succeeded" },
				{ caseIndex: 0, outcome: "failed" },
			]),
		/DUPLICATE/,
	);
	assert.throws(
		() => summarizeConcurrentCases(1, [{ caseIndex: 1, outcome: "failed" }]),
		/OUTSIDE/,
	);
	assert.throws(() => peakConcurrentIntervals([{ start: 5, end: 4 }]), /INVALID/);
});

void test("pre-click upload and review costs stay beside click latency without inventing missing totals", () => {
	const summary = summarizeConcurrentCases(2, [
		{
			caseIndex: 0,
			outcome: "succeeded",
			browserTimes: { click: 4000, visible: 5000 },
			measurementTimeline: {
				uploadToClickMs: 3900,
				uploadToVisibleMs: 4900,
				preparationToVisibleMs: 4900,
			},
		},
	]);
	assert.equal(summary.clickToVisibleMs.p50, 1000);
	assert.equal(summary.uploadToVisibleMs.p50, 4900);
	assert.equal(summary.preparationToVisibleMs.p50, 4900);
	assert.equal(summary.uploadToClickMs.p50, 3900);
	assert.equal(summary.uploadToVisibleMs.sampleCount, 1);
	assert.equal(summary.missing, 1);
});
