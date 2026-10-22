import { AsyncLocalStorage } from "node:async_hooks";

export interface JobDispatchBinding {
	fetch(request: Request): Promise<Response>;
}

// The outer Worker and OpenNext may bundle their own module copies. Share only
// the request context, never an unscoped service binding across requests.
const key = Symbol.for("ezpic.jobs.dispatch-binding");
const globals = globalThis as typeof globalThis & {
	[key]?: AsyncLocalStorage<JobDispatchBinding>;
};
const context = (globals[key] ??= new AsyncLocalStorage<JobDispatchBinding>());

export function runWithJobDispatchBinding<T>(
	binding: JobDispatchBinding | undefined,
	callback: () => T,
): T {
	return binding ? context.run(binding, callback) : callback();
}

export function getJobDispatchBinding(): JobDispatchBinding | undefined {
	return context.getStore();
}
