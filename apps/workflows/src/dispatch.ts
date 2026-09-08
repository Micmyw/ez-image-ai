import { readBoundedBody, verifyRequest, workflowInstanceId } from "@repo/jobs/orchestration/auth";
import type { TaskRequest } from "@repo/jobs/orchestration/contracts";
import { parseTaskRequest } from "@repo/jobs/orchestration/registry";

export type JobsParams =
	| { kind: "task"; request: TaskRequest }
	| { kind: "maintenance"; timestamp: number };
export interface WorkflowCreator {
	createBatch(
		batch: {
			id: string;
			params: JobsParams;
			retention?: { successRetention: "1 day"; errorRetention: "7 days" };
		}[],
	): Promise<unknown>;
	get(id: string): Promise<{ status(): Promise<{ status: string }>; restart(): Promise<void> }>;
}

export async function handleDispatch(
	request: Request,
	secret: string,
	workflows: WorkflowCreator,
): Promise<Response> {
	const url = new URL(request.url);
	if (request.method !== "POST" || url.pathname !== "/internal/dispatch" || url.search)
		return new Response("Not found", { status: 404 });
	if (!secret || secret.length < 32) return new Response("Unavailable", { status: 503 });
	let body: string;
	try {
		body = await readBoundedBody(request);
	} catch {
		return new Response("Invalid body", { status: 413 });
	}
	if (!(await verifyRequest(secret, "POST", url.pathname, body, request.headers)))
		return new Response("Unauthorized", { status: 401 });
	let task: TaskRequest;
	let idempotencyKey: string;
	try {
		const value = JSON.parse(body) as Record<string, unknown>;
		if (
			!value ||
			Object.keys(value).some((key) => !["taskId", "payload", "idempotencyKey"].includes(key))
		)
			throw new Error();
		if (
			typeof value.idempotencyKey !== "string" ||
			!value.idempotencyKey ||
			value.idempotencyKey.length > 512
		)
			throw new Error();
		idempotencyKey = value.idempotencyKey;
		task = parseTaskRequest({ taskId: value.taskId, payload: value.payload });
	} catch {
		return new Response("Invalid task", { status: 400 });
	}
	const id = await workflowInstanceId({ idempotencyKey, task });
	try {
		// createBatch is Cloudflare's idempotent create API: duplicate IDs are
		// skipped atomically. A lost HTTP response can safely replay the same body.
		await workflows.createBatch([
			{
				id,
				params: { kind: "task", request: task },
				retention: { successRetention: "1 day", errorRetention: "7 days" },
			},
		]);
		const instance = await workflows.get(id);
		const { status } = await instance.status();
		if (["errored", "terminated"].includes(status)) {
			// Only these read/reconcile handlers can restart the same instance. A
			// generation submission is recovered through its persisted attempt.
			if (
				!["media-poll-generation", "media-reconcile-subscriptions-continuation"].includes(
					task.taskId,
				)
			)
				throw new Error("TERMINAL_WORKFLOW");
			await instance.restart();
		} else if (["unknown", "paused", "waitingForPause"].includes(status))
			throw new Error("WORKFLOW_UNAVAILABLE");
		return Response.json({ accepted: true, completed: status === "complete", id }, { status: 202 });
	} catch {
		return new Response("Dispatch unavailable", { status: 503 });
	}
}
