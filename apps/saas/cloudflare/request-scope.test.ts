import { AsyncLocalStorage } from "node:async_hooks";

import {
	getRequestDefer,
	runWithRequestDefer,
	type RequestDefer,
} from "@repo/utils/request-lifecycle";
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
	it("returns admission before a registered wake and holds DB scope after response cancellation", async () => {
		const state = setup();
		const wake = deferred<void>();
		let registered!: Promise<unknown>;
		const response = await runScopedWorkerRequest(
			new Request("https://example.test/submit"),
			{},
			state.context,
			state.scope,
			async (_request, _environment, context) =>
				runWithRequestDefer(
					(task) => context.waitUntil(task),
					async () => {
						registered = wake.promise.then(() => {
							expect(state.storage.getStore()).toBe("request-database");
							expect(state.dispose).not.toHaveBeenCalled();
						});
						getRequestDefer()!(registered);
						return new Response("accepted", { status: 201 });
					},
				),
		);
		expect(response.status).toBe(201);
		await response.body!.cancel("response lost");
		expect(state.dispose).not.toHaveBeenCalled();
		wake.resolve();
		await registered;
		await Promise.all(state.tasks);
		expect(state.dispose).toHaveBeenCalledTimes(1);
		expect(getRequestDefer()).toBeUndefined();
	});

	it("isolates request-local wake and derived task registration across concurrent requests", async () => {
		const storage = new AsyncLocalStorage<string>();
		const create = async (id: string) => {
			const wake = deferred<void>();
			const child = deferred<void>();
			const tasks: Promise<unknown>[] = [];
			const dispose = vi.fn(async () => {
				expect(storage.getStore()).toBe(id);
			});
			await runScopedWorkerRequest(
				new Request(`https://example.test/${id}`),
				{},
				{ waitUntil: (task) => tasks.push(task), passThroughOnException() {} },
				{ run: (callback) => storage.run(id, callback), dispose },
				async (_request, _environment, context) =>
					runWithRequestDefer(
						(task) => context.waitUntil(task),
						async () => {
							getRequestDefer()!(
								wake.promise.then(() => {
									expect(storage.getStore()).toBe(id);
									getRequestDefer()!(
										child.promise.then(() => {
											expect(storage.getStore()).toBe(id);
											expect(dispose).not.toHaveBeenCalled();
										}),
									);
								}),
							);
							return new Response(null, { status: 204 });
						},
					),
			);
			return { wake, child, dispose, tasks };
		};
		const [a, b] = await Promise.all([create("a"), create("b")]);
		b.wake.resolve();
		await b.wake.promise;
		await Promise.resolve();
		b.child.resolve();
		await Promise.all(b.tasks);
		expect(b.dispose).toHaveBeenCalledTimes(1);
		expect(a.dispose).not.toHaveBeenCalled();
		a.wake.resolve();
		await a.wake.promise;
		await Promise.resolve();
		a.child.reject(new Error("child failed"));
		await Promise.allSettled(a.tasks);
		expect(a.dispose).toHaveBeenCalledTimes(1);
		expect(getRequestDefer()).toBeUndefined();
	});

	it("releases scope and does not admit a request when initial lifetime registration throws", async () => {
		const state = setup();
		const failure = new Error("registration unavailable");
		state.context.waitUntil = () => {
			throw failure;
		};
		const handler = vi.fn();
		await expect(
			runScopedWorkerRequest(
				new Request("https://example.test/"),
				{},
				state.context,
				state.scope,
				handler,
			),
		).rejects.toBe(failure);
		expect(handler).not.toHaveBeenCalled();
		expect(state.dispose).toHaveBeenCalledTimes(1);
	});

	it("retains pending tasks when the platform rejects secondary registration", async () => {
		const state = setup();
		const wake = deferred<void>();
		state.context.waitUntil = vi
			.fn()
			.mockImplementationOnce((task) => state.tasks.push(task))
			.mockImplementation(() => {
				throw new Error("registration failed");
			});
		await runScopedWorkerRequest(
			new Request("https://example.test/"),
			{},
			state.context,
			state.scope,
			async (_request, _environment, context) => {
				expect(() => context.waitUntil(wake.promise)).toThrow("registration failed");
				return new Response(null, { status: 204 });
			},
		);
		expect(state.dispose).not.toHaveBeenCalled();
		wake.resolve();
		await Promise.all(state.tasks);
		expect(state.dispose).toHaveBeenCalledTimes(1);
	});

	it("shares the registrar across independent server module copies", async () => {
		vi.resetModules();
		const otherCopy = await import("@repo/utils/request-lifecycle");
		const register = vi.fn<RequestDefer>();
		await runWithRequestDefer(register, async () => {
			await Promise.resolve();
			expect(otherCopy.getRequestDefer()).toBe(register);
		});
		expect(otherCopy.getRequestDefer()).toBeUndefined();
	});

	it("rejects late registration after disposal", async () => {
		const state = setup();
		let context!: WorkerExecutionContext;
		await runScopedWorkerRequest(
			new Request("https://example.test/"),
			{},
			state.context,
			state.scope,
			async (_request, _environment, scoped) => {
				context = scoped;
				return new Response(null, { status: 204 });
			},
		);
		await Promise.all(state.tasks);
		expect(() => context.waitUntil(Promise.resolve())).toThrow("WORKER_REQUEST_SCOPE_CLOSED");
		expect(state.dispose).toHaveBeenCalledTimes(1);
	});

	it("finishes cancellation during an outstanding stream read while waiting for wake work", async () => {
		const state = setup();
		const wake = deferred<void>();
		const cancel = vi.fn();
		const response = await runScopedWorkerRequest(
			new Request("https://example.test/"),
			{},
			state.context,
			state.scope,
			async (_request, _environment, context) => {
				context.waitUntil(wake.promise);
				return new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }));
			},
		);
		const reader = response.body!.getReader();
		const read = reader.read();
		await Promise.resolve();
		await reader.cancel("client disconnected");
		await read;
		expect(cancel).toHaveBeenCalledWith("client disconnected");
		expect(state.dispose).not.toHaveBeenCalled();
		wake.resolve();
		await Promise.all(state.tasks);
		expect(state.dispose).toHaveBeenCalledTimes(1);
	});
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
