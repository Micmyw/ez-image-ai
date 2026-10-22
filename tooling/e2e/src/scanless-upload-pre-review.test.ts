import assert from "node:assert/strict";
import test from "node:test";

import {
	observeScanlessPreClickReview,
	scanlessUploadPreReviewErrors,
	type ScanlessReferenceReviewStatus,
} from "./scanless-upload-pre-review";

void test("pending upload clicks without waiting for review completion", async () => {
	let reads = 0;
	const events: string[] = [];
	const result = await observeScanlessPreClickReview({
		mode: "upload-pending",
		deadlineAt: 200,
		now: () => 100,
		readStatus: async () => {
			reads++;
			return { status: "PENDING" };
		},
		wait: async () => {
			events.push("wait");
		},
		onObservation: (row) => events.push(row.status),
	}).then((row) => {
		events.push("click");
		return row;
	});
	assert.equal(result.status, "PENDING");
	assert.equal(reads, 1);
	assert.deepEqual(events, ["PENDING", "click"]);
});

void test("reviewed upload waits for authenticated approval and retains each observation", async () => {
	let now = 100;
	const statuses: ScanlessReferenceReviewStatus[] = ["PENDING", "PENDING", "APPROVED"];
	const observed: string[] = [];
	const result = await observeScanlessPreClickReview({
		mode: "upload-reviewed",
		deadlineAt: 500,
		now: () => now,
		readStatus: async () => ({ status: statuses.shift()! }),
		wait: async () => {
			now += 100;
		},
		onObservation: (row) => observed.push(row.status),
	});
	assert.equal(result.observedAt, 300);
	assert.deepEqual(observed, ["PENDING", "PENDING", "APPROVED"]);
});

void test("rejected or unavailable review never proceeds to generation click", async () => {
	for (const status of ["REJECTED", "UNAVAILABLE"] as const) {
		let clicked = false;
		await assert.rejects(
			observeScanlessPreClickReview({
				mode: "upload-reviewed",
				deadlineAt: 200,
				now: () => 100,
				readStatus: async () => ({ status }),
				wait: async () => assert.fail("terminal review must not be retried"),
				onObservation: () => undefined,
			}).then(() => {
				clicked = true;
			}),
			new RegExp(status),
		);
		assert.equal(clicked, false);
	}
});

void test("already complete, missing and timed out pending scenarios fail instead of looking faster", async () => {
	for (const status of ["APPROVED", "NOT_STARTED"] as const)
		await assert.rejects(
			observeScanlessPreClickReview({
				mode: "upload-pending",
				deadlineAt: 200,
				now: () => 100,
				readStatus: async () => ({ status }),
				wait: async () => assert.fail("pending scenario must not wait"),
				onObservation: () => undefined,
			}),
			/SCENARIO_NOT_EXERCISED/,
		);
	await assert.rejects(
		observeScanlessPreClickReview({
			mode: "upload-reviewed",
			deadlineAt: 100,
			now: () => 100,
			readStatus: async () => assert.fail("expired before read"),
			wait: async () => undefined,
			onObservation: () => undefined,
		}),
		/DEADLINE/,
	);
});

const evidence = {
	mode: "upload-pending" as const,
	clickAt: 300,
	uploadStartedAt: 100,
	uploadReturnedAt: 200,
	preClickReview: { status: "PENDING" as const, requestedAt: 201, observedAt: 250 },
	reviews: [{ id: "original-input-task", readyAt: 350 }],
	persistedProviderTaskId: "original-input-task",
};

void test("same input task survives pending click without a second review", () => {
	assert.deepEqual(scanlessUploadPreReviewErrors(evidence), []);
	assert.deepEqual(
		scanlessUploadPreReviewErrors({
			...evidence,
			mode: "upload-reviewed",
			clickAt: 450,
			preClickReview: { status: "APPROVED", requestedAt: 360, observedAt: 400 },
		}),
		[],
	);
	assert(
		scanlessUploadPreReviewErrors({
			...evidence,
			reviews: [...evidence.reviews, { id: "replacement-input-task", readyAt: 350 }],
		}).includes("UPLOAD_INPUT_REVIEW_NOT_SINGLE_SUBMISSION"),
	);
	assert(
		scanlessUploadPreReviewErrors({
			...evidence,
			persistedProviderTaskId: "replacement-input-task",
		}).includes("UPLOAD_INPUT_REVIEW_TASK_CHANGED"),
	);
});

void test("review completed between status response and click is retained as a failed pending case", () => {
	assert(
		scanlessUploadPreReviewErrors({ ...evidence, clickAt: 400 }).includes(
			"UPLOAD_PENDING_SCENARIO_NOT_EXERCISED",
		),
	);
	assert(
		scanlessUploadPreReviewErrors({ ...evidence, uploadReturnedAt: 350 }).includes(
			"UPLOAD_CLICK_BOUNDARY_INVALID",
		),
	);
	assert(
		scanlessUploadPreReviewErrors({ ...evidence, preClickReview: null }).includes(
			"UPLOAD_PRE_CLICK_OBSERVATION_MISSING_OR_INVALID",
		),
	);
});
