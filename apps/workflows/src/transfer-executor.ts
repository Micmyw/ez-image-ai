import { hydrateVideoRuntimeEnvironment } from "@repo/config/video-runtime-environment";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
	createRuntimeExecutionHandler,
	type RuntimeExecutionEnvironment,
} from "./runtime-execution";

/** URL-only transfers admitted by the database and bounded by streaming storage. */
export class TransferExecutor extends WorkerEntrypoint<RuntimeExecutionEnvironment> {
	override fetch(request: Request): Promise<Response> {
		hydrateVideoRuntimeEnvironment(this.env);
		return createRuntimeExecutionHandler(this.env, {
			waitUntil: (work) => this.ctx.waitUntil(work),
			admission: "request",
			streamingTransfersOnly: true,
			acceptsTask: (task) => task.taskId === "media-finalize-generation",
			onEvent: (event) =>
				console.info("job.executor", { executor: "jobs-transfer-request", ...event }),
		})(request);
	}
}
