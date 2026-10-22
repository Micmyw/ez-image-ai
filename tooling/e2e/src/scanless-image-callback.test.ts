import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createJobWaker } from "@repo/jobs/orchestration/client";
import { imagePhaseEventType } from "@repo/jobs/orchestration/contracts";
import { imageModerationCallbackUrl } from "@repo/jobs/orchestration/image-moderation-callback-auth";

import { handlePhaseWake } from "../../../apps/workflows/src/wake";
import { createImageModerationCallbackHandler } from "../../../packages/api/modules/media/webhooks/image-moderation-callback";
import { createScanlessImageModerationWake } from "./scanless-image-callback";

const secret = "scanless-callback-contract-32-character-secret";
const signingKey = "whsec_scanless_callback_contract";
const environment = {
	NEXT_PUBLIC_SAAS_URL: "https://isolated.invalid",
	WORKFLOWS_DISPATCH_SECRET: secret,
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({ whkey_scanless: signingKey }),
};
const identity = { assetId: "fixture-input", generation: 2, submissionToken: "submission-2" };
const phaseOwner = {
	workflowId: `job-${"a".repeat(64)}`,
	phaseKey: "434c89ce-0f78-4d22-8aa9-f90cece30539",
	epoch: 4,
};

function fixture(signalFails = false) {
	const calls = { ownerWake: 0, legacyWake: 0, workflowGet: [] as string[], paths: [] as string[] };
	const sentEvents: Array<{ type: string; payload: unknown }> = [];
	let persisted = false;
	const client = {} as Parameters<typeof createScanlessImageModerationWake>[1];
	const database = {
		wakeImageModeration: async () => {
			calls.legacyWake++;
			return "ready" as const;
		},
		wakeImageModerationWithOwner: async (input: typeof identity, receivedClient: typeof client) => {
			assert.deepEqual(input, identity);
			assert.equal(receivedClient, client);
			calls.ownerWake++;
			await Promise.resolve();
			persisted = true;
			return { status: "ready" as const, phaseOwner };
		},
	};
	const workflows: Parameters<typeof handlePhaseWake>[2] = {
		createBatch: async () => assert.fail("callback must not create a competing Workflow"),
		get: async (id) => {
			assert.equal(persisted, true);
			assert.equal(id, phaseOwner.workflowId);
			calls.workflowGet.push(id);
			return {
				status: async () => ({ status: "running" }),
				restart: async () => assert.fail("callback must not restart the owner"),
				sendEvent: async (event) => {
					if (signalFails) throw new Error("signal unavailable");
					sentEvents.push(event);
				},
			};
		},
	};
	const dispatch = createJobWaker({
		url: "https://jobs.isolated.invalid/internal/dispatch",
		secret,
		fetch: async (url, init) => {
			const request = new Request(url, init);
			calls.paths.push(new URL(request.url).pathname);
			return handlePhaseWake(request, secret, workflows);
		},
	});
	const handler = createImageModerationCallbackHandler({
		environment: () => environment,
		wake: createScanlessImageModerationWake(database, client),
		dispatch,
	});
	const body = JSON.stringify({
		status: "approved",
		phaseOwner: { workflowId: "callback-supplied-owner", phaseKey: "forged", epoch: 999 },
	});
	const timestamp = String(Math.floor(Date.now() / 1000));
	const request = new Request(imageModerationCallbackUrl(identity, environment)!, {
		method: "POST",
		body,
		headers: {
			"X-SEEAPI-Timestamp": timestamp,
			"X-SEEAPI-Signing-Key": "whkey_scanless",
			"X-SEEAPI-Signature": `v1=${createHmac("sha256", signingKey).update(`${timestamp}.${body}`).digest("hex")}`,
		},
	});
	return { handler, request, calls, sentEvents };
}

void test("scanless callback preserves the committed owner through both signed production endpoints", async () => {
	const { handler, request, calls, sentEvents } = fixture();
	assert.equal((await handler(request)).status, 202);
	assert.equal(calls.ownerWake, 1);
	assert.equal(calls.legacyWake, 0);
	assert.deepEqual(calls.paths, ["/internal/phase-wake"]);
	assert.deepEqual(calls.workflowGet, [phaseOwner.workflowId]);
	assert.deepEqual(sentEvents, [
		{
			type: imagePhaseEventType(phaseOwner),
			payload: { phaseKey: phaseOwner.phaseKey, epoch: phaseOwner.epoch },
		},
	]);
});

void test("scanless callback keeps a failed owner signal on the same phase without legacy fallback", async () => {
	const { handler, request, calls, sentEvents } = fixture(true);
	assert.equal((await handler(request)).status, 503);
	assert.equal(calls.ownerWake, 1);
	assert.equal(calls.legacyWake, 0);
	assert.deepEqual(calls.paths, ["/internal/phase-wake"]);
	assert.deepEqual(calls.workflowGet, [phaseOwner.workflowId]);
	assert.deepEqual(sentEvents, []);
});
