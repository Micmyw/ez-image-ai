import assert from "node:assert/strict";
import test from "node:test";

import { scanlessExecutionAccounting } from "./scanless-execution-accounting";

void test("one fused executor RPC retains its inline business stage without double counting", () => {
	const entries: Array<[string, Record<string, unknown>]> = [
		[
			"media.task.started",
			{ taskId: "media-execute-event", runId: "r", outboxEventId: "event", startedAt: 10 },
		],
		[
			"media.task.started",
			{
				taskId: "media-verify-upload",
				executionMode: "inline",
				parentTaskId: "media-execute-event",
				runId: "r",
				outboxEventId: "event",
				assetId: "input",
				startedAt: 12,
			},
		],
		["media.upload.verification", { assetId: "input", stage: "claimed", stageMs: 8, at: 20 }],
		[
			"job.executor",
			{
				taskId: "media-execute-event",
				runId: "r",
				phase: "completed",
				startedAt: 10,
				completedAt: 30,
			},
		],
	];
	const log = entries.map(([tag, value]) => `${tag} ${JSON.stringify(value)}`).join("\n");
	const result = scanlessExecutionAccounting(
		{
			cases: [{ caseIndex: 0, job: { id: "job", inputAssetId: "input" } }],
			sqlMetricsEnabled: false,
			observations: [
				{ stage: "seeapi.query", done: true },
				{ stage: "browser.status.request" },
				{ stage: "phase-wake.accepted" },
			],
		},
		log,
	);
	assert.equal(result.executorRpcCompletions, 1);
	assert.equal(result.inlineBusinessStageStarts, 1);
	assert.equal(result.unassignedRpcCompletions, 0);
	assert.equal(
		result.byTask.find((row) => row.taskId === "media-verify-upload")!.executorRpcCompletions,
		0,
	);
	assert.equal(
		result.byTask.find((row) => row.taskId === "media-verify-upload")!.inlineElapsedMs,
		null,
	);
	assert.deepEqual(result.verificationStageCounts, { claimed: 1 });
	assert.deepEqual(result.supplierQueries, { "seeapi.query": 1 });
	assert.equal(result.sqlObservedQueryCount, null);
});

void test("absent telemetry stays unknown and unassigned executor work is retained", () => {
	const result = scanlessExecutionAccounting(
		{},
		'job.executor {"phase":"completed","taskId":"media-execute-event","runId":"unknown"}',
	);
	assert.equal(result.executorRpcCompletions, 1);
	assert.equal(result.unassignedRpcCompletions, 1);
	assert.equal(result.byTask[0]!.missingExecutorEnvelopeCount, 1);
	assert.equal(result.supplierQueries, null);
	assert.equal(result.statusRequests, null);
	assert.equal(result.sqlObservedQueryCount, null);
});
