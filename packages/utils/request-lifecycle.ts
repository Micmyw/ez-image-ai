import { AsyncLocalStorage } from "node:async_hooks";

/** Register already-started short work with the current request's managed lifetime. */
export type RequestDefer = (promise: Promise<unknown>) => void;

// OpenNext's server bundle and the Worker entry may contain separate module copies.
// Share the storage, never the mutable current request or its execution context.
const contextKey = Symbol.for("ezpic.request.defer.v1");
const contextGlobals = globalThis as typeof globalThis & {
	[contextKey]?: AsyncLocalStorage<RequestDefer>;
};
const requestContext = (contextGlobals[contextKey] ??= new AsyncLocalStorage<RequestDefer>());

export function getRequestDefer(): RequestDefer | undefined {
	return requestContext.getStore();
}

export function runWithRequestDefer<T>(defer: RequestDefer, callback: () => T): T {
	return requestContext.run(defer, callback);
}
