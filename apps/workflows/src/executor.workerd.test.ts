import { signRequest } from "@repo/jobs/orchestration/auth";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { WorkersEnvironment } from "./workers";

describe("complete Workers executor module", () => {
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
