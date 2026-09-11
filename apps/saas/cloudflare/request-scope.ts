export interface WorkerExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
}

export interface WorkerRequestScope {
	run<T>(callback: () => T): T;
	dispose(): Promise<unknown>;
}

export async function runScopedWorkerRequest<Environment>(
	request: Request,
	environment: Environment,
	executionContext: WorkerExecutionContext,
	scope: WorkerRequestScope,
	handler: (
		request: Request,
		environment: Environment,
		executionContext: WorkerExecutionContext,
	) => Promise<Response>,
): Promise<Response> {
	const pending = new Set<Promise<unknown>>();
	let finishResponse!: () => void;
	const responseFinished = new Promise<void>((resolve) => {
		finishResponse = resolve;
	});
	const lifetime = responseFinished.then(async () => {
		// A registered task can register more work before it settles.
		while (pending.size) await Promise.allSettled([...pending]);
		await scope.run(() => scope.dispose());
	});
	executionContext.waitUntil(lifetime);

	const context = new Proxy(executionContext, {
		get(target, property) {
			if (property === "waitUntil") {
				return (promise: Promise<unknown>) => {
					const task = Promise.resolve(promise);
					pending.add(task);
					void task.then(
						() => pending.delete(task),
						() => pending.delete(task),
					);
					target.waitUntil(task);
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	try {
		const response = await scope.run(() => handler(request, environment, context));
		if (!response.body) {
			finishResponse();
			return response;
		}
		const reader = response.body.getReader();
		const finishStream = () => {
			reader.releaseLock();
			finishResponse();
		};
		const body = new ReadableStream<Uint8Array>(
			{
				async pull(controller) {
					try {
						const chunk = await scope.run(() => reader.read());
						if (chunk.done) {
							controller.close();
							finishStream();
						} else {
							controller.enqueue(chunk.value);
						}
					} catch (error) {
						controller.error(error);
						finishStream();
					}
				},
				async cancel(reason) {
					try {
						await scope.run(() => reader.cancel(reason));
					} finally {
						finishStream();
					}
				},
			},
			{ highWaterMark: 0 },
		);
		return new Response(body, response);
	} catch (error) {
		finishResponse();
		throw error;
	}
}
