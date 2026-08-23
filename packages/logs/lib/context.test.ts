import { describe, expect, it } from "vitest";

import { getLogContext, withLogContext } from "./context";

describe("withLogContext", () => {
	it("propagates and composes request and generation correlation fields across awaits", async () => {
		await withLogContext(
			{
				requestId: "request-1",
				traceId: "trace-1",
				deploymentVersion: "release-1",
			},
			async () => {
				await Promise.resolve();
				expect(getLogContext()).toEqual({
					requestId: "request-1",
					traceId: "trace-1",
					deploymentVersion: "release-1",
				});

				await withLogContext(
					{
						generationJobId: "job-1",
						attemptId: "attempt-1",
						provider: "replicate",
						productModelKey: "image-standard",
						pricingVersion: "2026-08",
					},
					async () => {
						expect(getLogContext()).toMatchObject({
							requestId: "request-1",
							traceId: "trace-1",
							generationJobId: "job-1",
							attemptId: "attempt-1",
							provider: "replicate",
							productModelKey: "image-standard",
							pricingVersion: "2026-08",
						});
					},
				);
			},
		);

		expect(getLogContext()).toEqual({});
	});
});
