import { hydrateVideoRuntimeEnvironment } from "@repo/config/video-runtime-environment";
import { workerExecutorLane } from "@repo/jobs/orchestration/worker-executors";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
	createRuntimeExecutionHandler,
	type RuntimeExecutionEnvironment,
} from "./runtime-execution";

/** Request-owned control work; the platform schedules requests, not one global DO. */
export class ControlExecutor extends WorkerEntrypoint<RuntimeExecutionEnvironment> {
	override fetch(request: Request): Promise<Response> {
		hydrateVideoRuntimeEnvironment(this.env);
		return createRuntimeExecutionHandler(this.env, {
			waitUntil: (work) => this.ctx.waitUntil(work),
			admission: "request",
			acceptsTask: (task) => workerExecutorLane(task) === "control",
			onEvent: (event) =>
				console.info("job.executor", { executor: "jobs-control-request", ...event }),
		})(request);
	}
}
