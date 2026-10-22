import assert from "node:assert/strict";
import test from "node:test";

import { withinScanlessDeadline } from "./scanless-deadline";
import { createScanlessSubscriptionNamespace } from "./scanless-subscription-bridge";

void test("bounded inspection and cleanup preserve results and original errors", async () => {
	const value = { completed: true };
	const error = new Error("original");
	assert.equal(await withinScanlessDeadline("success", Promise.resolve(value), 100), value);
	await assert.rejects(
		withinScanlessDeadline("failure", Promise.reject(error), 100),
		(actual) => actual === error,
	);
	await assert.rejects(
		withinScanlessDeadline("pending-fixture", new Promise(() => {}), 10),
		/SCANLESS_STAGE_TIMEOUT:pending-fixture/,
	);
});

void test("subscription transport preserves server-derived identity without a synchronous remote proxy", async () => {
	const calls: Array<{ url: string; init: unknown }> = [];
	const response = new Response("test response");
	const namespace = createScanlessSubscriptionNamespace(async (url, init) => {
		calls.push({ url, init });
		return response;
	});
	const stub = namespace.get(namespace.idFromName("media-job:job-1"));
	assert.equal(
		await stub.fetch(
			new Request("https://media-job-events.internal/subscribe?jobId=job-1&expiresAt=123", {
				headers: { upgrade: "websocket" },
			}),
		),
		response,
	);
	assert.deepEqual(calls, [
		{
			url: "https://media-job-events.internal/__scanless/job-events?jobId=job-1&expiresAt=123",
			init: { method: "GET", headers: { upgrade: "websocket" } },
		},
	]);
	await assert.rejects(
		stub.fetch(new Request("https://media-job-events.internal/subscribe?jobId=other")),
		/INVALID_SCANLESS_SUBSCRIPTION_TRANSPORT/,
	);
	assert.equal(calls.length, 1);
});
