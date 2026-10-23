import { getDatabaseClient } from "@repo/database/client";
import { signRequest } from "@repo/jobs/orchestration/auth";
import type { TaskRequest } from "@repo/jobs/orchestration/contracts";
import { taskDefinition } from "@repo/jobs/orchestration/registry";
import { publishCommittedMediaJobNotifications } from "@repo/jobs/realtime/publish";
import { getRequestDefer, type RequestDefer } from "@repo/utils/request-lifecycle";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execute: vi.fn(),
	poll: vi.fn(),
	createDatabase: vi.fn(),
	ack: vi.fn(),
}));
vi.mock("@repo/jobs/orchestration/executor", () => ({ executeTask: mocks.execute }));
vi.mock("@repo/jobs/orchestration/polling", () => ({ executePollingTick: mocks.poll }));
vi.mock("@repo/database/client", async (original) => ({
	...(await original<typeof import("@repo/database/client")>()),
	createRuntimeDatabaseClient: mocks.createDatabase,
}));
vi.mock("@repo/database/media-job-notifications", () => ({
	acknowledgePublishedMediaJobNotification: mocks.ack,
}));
vi.mock("@repo/storage/image-processing/cloudflare-images", () => ({
	createCloudflareImagesProcessor: () => ({}),
}));
vi.mock("@repo/storage/lib/cloudflare-remote-media", () => ({
	runWithCloudflareRemoteMedia: (operation: () => unknown) => operation(),
}));

import {
	createRuntimeExecutionHandler,
	type RuntimeExecutionEnvironment,
} from "./runtime-execution";

const secret = "test-only-32-character-shared-secret";
const event = { eventId: `mju_${"a".repeat(64)}`, jobId: "job", version: "asset:a:g1:ready" };
const completed = { done: true, waitSeconds: 0 };
const clients: { $disconnect: ReturnType<typeof vi.fn> }[] = [];

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function runtime(send: (request: Request) => Promise<Response>, managed = true) {
	const lifetimes: Promise<unknown>[] = [];
	const env = {
		WORKFLOWS_DISPATCH_SECRET: secret,
		WORKFLOWS_DISPATCH_URL: "https://jobs.example/internal/dispatch",
		HYPERDRIVE: { connectionString: "test-only" },
		IMAGES: {},
		JOBS: {},
		MEDIA_JOB_EVENTS: { idFromName: (name: string) => name, get: () => ({ fetch: send }) },
	} as unknown as RuntimeExecutionEnvironment;
	const handler = createRuntimeExecutionHandler(env, {
		admission: "request",
		...(managed
			? {
					waitUntil: (work: Promise<unknown>) => {
						lifetimes.push(work);
					},
				}
			: {}),
	});
	return { handler, lifetimes, env };
}

async function signed(jobId = "job", polling = false) {
	const taskId = polling ? "media-poll-generation" : "media-verify-upload";
	const body = JSON.stringify({
		request: { taskId, payload: polling ? { attemptId: jobId } : { assetId: jobId } },
		context: { attempt: 1, maxAttempts: taskDefinition(taskId).maxAttempts, runId: jobId },
	});
	return new Request("https://executor/internal/execute", {
		method: "POST",
		body,
		headers: await signRequest(secret, "POST", "/internal/execute", body),
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	clients.length = 0;
	vi.stubEnv("EZPIC_RUNTIME", "workers");
	vi.stubEnv("MEDIA_JOB_EVENTS_ENABLED", "true");
	mocks.createDatabase.mockImplementation(() => {
		const client = { $disconnect: vi.fn(async () => undefined) };
		clients.push(client);
		return client;
	});
	mocks.ack.mockResolvedValue(undefined);
	mocks.execute.mockImplementation(async () => {
		await publishCommittedMediaJobNotifications([event], getDatabaseClient());
		return completed;
	});
	mocks.poll.mockResolvedValue(completed);
});
afterEach(() => {
	vi.unstubAllEnvs();
});

describe("request-owned notification lifetime", () => {
	it("returns before notification, survives response cancellation, and disconnects only after DB ACK", async () => {
		const receipt = deferred<Response>();
		const ack = deferred<void>();
		const ackStarted = deferred<void>();
		const observations: unknown[] = [];
		mocks.ack.mockImplementation(async (_event, database) => {
			observations.push(database, getDatabaseClient());
			ackStarted.resolve();
			await ack.promise;
			observations.push(database.$disconnect.mock.calls.length);
		});
		const send = vi.fn(() => receipt.promise);
		const worker = runtime(send);
		const response = await worker.handler(await signed());
		expect(response.status).toBe(200);
		expect(send).toHaveBeenCalledOnce();
		expect(mocks.execute).toHaveBeenCalledOnce();
		expect(mocks.ack).not.toHaveBeenCalled();
		expect(worker.lifetimes).toHaveLength(1);
		await response.body!.cancel();
		expect(clients[0]!.$disconnect).not.toHaveBeenCalled();
		receipt.resolve(Response.json({ persisted: true, eventId: event.eventId }));
		await ackStarted.promise;
		expect(clients[0]!.$disconnect).not.toHaveBeenCalled();
		ack.resolve();
		await Promise.all(worker.lifetimes);
		expect(observations).toEqual([clients[0], clients[0], 0]);
		expect(clients[0]!.$disconnect).toHaveBeenCalledOnce();
	});

	it("drains descendants registered by a live task with the same database context", async () => {
		const parent = deferred<void>();
		const child = deferred<void>();
		const childStarted = deferred<void>();
		const observations: unknown[] = [];
		let retainedDefer!: RequestDefer;
		mocks.execute.mockImplementation(async () => {
			retainedDefer = getRequestDefer()!;
			retainedDefer(
				parent.promise.then(() => {
					observations.push(getDatabaseClient());
					getRequestDefer()!(
						child.promise.then(() => {
							observations.push(getDatabaseClient(), clients[0]!.$disconnect.mock.calls.length);
						}),
					);
					childStarted.resolve();
				}),
			);
			return completed;
		});
		const worker = runtime(vi.fn());
		expect((await worker.handler(await signed())).status).toBe(200);
		parent.resolve();
		await childStarted.promise;
		expect(clients[0]!.$disconnect).not.toHaveBeenCalled();
		child.resolve();
		await Promise.all(worker.lifetimes);
		expect(observations).toEqual([clients[0], clients[0], 0]);
		expect(clients[0]!.$disconnect).toHaveBeenCalledOnce();
		expect(() => retainedDefer(Promise.resolve())).toThrow("WORKER_RUNTIME_SCOPE_CLOSED");
	});

	it.each(["receipt", "ack", "task"])(
		"keeps committed work successful after a background %s failure",
		async (failure) => {
			const release = deferred<void>();
			const worker = runtime(async () => {
				await release.promise;
				return failure === "receipt"
					? new Response("unavailable", { status: 503 })
					: Response.json({ persisted: true, eventId: event.eventId });
			});
			if (failure === "ack") mocks.ack.mockRejectedValue(new Error("ACK_UNAVAILABLE"));
			if (failure === "task")
				mocks.execute.mockImplementation(async () => {
					getRequestDefer()!(
						release.promise.then(() => {
							throw new Error("BACKGROUND_FAILED");
						}),
					);
					return completed;
				});
			const response = await worker.handler(await signed());
			expect(response.status).toBe(200);
			expect(clients[0]!.$disconnect).not.toHaveBeenCalled();
			release.resolve();
			await Promise.all(worker.lifetimes);
			expect(mocks.execute).toHaveBeenCalledOnce();
			expect(clients[0]!.$disconnect).toHaveBeenCalledOnce();
			if (failure !== "ack") expect(mocks.ack).not.toHaveBeenCalled();
		},
	);

	it("keeps overlapping request scopes and late ACKs isolated", async () => {
		const receipts = [deferred<Response>(), deferred<Response>()];
		const received = new Map<string, { index: number; database: unknown }>();
		const observations: unknown[] = [];
		mocks.execute.mockImplementation(async (task: TaskRequest) => {
			const jobId = task.payload.assetId as string;
			await publishCommittedMediaJobNotifications([{ ...event, jobId }], getDatabaseClient());
			return completed;
		});
		const worker = runtime(async (request) => {
			const { jobId } = (await request.json()) as typeof event;
			const index = received.size;
			received.set(jobId, { index, database: getDatabaseClient() });
			return receipts[index]!.promise;
		});
		mocks.ack.mockImplementation(async (notification: typeof event, database) => {
			observations.push({
				jobId: notification.jobId,
				database,
				scope: getDatabaseClient(),
				disconnects: database.$disconnect.mock.calls.length,
			});
		});
		const responses = await Promise.all([
			worker.handler(await signed("first")),
			worker.handler(await signed("second")),
		]);
		expect(responses.map(({ status }) => status)).toEqual([200, 200]);
		expect(clients[0]).not.toBe(clients[1]);
		receipts[1]!.resolve(Response.json({ persisted: true, eventId: event.eventId }));
		await worker.lifetimes[1];
		expect(clients[1]!.$disconnect).toHaveBeenCalledOnce();
		expect(clients[0]!.$disconnect).not.toHaveBeenCalled();
		receipts[0]!.resolve(Response.json({ persisted: true, eventId: event.eventId }));
		await Promise.all(worker.lifetimes);
		expect(observations).toEqual([
			{
				jobId: "second",
				database: received.get("second")!.database,
				scope: clients[1],
				disconnects: 0,
			},
			{
				jobId: "first",
				database: received.get("first")!.database,
				scope: clients[0],
				disconnects: 0,
			},
		]);
		expect(clients[0]!.$disconnect).toHaveBeenCalledOnce();
		expect(mocks.ack).toHaveBeenCalledTimes(2);
	});

	it("waits for already-started notifications when the caller has no platform lifetime", async () => {
		const started = deferred<void>();
		const receipt = deferred<Response>();
		const worker = runtime(() => {
			started.resolve();
			return receipt.promise;
		}, false);
		let returned = false;
		const response = worker.handler(await signed()).then((value) => {
			returned = true;
			return value;
		});
		await started.promise;
		expect(returned).toBe(false);
		expect(clients[0]!.$disconnect).not.toHaveBeenCalled();
		receipt.resolve(Response.json({ persisted: true, eventId: event.eventId }));
		expect((await response).status).toBe(200);
		expect(mocks.ack).toHaveBeenCalledOnce();
		expect(clients[0]!.$disconnect).toHaveBeenCalledOnce();
		expect(worker.lifetimes).toHaveLength(0);
	});

	it.each([false, true])(
		"awaits disconnect before returning an empty scope (polling=%s)",
		async (polling) => {
			mocks.execute.mockResolvedValue(completed);
			const worker = runtime(vi.fn());
			expect((await worker.handler(await signed("job", polling))).status).toBe(200);
			expect(clients[0]!.$disconnect).toHaveBeenCalledOnce();
			await Promise.all(worker.lifetimes);
		},
	);

	it("cleans up failed lifetime registration without starting business work", async () => {
		const worker = runtime(vi.fn());
		const handler = createRuntimeExecutionHandler(worker.env, {
			admission: "request",
			waitUntil: () => {
				throw new Error("CONTEXT_ENDED");
			},
		});
		expect((await handler(await signed())).status).toBe(502);
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(clients[0]!.$disconnect).toHaveBeenCalledOnce();
	});
});
