import { afterEach, describe, expect, it, vi } from "vitest";

import type { VideoWorkflowBinding } from "./contracts";
import {
	acceptVideoModerationWebhook,
	createVideoModerationWebhookHandler,
	notifyPendingVideoModerationEvents,
} from "./moderation-webhooks";

function fixture() {
	const fetcher = vi.fn<typeof fetch>();
	vi.stubGlobal("fetch", fetcher);
	const persist = vi.fn(async () => ({ eventId: "old-event", replayed: false, notified: false }));
	const markNotified = vi.fn(async () => {});
	const sendEvent = vi.fn(async () => {});
	const get = vi.fn(async () => ({ sendEvent, status: async () => ({ status: "waiting" }) }));
	return {
		fetcher,
		persist,
		markNotified,
		sendEvent,
		get,
		binding: { get, create: vi.fn() } as VideoWorkflowBinding,
		environment: { VIDEO_V1_MODERATION_WEBHOOK_SECRET: "retired-local-fixture" },
	};
}
function request() {
	return new Request("https://example.com/api/webhooks/video/moderation", {
		method: "POST",
		headers: { "content-type": "application/json", "sightengine-signature": "retired-signature" },
		body: JSON.stringify({ media: { id: "old-task" }, data: { status: "finished" } }),
	});
}
afterEach(() => vi.unstubAllGlobals());

describe("retired video moderation callbacks", () => {
	it("returns 410 despite historical configuration and never persists or wakes work", async () => {
		const f = fixture();
		const response = await createVideoModerationWebhookHandler(f)(request());
		expect(response.status).toBe(410);
		expect(await response.json()).toEqual({ code: "VIDEO_MODERATION_CALLBACK_RETIRED" });
		expect(f.persist).not.toHaveBeenCalled();
		expect(f.get).not.toHaveBeenCalled();
		expect(f.markNotified).not.toHaveBeenCalled();
		expect(f.fetcher).not.toHaveBeenCalled();
	});
	it("rejects direct compatibility callers before any external or database operation", async () => {
		const f = fixture();
		await expect(acceptVideoModerationWebhook(request(), f)).rejects.toMatchObject({
			status: 410,
			message: "VIDEO_MODERATION_CALLBACK_RETIRED",
		});
		expect(f.persist).not.toHaveBeenCalled();
		expect(f.sendEvent).not.toHaveBeenCalled();
		expect(f.fetcher).not.toHaveBeenCalled();
	});
	it("does not scan or notify a retired durable inbox even with pending events", async () => {
		const f = fixture();
		const events = vi.fn(async () => [
			{
				eventId: "old-event",
				jobId: "job",
				workflowInstanceId: "video-v1-job",
				replayed: false,
				notified: false,
			},
		]);
		expect(await notifyPendingVideoModerationEvents({ ...f, events })).toEqual({
			notified: 0,
			failed: 0,
		});
		expect(events).not.toHaveBeenCalled();
		expect(f.get).not.toHaveBeenCalled();
		expect(f.markNotified).not.toHaveBeenCalled();
		expect(f.fetcher).not.toHaveBeenCalled();
	});
});
