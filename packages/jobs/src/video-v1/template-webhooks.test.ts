import { describe, expect, it, vi } from "vitest";

import type { VideoWorkflowBinding } from "./contracts";
import { acceptVideoTemplateProviderWebhook } from "./template-webhooks";

vi.mock("@repo/database/video-template-execution", () => ({
	persistVideoTemplateSceneWebhook: vi.fn(),
	markVideoTemplateSceneWebhookNotified: vi.fn(),
}));
vi.mock("@repo/database/video-v1-execution", () => ({}));
vi.mock("@repo/storage", () => ({ createSignedReadUrl: vi.fn() }));

const now = new Date();
const secret = "local-signature-fixture";
async function request(taskId = "scene-task", tampered = false) {
	const timestamp = String(Math.floor(now.getTime() / 1000));
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signed = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${taskId}.${timestamp}`)),
	);
	return new Request(`https://ezpic.example/api/webhooks/video-template/kie/${"a".repeat(64)}`, {
		method: "POST",
		headers: {
			"x-webhook-timestamp": timestamp,
			"x-webhook-signature": tampered ? "A".repeat(43) + "=" : btoa(String.fromCharCode(...signed)),
		},
		body: JSON.stringify({
			data: { taskId, state: "success", resultUrl: "https://evil.example/result.mp4" },
		}),
	});
}
describe("template scene callback identity (local mocks)", () => {
	it("persists only HMAC task identity before waking the same Workflow, ignores body results", async () => {
		const order: string[] = [];
		const persist = vi.fn(async (_input: unknown) => {
			order.push("persist");
			return {
				eventId: "event",
				jobId: "job",
				workflowInstanceId: "video-v1-job",
				replayed: false,
				notified: false,
			};
		});
		const sendEvent = vi.fn(async () => {
			order.push("wake");
		});
		const result = await acceptVideoTemplateProviderWebhook(await request(), {
			environment: { KIE_WEBHOOK_SECRET: secret },
			now: () => now,
			persist,
			markNotified: vi.fn(),
			binding: { get: vi.fn(async () => ({ sendEvent })) } as unknown as VideoWorkflowBinding,
		});
		expect(result.accepted).toBe(true);
		expect(order).toEqual(["persist", "wake"]);
		expect(persist.mock.calls[0]?.[0]).not.toHaveProperty("resultUrl");
		expect(sendEvent).toHaveBeenCalledWith({
			type: "provider-result",
			payload: { eventId: "event", jobId: "job" },
		});
	});
	it("rejects spoofed signatures before reading or binding another role", async () => {
		const persist = vi.fn();
		await expect(
			acceptVideoTemplateProviderWebhook(await request("scene-task", true), {
				environment: { KIE_WEBHOOK_SECRET: secret },
				now: () => now,
				persist,
			}),
		).rejects.toMatchObject({ status: 401 });
		expect(persist).not.toHaveBeenCalled();
	});
});
