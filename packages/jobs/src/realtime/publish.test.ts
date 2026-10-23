import { runWithRequestDefer } from "@repo/utils/request-lifecycle";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ ack: vi.fn() }));
vi.mock("@repo/database/media-job-notifications", () => ({
	acknowledgePublishedMediaJobNotification: db.ack,
}));

import { runWithMediaJobEvents } from "./context";
import {
	deliverMediaJobNotification,
	publishCommittedMediaJobNotification,
	publishCommittedMediaJobNotifications,
} from "./publish";

const event = { eventId: `mju_${"a".repeat(64)}`, jobId: "job", version: "asset:a:g1:ready" };
const namespace = (send: (request: Request) => Promise<Response>) => ({
	idFromName: (name: string) => name,
	get: () => ({ fetch: send }),
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
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

describe("committed notification continuation", () => {
	it("starts publication before continuation and retains the delayed receipt and DB ACK", async () => {
		vi.useFakeTimers();
		const receipt = deferred<Response>();
		const ack = deferred<void>();
		const retained: Promise<unknown>[] = [];
		const send = vi.fn(() => receipt.promise);
		db.ack.mockReturnValue(ack.promise);
		await runWithRequestDefer(
			(work) => retained.push(work),
			() =>
				runWithMediaJobEvents(namespace(send), () =>
					publishCommittedMediaJobNotifications([event]),
				),
		);
		// No timer or receipt has advanced, but the Workflow continuation is no longer held.
		expect(send).toHaveBeenCalledOnce();
		expect(retained).toHaveLength(1);
		expect(db.ack).not.toHaveBeenCalled();
		let finished = false;
		const background = retained[0]!.then(() => {
			finished = true;
		});
		receipt.resolve(Response.json({ persisted: true, eventId: event.eventId }));
		await vi.advanceTimersByTimeAsync(0);
		expect(db.ack).toHaveBeenCalledExactlyOnceWith(event, undefined);
		expect(finished).toBe(false);
		ack.resolve();
		await background;
		expect(finished).toBe(true);
	});

	it("leaves a timed-out notification recoverable without holding the continuation", async () => {
		vi.useFakeTimers();
		const retained: Promise<unknown>[] = [];
		const receipt = deferred<Response>();
		const send = vi.fn(() => receipt.promise);
		await runWithRequestDefer(
			(work) => retained.push(work),
			() =>
				runWithMediaJobEvents(namespace(send), () =>
					publishCommittedMediaJobNotifications([event]),
				),
		);
		await vi.advanceTimersByTimeAsync(250);
		await Promise.all(retained);
		expect(db.ack).not.toHaveBeenCalled();
		// A late fast-path receipt cannot ACK after its timeout; the durable consumer retries.
		receipt.resolve(Response.json({ persisted: true, eventId: event.eventId }));
		await receipt.promise;
		expect(db.ack).not.toHaveBeenCalled();
		expect(
			await runWithMediaJobEvents(
				namespace(async () => Response.json({ persisted: true, eventId: event.eventId })),
				() => publishCommittedMediaJobNotification(event),
			),
		).toBe(true);
		expect(db.ack).toHaveBeenCalledOnce();
	});

	it.each([false, true])(
		"waits safely without a registrar or when registration throws (%s)",
		async (throwing) => {
			vi.useFakeTimers();
			const receipt = deferred<Response>();
			const send = vi.fn(() => receipt.promise);
			const start = () =>
				runWithMediaJobEvents(namespace(send), () =>
					publishCommittedMediaJobNotifications([event]),
				);
			const publication = throwing
				? runWithRequestDefer(() => {
						throw new Error("CLOSED");
					}, start)
				: start();
			let finished = false;
			const observed = publication.then(() => {
				finished = true;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(finished).toBe(false);
			expect(db.ack).not.toHaveBeenCalled();
			receipt.resolve(Response.json({ persisted: true, eventId: event.eventId }));
			await observed;
			expect(db.ack).toHaveBeenCalledOnce();
		},
	);

	it("retains every notification but schedules nothing for disabled or empty producers", async () => {
		const other = { ...event, eventId: `mju_${"b".repeat(64)}`, jobId: "other" };
		const retained: Promise<unknown>[] = [];
		const send = vi.fn(async (request: Request) =>
			Response.json({ persisted: true, eventId: ((await request.json()) as typeof event).eventId }),
		);
		const publish = (events: (typeof event)[]) =>
			runWithRequestDefer(
				(work) => retained.push(work),
				() =>
					runWithMediaJobEvents(namespace(send), () =>
						publishCommittedMediaJobNotifications(events),
					),
			);
		await publish([]);
		vi.stubEnv("MEDIA_JOB_EVENTS_ENABLED", "false");
		await publish([event]);
		expect(retained).toHaveLength(0);
		expect(send).not.toHaveBeenCalled();
		vi.stubEnv("MEDIA_JOB_EVENTS_ENABLED", "true");
		await publish([event, other]);
		await Promise.all(retained);
		expect(send).toHaveBeenCalledTimes(2);
		expect(db.ack).toHaveBeenCalledTimes(2);
	});
});
