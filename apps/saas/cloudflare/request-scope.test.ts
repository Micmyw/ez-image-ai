import { AsyncLocalStorage } from "node:async_hooks";

import { describe, expect, it, vi } from "vitest";

import { runScopedWorkerRequest, type WorkerExecutionContext } from "./request-scope";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

function setup() {
	const storage = new AsyncLocalStorage<string>();
	const dispose = vi.fn(async () => {});
	const tasks: Promise<unknown>[] = [];
	const context: WorkerExecutionContext = {
		waitUntil: (promise) => tasks.push(promise),
		passThroughOnException: vi.fn(),
	};
	const scope = {
		run: <T>(callback: () => T) => storage.run("request-database", callback),
		dispose,
	};
	return { storage, dispose, tasks, context, scope };
}

describe("Workers request resource lifetime", () => {
	it("keeps request scope through lazy response streaming and disposes after completion", async () => {
		const state = setup();
		const response = await runScopedWorkerRequest(
			new Request("https://example.test/"),
			{},
			state.context,
			state.scope,
			async () => {
				expect(state.storage.getStore()).toBe("request-database");
				return new Response(
					new ReadableStream(
						{
							pull(controller) {
								expect(state.storage.getStore()).toBe("request-database");
								controller.enqueue(new TextEncoder().encode("complete"));
								controller.close();
							},
						},
						{ highWaterMark: 0 },
					),
					{ status: 201, headers: { "x-request-test": "preserved" } },
				);
			},
		);
		expect(state.dispose).not.toHaveBeenCalled();
		expect(response.status).toBe(201);
		expect(response.headers.get("x-request-test")).toBe("preserved");
		expect(await response.text()).toBe("complete");
		await Promise.all(state.tasks);
		expect(state.dispose).toHaveBeenCalledTimes(1);
	});

	it("waits for registered background work and work it registers before disposal", async () => {
		const state = setup();
		const first = deferred<void>();
		const second = deferred<void>();
		await runScopedWorkerRequest(
			new Request("https://example.test/"),
			{},
			state.context,
			state.scope,
			async (_request, _environment, context) => {
				context.waitUntil(first.promise.then(() => context.waitUntil(second.promise)));
				return new Response(null, { status: 204 });
			},
		);
		expect(state.dispose).not.toHaveBeenCalled();
		first.resolve();
		await first.promise;
		await Promise.resolve();
		expect(state.dispose).not.toHaveBeenCalled();
		second.resolve();
		await Promise.all(state.tasks);
		expect(state.dispose).toHaveBeenCalledTimes(1);
	});

	it("disposes on client cancellation while preserving the stream cancellation reason", async () => {
		const state = setup();
		const cancel = vi.fn();
		const response = await runScopedWorkerRequest(
			new Request("https://example.test/"),
			{},
			state.context,
			state.scope,
			async () => new Response(new ReadableStream({ cancel })),
		);
		await response.body?.cancel("client disconnected");
		await Promise.all(state.tasks);
		expect(cancel).toHaveBeenCalledWith("client disconnected");
		expect(state.dispose).toHaveBeenCalledTimes(1);
	});

	it("disposes after handler failure without replacing the handler error", async () => {
		const state = setup();
		const failure = new Error("handler failed");
		await expect(
			runScopedWorkerRequest(
				new Request("https://example.test/"),
				{},
				state.context,
				state.scope,
				async () => {
					throw failure;
				},
			),
		).rejects.toBe(failure);
		await Promise.all(state.tasks);
		expect(state.dispose).toHaveBeenCalledTimes(1);
	});

	it("releases resources when background work rejects", async () => {
		const state = setup();
		const background = deferred<void>();
		await runScopedWorkerRequest(
			new Request("https://example.test/"),
			{},
			state.context,
			state.scope,
			async (_request, _environment, context) => {
				context.waitUntil(background.promise);
				return new Response(null, { status: 204 });
			},
		);
		background.reject(new Error("background failed"));
		await Promise.allSettled(state.tasks);
		expect(state.dispose).toHaveBeenCalledTimes(1);
	});

	it("isolates concurrent requests even when their streams are consumed in reverse order", async () => {
		const storage = new AsyncLocalStorage<string>();
		const tasks: Promise<unknown>[] = [];
		const createResponse = (id: string) =>
			runScopedWorkerRequest(
				new Request(`https://example.test/${id}`),
				{},
				{ waitUntil: (promise) => tasks.push(promise), passThroughOnException() {} },
				{ run: (callback) => storage.run(id, callback), dispose: async () => {} },
				async () =>
					new Response(
						new ReadableStream(
							{
								pull(controller) {
									controller.enqueue(new TextEncoder().encode(storage.getStore()));
									controller.close();
								},
							},
							{ highWaterMark: 0 },
						),
					),
			);
		const [first, second] = await Promise.all([createResponse("first"), createResponse("second")]);
		expect(await second.text()).toBe("second");
		expect(await first.text()).toBe("first");
		await Promise.all(tasks);
		expect(storage.getStore()).toBeUndefined();
	});

	it("disposes after a streamed response fails", async () => {
		const state = setup();
		const failure = new Error("stream failed");
		const response = await runScopedWorkerRequest(
			new Request("https://example.test/"),
			{},
			state.context,
			state.scope,
			async () =>
				new Response(
					new ReadableStream(
						{
							pull(controller) {
								controller.error(failure);
							},
						},
						{ highWaterMark: 0 },
					),
				),
		);
		await expect(response.text()).rejects.toBe(failure);
		await Promise.all(state.tasks);
		expect(state.dispose).toHaveBeenCalledTimes(1);
	});
});
