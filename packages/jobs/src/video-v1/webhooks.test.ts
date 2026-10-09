import { describe, expect, it, vi } from "vitest";

import type { VideoWorkflowBinding } from "./contracts";
import { acceptVideoProviderWebhook, createVideoProviderWebhookHandler } from "./webhooks";

vi.mock("@repo/database/video-v1-execution", () => ({}));
vi.mock("@repo/storage", () => ({ createSignedReadUrl: vi.fn() }));

const secret = "test-webhook-secret";
const token = "a".repeat(64);
const now = new Date("2026-10-04T00:00:00Z");
async function callback(
	options: {
		token?: string;
		taskId?: string;
		taskField?: "taskId" | "task_id";
		timestamp?: string;
		unsigned?: boolean;
		envelope?: Record<string, unknown>;
		body?: Record<string, unknown>;
	} = {},
) {
	const taskId = options.taskId ?? "task-1";
	const timestamp = options.timestamp ?? String(Math.floor(now.getTime() / 1000));
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const bytes = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${taskId}.${timestamp}`),
	);
	const signature = btoa(String.fromCharCode(...new Uint8Array(bytes)));
	return new Request(`https://example.test/api/webhooks/video/kie/${options.token ?? token}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(!options.unsigned
				? { "x-webhook-timestamp": timestamp, "x-webhook-signature": signature }
				: {}),
		},
		body: JSON.stringify({
			...options.envelope,
			data: { [options.taskField ?? "taskId"]: taskId, ...options.body },
		}),
	});
}
function fixture() {
	let notified = false;
	let persisted = false;
	const persist = vi.fn(async () => {
		const replayed = persisted;
		persisted = true;
		return {
			eventId: "event-1",
			jobId: "job-1",
			workflowInstanceId: "video-v1-job-1",
			replayed,
			notified,
			callbackPersistedAt: replayed ? undefined : now.toISOString(),
		};
	});
	const markNotified = vi.fn(async () => {
		notified = true;
	});
	const sendEvent = vi.fn(async () => undefined);
	const binding = { get: vi.fn(async () => ({ sendEvent })) } as unknown as VideoWorkflowBinding;
	const options = {
		environment: { KIE_WEBHOOK_SECRET: secret },
		now: () => now,
		persist,
		markNotified,
		binding,
	};
	return { options, persist, markNotified, sendEvent, binding };
}

describe("verified durable video callback inbox", () => {
	it.each(["taskId", "task_id"] as const)(
		"authenticates the documented %s identity while ignoring Veo result/accounting fields",
		async (taskField) => {
			const f = fixture();
			await acceptVideoProviderWebhook(
				await callback({
					taskField,
					body: {
						info: { resultUrls: ["https://untrusted.example/video.mp4"] },
						creditsConsumed: 0,
						fallbackFlag: true,
					},
				}),
				f.options,
			);
			expect(f.persist).toHaveBeenCalledWith({
				callbackTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
				taskId: "task-1",
				timestamp: String(Math.floor(now.getTime() / 1000)),
				receivedAt: now,
			});
		},
	);
	it.each(["another-task", null, 1])(
		"rejects conflicting identity aliases before persistence: %j",
		async (task_id) => {
			const f = fixture();
			const response = await createVideoProviderWebhookHandler(f.options)(
				await callback({ body: { task_id } }),
			);
			expect(response.status).toBe(400);
			expect(f.persist).not.toHaveBeenCalled();
		},
	);
	it("accepts identical aliases but still requires their valid signature", async () => {
		const f = fixture();
		await acceptVideoProviderWebhook(await callback({ body: { task_id: "task-1" } }), f.options);
		expect(f.persist).toHaveBeenCalledTimes(1);
		const response = await createVideoProviderWebhookHandler(f.options)(
			await callback({ taskField: "task_id", unsigned: true }),
		);
		expect(response.status).toBe(401);
		expect(f.persist).toHaveBeenCalledTimes(1);
	});
	it.each(["taskId", "task_id"])("rejects a conflicting root %s copy", async (field) => {
		const f = fixture();
		const response = await createVideoProviderWebhookHandler(f.options)(
			await callback({ taskField: "task_id", envelope: { [field]: "different-task" } }),
		);
		expect(response.status).toBe(400);
		expect(f.persist).not.toHaveBeenCalled();
	});
	it("accepts the common guide's matching root and nested identities", async () => {
		const f = fixture();
		await acceptVideoProviderWebhook(
			await callback({ taskField: "task_id", envelope: { taskId: "task-1" } }),
			f.options,
		);
		expect(f.persist).toHaveBeenCalledTimes(1);
	});
	it("discards unsigned body result URLs and persists only signed task correlation", async () => {
		const f = fixture();
		await acceptVideoProviderWebhook(
			await callback({
				body: { resultUrls: ["https://attacker.invalid/private.mp4"], state: "fail" },
			}),
			f.options,
		);
		const persisted = f.persist.mock.calls[0] as unknown as [Record<string, unknown>];
		expect(persisted[0]).toMatchObject({ taskId: "task-1" });
		expect(persisted[0]).not.toHaveProperty("resultUrls");
		expect(persisted[0]).not.toHaveProperty("state");
		expect(JSON.stringify(persisted)).not.toContain("attacker");
		expect(f.sendEvent).toHaveBeenCalledWith({
			type: "provider-result",
			payload: { eventId: "event-1", jobId: "job-1" },
		});
	});
	it("duplicate callback retries a persisted notification whose send failed", async () => {
		const f = fixture();
		f.sendEvent.mockRejectedValueOnce(new Error("instance not ready"));
		expect(await acceptVideoProviderWebhook(await callback(), f.options)).toMatchObject({
			accepted: true,
			notified: false,
			replayed: false,
		});
		expect(await acceptVideoProviderWebhook(await callback(), f.options)).toMatchObject({
			accepted: true,
			notified: true,
			replayed: true,
		});
		expect(f.sendEvent).toHaveBeenCalledTimes(2);
		expect(f.markNotified).toHaveBeenCalledTimes(1);
	});
	it("does not duplicate an already acknowledged notification", async () => {
		const f = fixture();
		await acceptVideoProviderWebhook(await callback(), f.options);
		await acceptVideoProviderWebhook(await callback(), f.options);
		expect(f.sendEvent).toHaveBeenCalledTimes(1);
	});
	it("wakes the committed inbox before recording its optional commit observation", async () => {
		const f = fixture();
		await acceptVideoProviderWebhook(await callback(), f.options);
		expect(f.markNotified).toHaveBeenCalledWith("event-1", now.toISOString());
		expect(f.sendEvent.mock.invocationCallOrder[0]).toBeGreaterThan(
			f.persist.mock.invocationCallOrder[0]!,
		);
		expect(f.markNotified.mock.invocationCallOrder[0]).toBeGreaterThan(
			f.sendEvent.mock.invocationCallOrder[0]!,
		);
	});
	it("still wakes and ACKs a committed inbox when the notification/timing write fails", async () => {
		const f = fixture();
		f.markNotified.mockRejectedValueOnce(new Error("timing write failed"));
		const response = await createVideoProviderWebhookHandler(f.options)(await callback());
		expect(response.status).toBe(202);
		expect(f.sendEvent).toHaveBeenCalledTimes(1);
		expect(await acceptVideoProviderWebhook(await callback(), f.options)).toMatchObject({
			accepted: true,
			notified: true,
			replayed: true,
		});
		expect(f.sendEvent).toHaveBeenCalledTimes(2);
		expect(f.markNotified).toHaveBeenLastCalledWith("event-1", undefined);
	});
	it("does not acknowledge database failure", async () => {
		const f = fixture();
		f.persist.mockRejectedValueOnce(new Error("db unavailable"));
		const response = await createVideoProviderWebhookHandler(f.options)(await callback());
		expect(response.status).toBe(503);
		expect(f.sendEvent).not.toHaveBeenCalled();
	});
	it.each([
		{ unsigned: true },
		{ token: "bad-token" },
		{ timestamp: String(Math.floor(now.getTime() / 1000) - 301) },
	])("rejects missing auth, malformed tokens or expired signatures %#", async (input) => {
		const f = fixture();
		const response = await createVideoProviderWebhookHandler(f.options)(await callback(input));
		expect(response.status).toBe(401);
		expect(f.persist).not.toHaveBeenCalled();
	});
	it("rejects a well formed but unrelated correlation token", async () => {
		const f = fixture();
		f.persist.mockRejectedValueOnce(new Error("VIDEO_CALLBACK_ATTEMPT_INVALID"));
		const response = await createVideoProviderWebhookHandler(f.options)(
			await callback({ token: "b".repeat(64) }),
		);
		expect(response.status).toBe(401);
		expect(f.sendEvent).not.toHaveBeenCalled();
	});
	it("keeps an early callback durable when workflow binding is not yet available", async () => {
		const f = fixture();
		expect(
			await acceptVideoProviderWebhook(await callback(), { ...f.options, binding: undefined }),
		).toMatchObject({ accepted: true, notified: false });
		expect(f.persist).toHaveBeenCalledTimes(1);
	});
});
