import { signRequest } from "@repo/jobs/orchestration/auth";
import type { TaskRequest } from "@repo/jobs/orchestration/contracts";
import { taskDefinition } from "@repo/jobs/orchestration/registry";
import { workerExecutorForTask } from "@repo/jobs/orchestration/worker-executors";
import type { WorkflowStep } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execute: vi.fn(),
	poll: vi.fn(),
	disconnect: vi.fn(),
}));

vi.mock("cloudflare:workers", () => {
	class Entry {
		constructor(
			protected ctx: unknown,
			protected env: unknown,
		) {}
	}
	return { DurableObject: Entry, WorkflowEntrypoint: Entry };
});
vi.mock("@repo/jobs/orchestration/executor", () => ({ executeTask: mocks.execute }));
vi.mock("@repo/jobs/orchestration/polling", () => ({ executePollingTick: mocks.poll }));
vi.mock("@repo/database/client", () => ({
	createRuntimeDatabaseClient: () => ({ $disconnect: mocks.disconnect }),
	runWithDatabaseClient: (_database: unknown, operation: () => unknown) => operation(),
}));
vi.mock("@repo/storage/image-processing/cloudflare-images", () => ({
	createCloudflareImagesProcessor: () => ({}),
}));
vi.mock("@repo/storage/image-processing/context", () => ({
	runWithImageProcessor: (_processor: unknown, operation: () => unknown) => operation(),
}));
vi.mock("@repo/storage/lib/cloudflare-remote-media", () => ({
	runWithCloudflareRemoteMedia: (operation: () => unknown) => operation(),
}));

import { JobsWorkflow, WorkerJobs, type WorkersEnvironment } from "./workers";

const secret = "test-only-32-character-shared-secret";
const heavy: TaskRequest = {
	taskId: "media-finalize-generation",
	payload: { jobId: "heavy", version: 0 },
};
const light: TaskRequest = { taskId: "media-verify-upload", payload: { assetId: "light" } };
const maintenance: TaskRequest = { taskId: "media-deliver-outbox", payload: {} };

function runtime() {
	const objects = new Map<string, WorkerJobs>();
	const routed: string[] = [];
	const idFromName = (name: string) => ({
		name,
		equals: (other: { name: string }) => other.name === name,
	});
	const environment = {
		WORKFLOWS_DISPATCH_SECRET: secret,
		WORKFLOWS_DISPATCH_URL: "https://jobs.example/internal/dispatch",
		HYPERDRIVE: { connectionString: "test-only" },
		IMAGES: {},
		JOBS: {},
		JOBS_EXECUTOR: {
			idFromName,
			get(id: { name: string }) {
				routed.push(id.name);
				let object = objects.get(id.name);
				if (!object) {
					object = new WorkerJobs(
						{ id, waitUntil: () => undefined } as unknown as DurableObjectState,
						environment as unknown as WorkersEnvironment,
					);
					objects.set(id.name, object);
				}
				return object;
			},
		},
	};
	async function send(name: string, request: TaskRequest) {
		const body = JSON.stringify({
			request,
			context: {
				attempt: 1,
				maxAttempts: taskDefinition(request.taskId).maxAttempts,
				runId: "test",
			},
		});
		return environment.JOBS_EXECUTOR.get(idFromName(name)).fetch(
			new Request("https://executor/internal/execute", {
				method: "POST",
				body,
				headers: await signRequest(secret, "POST", "/internal/execute", body),
			}),
		);
	}
	async function run(request: TaskRequest) {
		const workflow = new JobsWorkflow(
			{} as ExecutionContext,
			environment as unknown as WorkersEnvironment,
		);
		return workflow.run(
			{ instanceId: "test", payload: { kind: "task", request } } as Parameters<
				JobsWorkflow["run"]
			>[0],
			{
				do: async (_name: string, _config: unknown, callback: () => Promise<unknown>) => callback(),
				sleep: async () => {
					throw new Error("UNEXPECTED_CAPACITY_WAIT");
				},
			} as unknown as WorkflowStep,
		);
	}
	return { send, run, routed };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.disconnect.mockResolvedValue(undefined);
	mocks.execute.mockResolvedValue({ done: true, waitSeconds: 0 });
	mocks.poll.mockResolvedValue({ done: true, waitSeconds: 0 });
	vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("Workers executor routing", () => {
	it("advances verification and its Outbox while a heavy transfer is still running", async () => {
		let finish!: () => void;
		mocks.execute.mockImplementation(async (task: TaskRequest) => {
			if (task.taskId === heavy.taskId)
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
			return { done: true, waitSeconds: 0 };
		});
		const worker = runtime();
		const transfer = worker.send("jobs-primary", heavy);
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		try {
			await expect(worker.run(light)).resolves.toEqual({ completed: true });
			expect(worker.routed).toEqual(["jobs-primary", "jobs-control", "jobs-maintenance"]);
		} finally {
			finish();
			await transfer;
		}
	});

	it("admits four light requests but keeps heavy and maintenance capacity at one", async () => {
		const finishes: Array<() => void> = [];
		mocks.execute.mockImplementation(
			() =>
				new Promise((resolve) => {
					finishes.push(() => resolve({ done: true, waitSeconds: 0 }));
				}),
		);
		const worker = runtime();
		const active: Array<Promise<Response>> = [];
		try {
			for (const [name, task] of [
				["jobs-primary", heavy],
				["jobs-control", light],
				["jobs-maintenance", maintenance],
			] as const) {
				active.push(worker.send(name, task));
				await vi.waitFor(() => expect(finishes).toHaveLength(active.length));
			}
			for (let index = 2; index <= 4; index++) {
				active.push(
					worker.send("jobs-control", { ...light, payload: { assetId: `light-${index}` } }),
				);
				await vi.waitFor(() => expect(finishes).toHaveLength(active.length));
			}
			for (const [name, task] of [
				["jobs-primary", heavy],
				["jobs-control", light],
				["jobs-maintenance", maintenance],
			] as const) {
				expect((await worker.send(name, task)).status).toBe(429);
			}
		} finally {
			for (const finish of finishes) finish();
			await Promise.all(active);
		}
	});

	it("rejects misrouted heavy work before opening runtime resources", async () => {
		const worker = runtime();
		expect((await worker.send("jobs-control", heavy)).status).toBe(400);
		expect((await worker.send("jobs-maintenance", light)).status).toBe(400);
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(mocks.disconnect).not.toHaveBeenCalled();
	});

	it.each([5, 10, 20])(
		"completes %i concurrent light requests while heavy and maintenance work stay occupied",
		async (count) => {
			const finishes: Array<() => void> = [];
			let activeLight = 0;
			let peakLight = 0;
			let busy = 0;
			const processed: string[] = [];
			mocks.execute.mockImplementation(async (task: TaskRequest) => {
				if (task.taskId !== light.taskId) {
					await new Promise<void>((resolve) => {
						finishes.push(resolve);
					});
					return;
				}
				activeLight++;
				peakLight = Math.max(peakLight, activeLight);
				processed.push(String(task.payload.assetId));
				try {
					await new Promise((resolve) => setTimeout(resolve, 10));
					return { done: true, waitSeconds: 0 };
				} finally {
					activeLight--;
				}
			});
			const worker = runtime();
			const held = [
				worker.send("jobs-primary", heavy),
				worker.send("jobs-maintenance", maintenance),
			];
			await vi.waitFor(() => expect(finishes).toHaveLength(2));
			try {
				await Promise.all(
					Array.from({ length: count }, async (_, index) => {
						const request = { ...light, payload: { assetId: `asset-${index}` } };
						for (let attempt = 0; attempt < 120; attempt++) {
							const response = await worker.send(workerExecutorForTask(request).name, request);
							if (response.status === 200) return;
							expect(response.status).toBe(429);
							busy++;
							// Scale the retry pause for a local admission test; this is not a
							// real provider or a measurement of production user capacity.
							await new Promise((resolve) => setTimeout(resolve, 5));
						}
						throw new Error("CAPACITY_DID_NOT_RECOVER");
					}),
				);
				expect(peakLight).toBe(4);
				expect(new Set(processed).size).toBe(count);
				expect(processed).toHaveLength(count);
				expect(busy).toBeGreaterThan(0);
				expect(mocks.disconnect).toHaveBeenCalledTimes(count);
			} finally {
				for (const finish of finishes) finish();
				await Promise.all(held);
			}
		},
	);
});
