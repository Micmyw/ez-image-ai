import assert from "node:assert/strict";
import test from "node:test";

import { LocalMediaE2EProvider, scenarioFromPrompt } from "./fixtures";

void test("cancel-pending is a dedicated accepted scenario that never aliases automatic success", async () => {
	assert.equal(scenarioFromPrompt("[e2e:cancel-pending] cancel this generation"), "cancel-pending");

	const submission = await new LocalMediaE2EProvider("replicate").submit({
		attemptId: "attempt_cancel",
		providerModelId: "model_test",
		input: {
			kind: "text-to-image",
			prompt: "[e2e:cancel-pending] cancel this generation",
		},
	});

	assert.equal(submission.outcome, "accepted");
	assert.equal(submission.status, "QUEUED");
});

void test("the local provider confirms an idempotent no-charge cancellation", async () => {
	const provider = new LocalMediaE2EProvider("replicate");
	assert.equal(typeof provider.cancel, "function");
	assert.deepEqual(
		await provider.cancel!({
			providerTaskId: "e2e-attempt_cancel",
			idempotencyKey: "generation-cancel:job_cancel:attempt_cancel",
		}),
		{
			status: "CANCELED",
			canceled: true,
			noCharge: true,
			retryable: false,
		},
	);
});
