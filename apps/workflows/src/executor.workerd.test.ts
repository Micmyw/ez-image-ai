import { signRequest } from "@repo/jobs/orchestration/auth";
import { OutboxDeliveryPendingError } from "@repo/jobs/orchestration/contracts";
import { createMultipartUpload } from "@repo/storage";
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { createWorkflowBindingDispatcher } from "./dispatch";
import type { WorkersEnvironment } from "./workers";

describe("complete Workers executor module", () => {
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
