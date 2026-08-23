import { describe, expect, it } from "vitest";

import { dispatchRouteFor, parseMediaQueueLimits, providerQueueKey } from "./queues";

describe("media dispatch queues", () => {
	it("never routes video generation through the image task", () => {
		expect(dispatchRouteFor("video", "fal", "fal-ai/fast-video")).toMatchObject({
			taskId: expect.stringContaining("video-fal-fal-ai_fast-video"),
			queueName: expect.stringContaining("video"),
		});
		expect(dispatchRouteFor("image", "fal", "fal-ai/flux/schnell").taskId).toContain("image-fal");
	});

	it("gives distinct provider and model routes distinct queue keys and limits", () => {
		const limits = parseMediaQueueLimits({
			MEDIA_PROVIDER_QUEUE_LIMITS: "fal=7,replicate=5",
			MEDIA_MODEL_QUEUE_LIMITS: `${providerQueueKey("fal", "fal-ai/fast-video")}=1,${providerQueueKey("fal", "fal-ai/flux/schnell")}=3`,
		});
		const videoKey = providerQueueKey("fal", "fal-ai/fast-video");
		const imageKey = providerQueueKey("fal", "fal-ai/flux/schnell");
		expect(videoKey).not.toBe(imageKey);
		expect(limits.providers.fal).toBe(7);
		expect(limits.models[videoKey]).toBe(1);
		expect(limits.models[imageKey]).toBe(3);
	});

	it("routes the published quality-video Kie model to a dedicated Trigger task", () => {
		expect(dispatchRouteFor("video", "kie", "veo3")).toEqual({
			taskId: "media-dispatch-video-kie-veo3",
			queueName: "media-video-kie-veo3",
		});
	});
});
