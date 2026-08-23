import { describe, expect, it, vi } from "vitest";

import { dispatchCreatedJobBestEffort } from "./dispatch-created-job";

describe("dispatchCreatedJobBestEffort", () => {
	it("triggers the committed job immediately on its private dispatch route", async () => {
		const trigger = vi.fn(async () => undefined);
		const resolveRoute = vi.fn(async () => ({
			taskId: "media-dispatch-video-kie-veo3",
			provider: "kie" as const,
			providerModelId: "veo3",
		}));

		await dispatchCreatedJobBestEffort(
			{ jobId: "job_1", version: 0, replayed: false },
			{ resolveRoute, trigger },
		);

		expect(resolveRoute).toHaveBeenCalledWith("job_1");
		expect(trigger).toHaveBeenCalledWith("media-dispatch-video-kie-veo3", {
			jobId: "job_1",
			version: 0,
			provider: "kie",
			providerModelId: "veo3",
		});
	});

	it("keeps the request successful when immediate delivery fails so the outbox cron can recover", async () => {
		const warn = vi.fn();

		await expect(
			dispatchCreatedJobBestEffort(
				{ jobId: "job_2", version: 0, replayed: false },
				{
					resolveRoute: async () => ({
						taskId: "media-dispatch-image-fal",
						provider: "fal",
						providerModelId: "fal-ai/flux/schnell",
					}),
					trigger: async () => {
						throw new Error("Trigger unavailable");
					},
					warn,
				},
			),
		).resolves.toEqual({ delivered: false });
		expect(warn).toHaveBeenCalledOnce();
	});

	it("keeps the request successful when no executable route remains", async () => {
		const trigger = vi.fn(async () => undefined);
		const warn = vi.fn();

		await expect(
			dispatchCreatedJobBestEffort(
				{ jobId: "job_3", version: 0, replayed: false },
				{ resolveRoute: async () => null, trigger, warn },
			),
		).resolves.toEqual({ delivered: false });

		expect(trigger).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			"Immediate generation dispatch failed; outbox recovery remains pending",
			expect.objectContaining({ jobId: "job_3" }),
		);
	});

	it("does not duplicate immediate delivery for an idempotent replay", async () => {
		const trigger = vi.fn(async () => undefined);
		await dispatchCreatedJobBestEffort(
			{ jobId: "job_1", version: 0, replayed: true },
			{ resolveRoute: vi.fn(), trigger },
		);
		expect(trigger).not.toHaveBeenCalled();
	});
});
