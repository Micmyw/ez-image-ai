import { AsyncLocalStorage } from "node:async_hooks";

export interface MediaJobEventsNamespace {
	idFromName(name: string): unknown;
	get(id: unknown): { fetch(request: Request): Promise<Response> };
}

// The outer website Worker and OpenNext can have separate module copies.
const key = Symbol.for("ezpic.media-job-events.binding");
const globals = globalThis as typeof globalThis & {
	[key]?: AsyncLocalStorage<MediaJobEventsNamespace | undefined>;
};
const context = (globals[key] ??= new AsyncLocalStorage<MediaJobEventsNamespace | undefined>());

export function runWithMediaJobEvents<T>(
	binding: MediaJobEventsNamespace | undefined,
	callback: () => T,
): T {
	return context.run(binding, callback);
}

export function getMediaJobEventsBinding(): MediaJobEventsNamespace | undefined {
	return context.getStore();
}

export function mediaJobEventsStub(binding: MediaJobEventsNamespace, jobId: string) {
	return binding.get(binding.idFromName(`media-job:${jobId}`));
}
