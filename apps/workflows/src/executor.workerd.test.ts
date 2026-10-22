import { signRequest } from "@repo/jobs/orchestration/auth";
import { OutboxDeliveryPendingError } from "@repo/jobs/orchestration/contracts";
import { WORKER_EXECUTORS } from "@repo/jobs/orchestration/worker-executors";
import { createMultipartUpload } from "@repo/storage";
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { createWorkflowBindingDispatcher } from "./dispatch";
import type { WorkersEnvironment } from "./workers";

describe("complete Workers executor module", () => {
	it("authenticates the stateless service before opening any database scope", async () => {
		const control = (env as unknown as WorkersEnvironment).JOBS_CONTROL!;
		const response = await control.fetch(
			new Request("https://executor/internal/execute", { method: "POST", body: "{}" }),
		);
		expect(response.status).toBe(401);
	});
	it.each([
		{ taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
		{ taskId: "media-deliver-outbox", payload: {} },
		{
			taskId: "media-verify-upload",
			payload: { assetId: "asset", allowQuarantinedReverification: true },
		},
	])("rejects $taskId outside its stateless control boundary", async (request) => {
		const control = (env as unknown as WorkersEnvironment).JOBS_CONTROL!;
		const body = JSON.stringify({
			request,
			context: { attempt: 1, maxAttempts: 5, runId: "control-route-test" },
		});
		const response = await control.fetch(
			new Request("https://executor/internal/execute", {
				method: "POST",
				body,
				headers: await signRequest(
					"test-only-32-character-shared-secret",
					"POST",
					"/internal/execute",
					body,
				),
			}),
		);
		expect(response.status).toBe(400);
	});
	it("authenticates the stateless transfer service and refuses a paid submit", async () => {
		const transfer = (env as unknown as WorkersEnvironment).JOBS_TRANSFER!;
		expect(
			(
				await transfer.fetch(
					new Request("https://executor/internal/execute", { method: "POST", body: "{}" }),
				)
			).status,
		).toBe(401);
		const body = JSON.stringify({
			request: {
				taskId: "media-dispatch-image-kie-nano-banana-2",
				payload: { jobId: "job", version: 0 },
			},
			context: { attempt: 1, maxAttempts: 1, runId: "transfer-route-test" },
		});
		const response = await transfer.fetch(
			new Request("https://executor/internal/execute", {
				method: "POST",
				body,
				headers: await signRequest(
					"test-only-32-character-shared-secret",
					"POST",
					"/internal/execute",
					body,
				),
			}),
		);
		expect(response.status).toBe(400);
	});
	it.each(Object.values(WORKER_EXECUTORS).map((policy) => policy.name))(
		"authenticates the %s executor before using runtime resources",
		async (name) => {
			const jobs = (env as unknown as WorkersEnvironment).JOBS_EXECUTOR;
			const response = await jobs
				.get(jobs.idFromName(name))
				.fetch(new Request("https://executor/internal/execute", { method: "POST", body: "{}" }));
			expect(response.status).toBe(401);
		},
	);
	it.each(["jobs-control", "jobs-maintenance"])(
		"rejects a heavy transfer sent to %s using the real Durable Object identity",
		async (name) => {
			const jobs = (env as unknown as WorkersEnvironment).JOBS_EXECUTOR;
			const body = JSON.stringify({
				request: { taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
				context: { attempt: 1, maxAttempts: 5, runId: "routing-test" },
			});
			const response = await jobs.get(jobs.idFromName(name)).fetch(
				new Request("https://executor/internal/execute", {
					method: "POST",
					body,
					headers: await signRequest(
						"test-only-32-character-shared-secret",
						"POST",
						"/internal/execute",
						body,
					),
				}),
			);
			expect(response.status).toBe(400);
		},
	);
	it("parses an R2 multipart XML response without browser DOM globals", async () => {
		vi.stubEnv("S3_ENDPOINT", "https://storage.test");
		vi.stubEnv("S3_REGION", "auto");
		vi.stubEnv("S3_ACCESS_KEY_ID", "test-access");
		vi.stubEnv("S3_SECRET_ACCESS_KEY", "test-secret");
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						'<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>media</Bucket><Key>users/test/staging/output.jpg</Key><UploadId>workerd-upload-1</UploadId></InitiateMultipartUploadResult>',
						{ headers: { "Content-Type": "application/xml" } },
					),
			),
		);
		try {
			await expect(
				createMultipartUpload({
					bucket: "media",
					key: "users/test/staging/output.jpg",
					contentType: "image/jpeg",
				}),
			).resolves.toEqual({ uploadId: "workerd-upload-1" });
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
	});
	it("dispatches child workflows inside workerd and preserves pending completion", async () => {
		const dispatch = createWorkflowBindingDispatcher({
			url: "https://jobs.example/internal/dispatch",
			secret: "test-only-32-character-shared-secret",
			workflows: {
				async createBatch() {},
				async get() {
					return {
						async status() {
							return { status: "queued" };
						},
						async restart() {},
					};
				},
			},
		});
		await expect(
			dispatch(
				"media-verify-upload",
				{ assetId: "test-asset" },
				{
					idempotencyKey: "workerd-nested-dispatch",
					requireCompletion: true,
				},
			),
		).rejects.toBeInstanceOf(OutboxDeliveryPendingError);
	});
	it("loads all business dependencies and rejects unsigned execution in workerd", async () => {
		const jobs = (env as unknown as WorkersEnvironment).JOBS_EXECUTOR;
		const response = await jobs
			.get(jobs.idFromName("jobs-primary"))
			.fetch(new Request("https://executor/internal/execute", { method: "POST", body: "{}" }));
		expect(response.status).toBe(401);
	});
	it("validates signed tasks before requiring database or Images bindings", async () => {
		const jobs = (env as unknown as WorkersEnvironment).JOBS_EXECUTOR;
		const body = JSON.stringify({ request: { taskId: "unknown", payload: {} }, context: {} });
		const response = await jobs.get(jobs.idFromName("jobs-primary")).fetch(
			new Request("https://executor/internal/execute", {
				method: "POST",
				body,
				headers: await signRequest(
					"test-only-32-character-shared-secret",
					"POST",
					"/internal/execute",
					body,
				),
			}),
		);
		expect(response.status).toBe(400);
	});
});
