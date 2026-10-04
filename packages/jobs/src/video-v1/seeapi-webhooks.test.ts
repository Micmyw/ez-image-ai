import { createHash, createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { VideoWorkflowBinding } from "./contracts";
import { createSeeapiVideoCallbackUrl } from "./seeapi-callback-url";
import {
	createSeeapiVideoModerationWebhookHandler,
	notifyPendingSeeapiVideoModerationEvents,
	type SeeapiVideoModerationWebhookDependencies,
} from "./seeapi-webhooks";

const now = new Date("2026-10-04T00:00:00Z");
const signingKeyId = "whkey_fixture";
const signingSecret = "whsec_fixture-only-abcdefghijklmnopqrstuvwxyz";
const identity = { assetId: "asset_fixture", generation: 2, attemptNumber: 3 };
const environment = {
	NEXT_PUBLIC_SAAS_URL: "https://video.example.com",
	VIDEO_SEEAPI_CALLBACK_SECRET: "fixture-only-callback-secret-abcdefghijklmnopqrstuvwxyz",
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({ [signingKeyId]: signingSecret }),
};
type Persist = NonNullable<SeeapiVideoModerationWebhookDependencies["persist"]>;
function dependencies() {
	const persist = vi.fn<Persist>(async () => ({
		eventId: "evt1",
		jobId: "job1",
		workflowInstanceId: "video-v1-job1",
		replayed: false,
		notified: false,
	}));
	const markNotified = vi.fn(async () => {});
	const sendEvent = vi.fn(async () => {});
	const binding = {
		get: vi.fn(async () => ({ sendEvent, status: async () => ({ status: "running" }) })),
		create: vi.fn(),
	} as VideoWorkflowBinding;
	return { environment, now: () => now, persist, markNotified, binding, sendEvent };
}
async function request(
	options: {
		body?: string | Uint8Array;
		timestamp?: string;
		headers?: Record<string, string>;
		url?: string;
		tamper?: string;
	} = {},
) {
	const url = options.url ?? (await createSeeapiVideoCallbackUrl(identity, environment));
	const timestamp = options.timestamp ?? String(now.getTime() / 1000);
	const bytes =
		typeof options.body === "string" || options.body === undefined
			? new TextEncoder().encode(
					options.body ??
						'{"anything":"signed but not trusted","status":"approved","taskId":"foreign-task"}',
				)
			: options.body;
	const signature = createHmac("sha256", signingSecret)
		.update(`${timestamp}.`)
		.update(bytes)
		.digest("hex");
	return new Request(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-SEEAPI-Timestamp": timestamp,
			"X-SEEAPI-Signature": `v1=${signature}`,
			"X-SEEAPI-Signing-Key": signingKeyId,
			"X-SEEAPI-Delivery": "untrusted-delivery",
			"X-SEEAPI-Event": "untrusted-event",
			...options.headers,
		},
		body: options.tamper ?? (bytes as BodyInit),
	});
}

describe("SeeAPI video moderation callback", () => {
	it("persists exact signed evidence and attempt URL identity before notifying only its Workflow", async () => {
		const dep = dependencies();
		const body = '{ "taskId": "foreign-task", "status": "approved", "arbitrary": "字" }';
		const response = await createSeeapiVideoModerationWebhookHandler(dep)(await request({ body }));
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ accepted: true });
		expect(dep.persist).toHaveBeenCalledWith({
			...identity,
			rawBody: body,
			eventHash: createHash("sha256").update(body).digest("hex"),
			receivedAt: now,
			deliveryMetadata: { delivery: "untrusted-delivery", event: "untrusted-event" },
		});
		expect(dep.sendEvent).toHaveBeenCalledWith({
			type: "moderation-result",
			payload: { jobId: "job1", eventId: "evt1" },
		});
		expect(dep.persist.mock.invocationCallOrder[0]).toBeLessThan(
			dep.sendEvent.mock.invocationCallOrder[0]!,
		);
		expect(dep.markNotified).toHaveBeenCalledWith("evt1");
	});
	it.each(["X-SEEAPI-Timestamp", "X-SEEAPI-Signature", "X-SEEAPI-Signing-Key"])(
		"rejects missing %s without persistence or notification",
		async (header) => {
			const dep = dependencies();
			const req = await request();
			req.headers.delete(header);
			expect((await createSeeapiVideoModerationWebhookHandler(dep)(req)).status).toBe(401);
			expect(dep.persist).not.toHaveBeenCalled();
			expect(dep.sendEvent).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ tamper: '{"tampered":true}' },
		{ headers: { "X-SEEAPI-Signing-Key": "whkey_unknown" } },
		{ timestamp: String(now.getTime() / 1000 - 301) },
		{ timestamp: String(now.getTime() / 1000 + 301) },
	])("rejects invalid official signature context %#", async (options) => {
		const dep = dependencies();
		expect(
			(await createSeeapiVideoModerationWebhookHandler(dep)(await request(options))).status,
		).toBe(401);
		expect(dep.persist).not.toHaveBeenCalled();
		expect(dep.sendEvent).not.toHaveBeenCalled();
	});
	it("rejects valid provider signature copied to a different attempt URL", async () => {
		const dep = dependencies();
		const url = new URL(await createSeeapiVideoCallbackUrl(identity, environment));
		url.searchParams.set("attempt", "4");
		expect(
			(await createSeeapiVideoModerationWebhookHandler(dep)(await request({ url: url.toString() })))
				.status,
		).toBe(401);
		expect(dep.persist).not.toHaveBeenCalled();
		expect(dep.sendEvent).not.toHaveBeenCalled();
	});
	it("checks signature before UTF-8 or JSON parsing", async () => {
		const dep = dependencies();
		const req = await request({
			body: new Uint8Array([0xff]),
			headers: { "X-SEEAPI-Signature": `v1=${"0".repeat(64)}` },
		});
		expect((await createSeeapiVideoModerationWebhookHandler(dep)(req)).status).toBe(401);
		expect(dep.persist).not.toHaveBeenCalled();
	});
	it.each(["[]", "null", "42", "invalid", '"json string"', new Uint8Array([0xff])])(
		"rejects signed non-object or invalid UTF-8 body %#",
		async (body) => {
			const dep = dependencies();
			expect(
				(await createSeeapiVideoModerationWebhookHandler(dep)(await request({ body }))).status,
			).toBe(400);
			expect(dep.persist).not.toHaveBeenCalled();
		},
	);
	it("preserves BOM in stored body and hash after raw signature verification", async () => {
		const dep = dependencies();
		const body = '\uFEFF{"payload":"字"}';
		expect(
			(await createSeeapiVideoModerationWebhookHandler(dep)(await request({ body }))).status,
		).toBe(202);
		expect(dep.persist.mock.calls[0]![0]).toMatchObject({
			rawBody: body,
			eventHash: createHash("sha256").update(body).digest("hex"),
		});
	});
	it("bounds declared and actual payload sizes to 256 KiB", async () => {
		const dep = dependencies();
		const handler = createSeeapiVideoModerationWebhookHandler(dep);
		expect(
			(await handler(await request({ headers: { "Content-Length": String(256 * 1024 + 1) } })))
				.status,
		).toBe(413);
		expect((await handler(await request({ body: "x".repeat(256 * 1024 + 1) }))).status).toBe(413);
		expect(dep.persist).not.toHaveBeenCalled();
	});
	it("does not acknowledge failed persistence or wake its Workflow", async () => {
		const dep = dependencies();
		dep.persist.mockRejectedValueOnce(new Error("database unavailable"));
		expect((await createSeeapiVideoModerationWebhookHandler(dep)(await request())).status).toBe(
			503,
		);
		expect(dep.sendEvent).not.toHaveBeenCalled();
	});
	it("rejects database identity mismatch without disclosing an asset", async () => {
		const dep = dependencies();
		dep.persist.mockRejectedValueOnce(new Error("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID"));
		expect((await createSeeapiVideoModerationWebhookHandler(dep)(await request())).status).toBe(
			401,
		);
		expect(dep.sendEvent).not.toHaveBeenCalled();
	});
	it("returns retry after durable notification failure, then notifies duplicate event", async () => {
		const dep = dependencies();
		dep.sendEvent.mockRejectedValueOnce(new Error("binding down"));
		const handler = createSeeapiVideoModerationWebhookHandler(dep);
		expect((await handler(await request())).status).toBe(503);
		expect(dep.markNotified).not.toHaveBeenCalled();
		dep.persist.mockResolvedValueOnce({
			eventId: "evt1",
			jobId: "job1",
			workflowInstanceId: "video-v1-job1",
			replayed: true,
			notified: false,
		});
		expect((await handler(await request())).status).toBe(202);
		expect(dep.sendEvent).toHaveBeenCalledTimes(2);
		expect(dep.markNotified).toHaveBeenCalledOnce();
	});
	it("does not notify an already notified duplicate or trust changed unsigned event headers", async () => {
		const dep = dependencies();
		dep.persist.mockResolvedValueOnce({
			eventId: "evt1",
			jobId: "job1",
			workflowInstanceId: "video-v1-job1",
			replayed: true,
			notified: true,
		});
		expect(
			(
				await createSeeapiVideoModerationWebhookHandler(dep)(
					await request({
						headers: { "X-SEEAPI-Event": "pretend-approved", "X-SEEAPI-Delivery": "different" },
					}),
				)
			).status,
		).toBe(202);
		expect(dep.sendEvent).not.toHaveBeenCalled();
		expect(dep.markNotified).not.toHaveBeenCalled();
	});
	it("returns retry when notification bookkeeping fails after send, preserving the durable event", async () => {
		const dep = dependencies();
		dep.markNotified.mockRejectedValueOnce(new Error("database unavailable"));
		expect((await createSeeapiVideoModerationWebhookHandler(dep)(await request())).status).toBe(
			503,
		);
		expect(dep.persist).toHaveBeenCalledOnce();
		expect(dep.sendEvent).toHaveBeenCalledOnce();
	});
	it("accepts durable early callback without a task ID, then targeted helper delivers it after task persistence", async () => {
		const dep = dependencies();
		dep.persist.mockResolvedValueOnce({ eventId: "early", replayed: false, notified: false });
		expect((await createSeeapiVideoModerationWebhookHandler(dep)(await request())).status).toBe(
			202,
		);
		expect(dep.sendEvent).not.toHaveBeenCalled();
		const events = vi.fn(async () => [
			{
				eventId: "early",
				jobId: "job1",
				workflowInstanceId: "video-v1-job1",
				replayed: true,
				notified: false,
			},
		]);
		expect(
			await notifyPendingSeeapiVideoModerationEvents({ ...dep, events, jobId: "job1" }),
		).toEqual({ notified: 1, failed: 0 });
		expect(events).toHaveBeenCalledWith(50, "job1");
		expect(dep.sendEvent).toHaveBeenCalledWith({
			type: "moderation-result",
			payload: { jobId: "job1", eventId: "early" },
		});
	});
	it("will not send a bound event to a mismatched Workflow", async () => {
		const dep = dependencies();
		dep.persist.mockResolvedValueOnce({
			eventId: "evt1",
			jobId: "job1",
			workflowInstanceId: "video-v1-other",
			replayed: false,
			notified: false,
		});
		expect((await createSeeapiVideoModerationWebhookHandler(dep)(await request())).status).toBe(
			503,
		);
		expect(dep.sendEvent).not.toHaveBeenCalled();
	});
});
