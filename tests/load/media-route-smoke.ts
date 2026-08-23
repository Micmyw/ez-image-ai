import { randomBytes, randomUUID } from "node:crypto";

import { assertSafeDatabaseUrl } from "./assert-safe-target";

const testDatabaseUrl = assertSafeDatabaseUrl(process.env.TEST_DATABASE_URL).toString();
const runId = `smoke-${randomUUID()}`;
const token = randomBytes(32).toString("base64url");
const idempotencyKey = `k6:${runId}:1:1`;

process.env.DATABASE_URL = testDatabaseUrl;
process.env.NODE_ENV = "test";
process.env.LOAD_TESTING_ENABLED = "false";
process.env.LOAD_TEST_DATABASE_URL = testDatabaseUrl;
process.env.LOAD_AUTH_TOKEN = token;
process.env.LOAD_TEST_RUN_ID = runId;

void run();

async function run(): Promise<void> {
	const [{ getCreditInvariantReport }, { db }, { app }] = await Promise.all([
		import("@repo/database"),
		import("@repo/database/client"),
		import("../../packages/api/index"),
	]);
	try {
		const disabled = await request(app, token);
		assert(disabled.status === 404, `disabled route returned ${disabled.status}`);

		process.env.LOAD_TESTING_ENABLED = "true";
		const unauthorized = await request(app, `${token}x`);
		assert(unauthorized.status === 401, `unauthorized request returned ${unauthorized.status}`);

		const created = await request(app, token);
		const createdBody = await parseResponse(created);
		assert(created.status === 202, `first request returned ${created.status}`);
		assert(createdBody.idempotencyKey === idempotencyKey, "idempotency key was not echoed");
		assert(typeof createdBody.jobId === "string", "job ID was not returned");

		const replay = await request(app, token);
		const replayBody = await parseResponse(replay);
		assert(replay.status === 200, `replay returned ${replay.status}`);
		assert(replayBody.jobId === createdBody.jobId, "replay created a different job");
		assert(replayBody.replayed === true, "replay was not identified");

		const ownerId = `load-test:${runId}`;
		const [jobCount, account, initialOutboxCount] = await Promise.all([
			db.generationJob.count({ where: { ownerId, idempotencyKey } }),
			db.creditAccount.findUniqueOrThrow({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
			}),
			db.outboxEvent.count({
				where: {
					aggregateId: createdBody.jobId as string,
					eventType: { in: ["JOB_CREATED", "GENERATION_FINALIZE"] },
				},
			}),
		]);
		assert(jobCount === 1, `expected one job, found ${jobCount}`);
		assert(
			initialOutboxCount === 2,
			`expected two initial outbox events, found ${initialOutboxCount}`,
		);
		assert((await getCreditInvariantReport(account.id, db)).valid, "credit invariant failed");
		console.log(
			JSON.stringify({
				status: "passed",
				runId,
				jobId: createdBody.jobId,
				internalQueueMs: createdBody.internalQueueMs,
			}),
		);
	} finally {
		await db.$disconnect();
	}
}

async function request(
	app: { request(input: string, init: RequestInit): Response | Promise<Response> },
	authToken: string,
): Promise<Response> {
	return app.request("/api/testing/media-load", {
		method: "POST",
		headers: {
			authorization: `Bearer ${authToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ mode: "fast", idempotencyKey, prompt: "route smoke" }),
	});
}

async function parseResponse(response: Response): Promise<Record<string, unknown>> {
	const value: unknown = await response.json();
	assert(Boolean(value) && typeof value === "object", "response body was not an object");
	return value as Record<string, unknown>;
}

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(`LOAD_ROUTE_SMOKE_FAILED: ${message}`);
}
