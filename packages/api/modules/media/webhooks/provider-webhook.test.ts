import { describe, expect, it, vi } from "vitest";

import { createProviderWebhookHandler } from "./provider-webhook";

describe("provider webhook ingestion", () => {
	it("verifies raw bytes before persisting and does not depend on delivery", async () => {
		const persist = vi.fn(async () => ({ replayed: false, eventId: "stored-1" }));
		const deliver = vi.fn(async () => {
			throw new Error("Trigger unavailable");
		});
		const handler = createProviderWebhookHandler({
			getVerifier: () => ({
				verifyWebhook: vi.fn(async (request: Request) => {
					expect(await request.text()).toBe('{"id":"task-1"}');
					return {
						eventId: "event-1",
						providerTaskId: "task-1",
						status: "SUCCEEDED" as const,
						receivedAt: new Date(),
					};
				}),
			}),
			persist,
			deliver,
		});

		const response = await handler(
			"replicate",
			new Request("https://example.com/api/webhooks/ai/replicate", {
				method: "POST",
				body: '{"id":"task-1"}',
			}),
		);

		expect(response.status).toBe(202);
		expect(persist).toHaveBeenCalledTimes(1);
		expect(deliver).toHaveBeenCalledTimes(1);
	});

	it("fails closed for providers without verified webhook support", async () => {
		const handler = createProviderWebhookHandler({
			getVerifier: () => null,
			persist: vi.fn(),
		});
		const response = await handler(
			"kie",
			new Request("https://example.com/api/webhooks/ai/kie", { method: "POST", body: "{}" }),
		);
		expect(response.status).toBe(404);
	});
});
