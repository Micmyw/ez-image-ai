import { AsyncLocalStorage } from "node:async_hooks";

import type { VideoV1Bindings } from "@repo/config/video-v1";

import type { VideoWorkflowBinding } from "./contracts";

// OpenNext and its outer Worker may bundle separate copies. Share the ALS,
// never an unscoped mutable binding, just like the database request context.
const key = Symbol.for("ezpic.video-v1.workflow-binding");
const globals = globalThis as typeof globalThis & {
	[key]?: AsyncLocalStorage<{ binding: VideoWorkflowBinding; readiness: VideoV1Bindings }>;
};
const context = (globals[key] ??= new AsyncLocalStorage<{
	binding: VideoWorkflowBinding;
	readiness: VideoV1Bindings;
}>());

export function runWithVideoWorkflowBinding<T>(
	binding: VideoWorkflowBinding,
	callback: () => T,
	readiness: VideoV1Bindings = {},
): T {
	return context.run({ binding, readiness: { ...readiness, workflow: true } }, callback);
}

export function getVideoWorkflowBinding(): VideoWorkflowBinding | undefined {
	return context.getStore()?.binding;
}

export function getVideoWorkflowReadinessBindings(): VideoV1Bindings {
	return context.getStore()?.readiness ?? {};
}
