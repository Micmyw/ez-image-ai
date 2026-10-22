import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ ack: vi.fn() }));
vi.mock("@repo/database/media-job-notifications", () => ({
	acknowledgePublishedMediaJobNotification: db.ack,
}));

import { runWithMediaJobEvents } from "./context";
import { deliverMediaJobNotification, publishCommittedMediaJobNotification } from "./publish";

const event = { eventId: `mju_${"a".repeat(64)}`, jobId: "job", version: "asset:a:g1:ready" };
const namespace = (send: (request: Request) => Promise<Response>) => ({
	idFromName: (name: string) => name,
	get: () => ({ fetch: send }),
});
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("MEDIA_JOB_EVENTS_ENABLED", "true");
	db.ack.mockResolvedValue(undefined);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("durable notification publication", () => {
	it("ACKs only after a matching durable receipt and sends identity fields only", async () => {
		const send = vi.fn(async (request: Request) => {
			expect(db.ack).not.toHaveBeenCalled();
			expect(await request.json()).toEqual(event);
			return Response.json({ persisted: true, eventId: event.eventId });
		});
		expect(
			await runWithMediaJobEvents(namespace(send), () =>
				publishCommittedMediaJobNotification(event),
			),
		).toBe(true);
		expect(db.ack).toHaveBeenCalledExactlyOnceWith(event, undefined);
	});
	it.each([
		new Response("unavailable", { status: 503 }),
		Response.json({ accepted: true }),
		Response.json({ persisted: true, eventId: "other" }),
	])("keeps the Outbox intent on an unconfirmed delivery", async (response) => {
		expect(
			await runWithMediaJobEvents(
				namespace(async () => response),
				() => publishCommittedMediaJobNotification(event),
			),
		).toBe(false);
		expect(db.ack).not.toHaveBeenCalled();
	});
	it("bounds the fast path while a slow hub leaves the recovery intent pending", async () => {
		vi.useFakeTimers();
		const pending = runWithMediaJobEvents(
			namespace(() => new Promise(() => {})),
			() => publishCommittedMediaJobNotification(event),
		);
		await vi.advanceTimersByTimeAsync(250);
		expect(await pending).toBe(false);
		expect(db.ack).not.toHaveBeenCalled();
	});
	it("stops producers when disabled but still drains accepted events", async () => {
		vi.stubEnv("MEDIA_JOB_EVENTS_ENABLED", "false");
		const send = vi.fn(async (request: Request) => {
			expect(await request.json()).toEqual(event);
			return Response.json({ persisted: true, eventId: event.eventId });
		});
		expect(
			await runWithMediaJobEvents(namespace(send), () =>
				publishCommittedMediaJobNotification(event),
			),
		).toBe(false);
		expect(send).not.toHaveBeenCalled();
		await runWithMediaJobEvents(namespace(send), () =>
			deliverMediaJobNotification({ ...event, privateUrl: "must-not-leave" }),
		);
		expect(send).toHaveBeenCalledTimes(1);
	});
});
