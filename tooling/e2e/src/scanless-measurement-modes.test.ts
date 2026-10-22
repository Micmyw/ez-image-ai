import assert from "node:assert/strict";
import test from "node:test";

import {
	createScanlessRequestDefer,
	resolveScanlessMeasurementModes,
	scanlessMeasurementTimeline,
} from "./scanless-measurement-modes";

void test("default mode retains the original await-dispatch and submit-time baseline", () => {
	assert.deepEqual(resolveScanlessMeasurementModes({}), {
		admissionDispatchMode: "await-dispatch",
		inputReviewMode: "submit-time",
	});
	assert.throws(() => resolveScanlessMeasurementModes({ admissionDispatchMode: "later" }));
	assert.throws(() => resolveScanlessMeasurementModes({ inputReviewMode: "skip" }));
	for (const inputReviewMode of ["pre-reviewed", "upload-reviewed", "upload-pending"])
		assert.equal(
			resolveScanlessMeasurementModes({ inputReviewMode }).inputReviewMode,
			inputReviewMode,
		);
});

void test("upload start remains in the total after review moves before click", () => {
	const result = scanlessMeasurementTimeline({
		preparationStartedAt: 100,
		preparationReadyAt: 4100,
		uploadStartedAt: 100,
		uploadReturnedAt: 500,
		click: 4300,
		visible: 5200,
	});
	assert.equal(result.uploadMs, 400);
	assert.equal(result.uploadToClickMs, 4200);
	assert.equal(result.uploadToVisibleMs, 5100);
	assert.equal(result.preparationToVisibleMs, result.uploadToVisibleMs);
	assert.equal(result.uploadToClickMs! + result.clickToVisibleMs!, result.uploadToVisibleMs);
	assert.equal(
		scanlessMeasurementTimeline({ preparationStartedAt: 100, preparationReadyAt: 200 })
			.uploadToVisibleMs,
		null,
	);
});

void test("failed upload preparation keeps unobserved readiness and derived durations null", () => {
	for (const preparationStartedAt of [2001, 1930]) {
		const result = scanlessMeasurementTimeline({
			preparationStartedAt,
			preparationReadyAt: null,
			uploadStartedAt: preparationStartedAt,
		});
		assert.equal(result.preparationStartedAt, preparationStartedAt);
		assert.equal(result.preparationReadyAt, null);
		assert.equal(result.preparationMs, null);
		assert.equal(result.preparedToClickMs, null);
		assert.equal(result.preparationToVisibleMs, null);
		assert.equal(result.uploadReturnedAt, null);
		assert.equal(result.uploadMs, null);
		assert.equal(result.clickToVisibleMs, null);
	}
	assert.equal(
		scanlessMeasurementTimeline({
			preparationStartedAt: 2001,
			preparationReadyAt: null,
			click: 3000,
		}).preparedToClickMs,
		null,
	);
});

void test("defer owns the existing promise without serializing the response behind it", async () => {
	const pending = new Set<Promise<void>>();
	const events: string[] = [];
	let finish!: () => void;
	const work = new Promise<void>((resolve) => {
		events.push("started");
		finish = resolve;
	});
	const defer = createScanlessRequestDefer({
		mode: "deferred",
		pending,
		onError: assert.fail,
		onEvent: (phase) => events.push(phase),
	});
	assert.equal(defer!(work), undefined);
	assert.equal(pending.size, 1);
	assert.deepEqual(events, ["started", "registered"]);
	finish();
	await Promise.all(pending);
	assert.equal(pending.size, 0);
	assert.deepEqual(events, ["started", "registered", "fulfilled"]);
});

void test("deferred failures are retained and drained rather than becoming silent success", async () => {
	const pending = new Set<Promise<void>>();
	const errors: unknown[] = [];
	const failure = new Error("wake failed");
	createScanlessRequestDefer({
		mode: "deferred",
		pending,
		onError: (error) => errors.push(error),
	})!(Promise.reject(failure));
	await Promise.all(pending);
	assert.deepEqual(errors, [failure]);
	assert.equal(pending.size, 0);
	assert.equal(
		createScanlessRequestDefer({ mode: "await-dispatch", pending, onError: assert.fail }),
		undefined,
	);
});

void test("pre-review timing retains preparation cost and gap as well as click latency", () => {
	const result = scanlessMeasurementTimeline({
		preparationStartedAt: 100,
		preparationReadyAt: 4_100,
		click: 4_300,
		visible: 5_200,
	});
	assert.equal(result.preparationMs, 4_000);
	assert.equal(result.preparedToClickMs, 200);
	assert.equal(result.clickToVisibleMs, 900);
	assert.equal(result.preparationToVisibleMs, 5_100);
	assert.equal(
		result.preparationToVisibleMs,
		result.preparationMs! + result.preparedToClickMs! + result.clickToVisibleMs!,
	);
	assert.equal(
		scanlessMeasurementTimeline({ preparationStartedAt: 100, preparationReadyAt: 200 })
			.preparationToVisibleMs,
		null,
	);
});
