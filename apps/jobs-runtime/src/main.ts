import { db } from "@repo/database/client";
import { executeTask } from "@repo/jobs/orchestration/executor";
import { executePollingTick } from "@repo/jobs/orchestration/polling";

import { createRuntimeServer } from "./server";

const server = createRuntimeServer({
	secret: process.env.WORKFLOWS_DISPATCH_SECRET ?? "",
	execute: executeTask,
	poll: executePollingTick,
	maxActive: Number(process.env.JOBS_RUNTIME_CONCURRENCY ?? "4"),
});
server.listen(Number(process.env.PORT ?? "8080"), "0.0.0.0");

let stopping = false;
function shutdown() {
	if (stopping) return;
	stopping = true;
	// Stop admission and wait for active work. Container idle shutdown is only
	// requested after /health reports no active work. Crash recovery stays in DB.
	server.close(() => {
		void db.$disconnect().then(() => {
			process.exitCode = 0;
		});
	});
	server.closeIdleConnections();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
