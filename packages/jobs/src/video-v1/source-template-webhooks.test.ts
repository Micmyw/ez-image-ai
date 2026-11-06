import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
	createSourceTemplateCallbackUrl,
	sourceCallbackTokenHash,
} from "./source-template-callback-url";
import {
	createSourceTemplateWebhookHandler,
	type SourceTemplateWebhookDependencies,
} from "./source-template-webhooks";

vi.mock("@repo/database/video-source-template-events", () => ({}));
const token = "a".repeat(64);
const secret = "whsec_source-fixture-1234567890123456";
const now = new Date("2026-11-06T08:00:00.000Z");
const env = {
	NEXT_PUBLIC_SAAS_URL: "https://example.test",
	VIDEO_SEEAPI_CALLBACK_SECRET: "source-fixture-secret-1234567890123456",
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({ whkey_source: secret }),
};
function fixture(phase: "generation" | "input" = "generation") {
	const instance = { sendEvent: vi.fn(async () => {}), status: vi.fn() };
	const binding = { get: vi.fn(async () => instance), create: vi.fn() };
	const persist = vi.fn(
		async (_input: Parameters<NonNullable<SourceTemplateWebhookDependencies["persist"]>>[0]) => ({
			eventId: "event",
			jobId: "job",
			workflowInstanceId: "video-v1-job",
			phase,
			replayed: false,
			notified: false,
		}),
	);
	const markNotified = vi.fn(async () => {});
	return {
		instance,
		binding,
		persist,
		markNotified,
		handler: createSourceTemplateWebhookHandler({
			binding,
			persist,
			markNotified,
			environment: env,
			now: () => now,
		}),
	};
}
function request(
	provider: "kie" | "seeapi" = "seeapi",
	input = false,
	body = '{"data":{"taskId":"untrusted","url":"https://ignored.example/result.mp4"}}',
) {
	const url = createSourceTemplateCallbackUrl(
		{ provider, token, ...(input ? { input: { jobId: "job", role: "performer-2" } } : {}) },
		env,
	);
	const stamp = String(now.getTime() / 1000);
	return new Request(url, {
		method: "POST",
		body,
		headers:
			provider === "seeapi"
				? {
						"X-SEEAPI-Timestamp": stamp,
						"X-SEEAPI-Signing-Key": "whkey_source",
						"X-SEEAPI-Signature": `v1=${createHmac("sha256", secret).update(`${stamp}.${body}`).digest("hex")}`,
					}
				: {},
	});
}
describe("source callbacks have only a durable, exactly addressed Workflow continuation", () => {
	it.each(["kie", "seeapi"] as const)(
		"accepts the original %s notification contract without trusting task or result fields",
		async (provider) => {
			const f = fixture();
			expect((await f.handler(request(provider))).status).toBe(202);
			expect(f.persist).toHaveBeenCalledWith(
				expect.objectContaining({
					provider,
					phase: "generation",
					tokenHash: await sourceCallbackTokenHash(token),
				}),
			);
			expect(f.persist.mock.calls[0]?.[0]).not.toHaveProperty("taskId");
			expect(f.binding.get).toHaveBeenCalledExactlyOnceWith("video-v1-job");
			expect(f.instance.sendEvent).toHaveBeenCalledExactlyOnceWith({
				type: "provider-result",
				payload: { jobId: "job", eventId: "event" },
			});
			expect(f.persist.mock.invocationCallOrder[0]).toBeLessThan(
				f.instance.sendEvent.mock.invocationCallOrder[0]!,
			);
			expect(f.instance.sendEvent.mock.invocationCallOrder[0]).toBeLessThan(
				f.markNotified.mock.invocationCallOrder[0]!,
			);
		},
	);
	it("binds each input role independently and wakes moderation only", async () => {
		const f = fixture("input");
		expect((await f.handler(request("seeapi", true))).status).toBe(202);
		expect(f.persist).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: "job", role: "performer-2", phase: "input" }),
		);
		expect(f.instance.sendEvent).toHaveBeenCalledWith(
			expect.objectContaining({ type: "moderation-result" }),
		);
	});
	it("does not re-notify an already processed duplicate", async () => {
		const f = fixture();
		f.persist.mockResolvedValueOnce({
			eventId: "event",
			jobId: "job",
			workflowInstanceId: "video-v1-job",
			phase: "generation",
			replayed: true,
			notified: true,
		});
		expect((await f.handler(request())).status).toBe(202);
		expect(f.binding.get).not.toHaveBeenCalled();
	});
	it("rejects missing or invalid raw-body signatures before persistence", async () => {
		for (const signature of [null, "v1=" + "0".repeat(64)]) {
			const f = fixture();
			const req = request();
			if (signature) req.headers.set("X-SEEAPI-Signature", signature);
			else req.headers.delete("X-SEEAPI-Signature");
			expect((await f.handler(req)).status).toBe(401);
			expect(f.persist).not.toHaveBeenCalled();
		}
	});
	it("persists byte-identical Unicode/BOM evidence after verifying original bytes", async () => {
		const f = fixture();
		const rawBody = '\uFEFF{"message":"原始签名"}';
		expect((await f.handler(request("seeapi", false, rawBody))).status).toBe(202);
		expect(f.persist).toHaveBeenCalledWith(
			expect.objectContaining({ rawBody, eventHash: await sourceCallbackTokenHash(rawBody) }),
		);
	});
	it("returns retry on persistence or delivery failure without another action", async () => {
		const f = fixture();
		f.persist.mockRejectedValueOnce(new Error("database unavailable"));
		expect((await f.handler(request())).status).toBe(503);
		expect(f.binding.get).not.toHaveBeenCalled();
		f.instance.sendEvent.mockRejectedValueOnce(new Error("wake unavailable"));
		expect((await f.handler(request())).status).toBe(503);
		expect(f.markNotified).not.toHaveBeenCalled();
		expect((await f.handler(request())).status).toBe(202);
		expect(f.markNotified).toHaveBeenCalledOnce();
	});
	it("rejects unknown capabilities, wrong origins and oversized bodies", async () => {
		const f = fixture();
		f.persist.mockRejectedValueOnce(new Error("SOURCE_CALLBACK_IDENTITY_INVALID"));
		expect((await f.handler(request("kie"))).status).toBe(401);
		expect(
			(
				await f.handler(
					new Request(request().url.replace("example.test", "wrong.test"), {
						method: "POST",
						body: "{}",
					}),
				)
			).status,
		).toBe(401);
		const huge = request("kie");
		huge.headers.set("content-length", String(256 * 1024 + 1));
		expect((await f.handler(huge)).status).toBe(413);
		expect(f.persist).toHaveBeenCalledOnce();
		expect(f.binding.get).not.toHaveBeenCalled();
	});
});
