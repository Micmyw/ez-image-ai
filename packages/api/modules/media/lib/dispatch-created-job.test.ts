import { describe, expect, it, vi } from "vitest";

import { dispatchCreatedJobBestEffort } from "./dispatch-created-job";

describe("dispatchCreatedJobBestEffort", () => {
	it("triggers the committed job immediately on its private dispatch route", async () => {
		const dispatch = vi.fn(async () => undefined);
		const resolveRoute = vi.fn(async () => ({
			taskId: "media-dispatch-video-kie-veo3",
			provider: "kie" as const,
			providerModelId: "veo3",
		}));

		await dispatchCreatedJobBestEffort(
			{ jobId: "job_1", version: 0, replayed: false, serviceClass: "STANDARD" },
			{ resolveRoute, dispatch },
		);

		expect(resolveRoute).toHaveBeenCalledWith("job_1");
		expect(dispatch).toHaveBeenCalledWith(
			"media-dispatch-video-kie-veo3",
			{
				jobId: "job_1",
				version: 0,
				provider: "kie",
				providerModelId: "veo3",
			},
			{ idempotencyKey: "generation:job_1:0" },
		);
	});

	it("keeps the request successful when immediate delivery fails so the outbox cron can recover", async () => {
		const warn = vi.fn();

		await expect(
			dispatchCreatedJobBestEffort(
				{ jobId: "job_2", version: 0, replayed: false, serviceClass: "STANDARD" },
				{
					resolveRoute: async () => ({
						taskId: "media-dispatch-image-fal",
						provider: "fal",
						providerModelId: "fal-ai/flux/schnell",
					}),
					dispatch: async () => {
						throw new Error("Workflows unavailable");
					},
					warn,
				},
			),
		).resolves.toEqual({ delivered: false });
		expect(warn).toHaveBeenCalledOnce();
	});

	it("keeps the request successful when no executable route remains", async () => {
		const dispatch = vi.fn(async () => undefined);
		const warn = vi.fn();

		await expect(
			dispatchCreatedJobBestEffort(
				{ jobId: "job_3", version: 0, replayed: false, serviceClass: "STANDARD" },
				{ resolveRoute: async () => null, dispatch, warn },
			),
		).resolves.toEqual({ delivered: false });

		expect(dispatch).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			"Immediate generation dispatch failed; outbox recovery remains pending",
			expect.objectContaining({ jobId: "job_3" }),
		);
	});

	it("does not duplicate immediate delivery for an idempotent replay", async () => {
		const dispatch = vi.fn(async () => undefined);
		await dispatchCreatedJobBestEffort(
			{ jobId: "job_1", version: 0, replayed: true, serviceClass: "STANDARD" },
			{ resolveRoute: vi.fn(), dispatch },
		);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("never sends GUEST_SLOW through the immediate dispatch helper", async () => {
		const dispatch = vi.fn(async () => undefined);
		const guestJob = {
			jobId: "guest-job-1",
			version: 0,
			replayed: false,
			serviceClass: "GUEST_SLOW" as const,
		};
		const dependencies = {
			resolveRoute: vi.fn(async () => ({
				taskId: "media-dispatch-image-fal",
				provider: "fal" as const,
				providerModelId: "fal-ai/flux/schnell",
			})),
			dispatch,
		};

		await expect(dispatchCreatedJobBestEffort(guestJob, dependencies)).rejects.toThrow(
			"GUEST_DISPATCH_REQUIRES_ADMISSION",
		);
		expect(dispatch).not.toHaveBeenCalled();
	});
});
