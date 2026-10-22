import { createHmac } from "node:crypto";

import { imageModerationCallbackUrl } from "@repo/jobs/orchestration/image-moderation-callback-auth";
import { describe, expect, it, vi } from "vitest";

import { createImageModerationCallbackHandler } from "./image-moderation-callback";

const signingKey = `whsec_${"k".repeat(20)}`;
const environment = {
	NEXT_PUBLIC_SAAS_URL: "https://example.test",
	WORKFLOWS_DISPATCH_SECRET: "s".repeat(32),
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({ whkey_test: signingKey }),
};
const identity = { assetId: "asset", generation: 2, submissionToken: "submission" };
const phaseOwner = { workflowId: `job-${"a".repeat(64)}`, phaseKey: "asset-phase", epoch: 3 };
function fixture() {
	const wake = vi
		.fn<NonNullable<Parameters<typeof createImageModerationCallbackHandler>[0]>["wake"]>()
		.mockResolvedValue("ready");
	const dispatch = vi.fn().mockResolvedValue(undefined);
	const url = imageModerationCallbackUrl(identity, environment)!;
	const request = (
		body = '{"status":"succeeded","url":"https://untrusted.test","taskId":"forged"}',
		override: Record<string, string> = {},
	) => {
		const timestamp = String(Math.floor(Date.now() / 1000));
		return new Request(url, {
			method: "POST",
			body,
			headers: {
				"X-SEEAPI-Timestamp": timestamp,
				"X-SEEAPI-Signing-Key": "whkey_test",
				"X-SEEAPI-Signature": `v1=${createHmac("sha256", signingKey).update(`${timestamp}.${body}`).digest("hex")}`,
				...override,
			},
		});
	};
	return {
		wake,
		dispatch,
		request,
		url,
		handler: createImageModerationCallbackHandler({
			environment: () => environment,
			wake,
			dispatch,
		}),
	};
}
describe("image review callback delivery", () => {
	it("wakes the stored attempt immediately and ignores all supplied results and task IDs", async () => {
		const f = fixture();
		expect((await f.handler(f.request())).status).toBe(202);
		expect(f.wake).toHaveBeenCalledWith(identity);
		expect(f.dispatch).toHaveBeenCalledWith(
			"media-verify-upload",
			{ assetId: "asset" },
			{ idempotencyKey: "image-review-callback:asset:2:submission", timeoutMs: 3000 },
		);
		f.wake.mockResolvedValue("recorded");
		expect((await f.handler(f.request())).status).toBe(202);
		expect(f.dispatch).toHaveBeenCalledTimes(1);
	});
	it("rejects invalid signature and stale timestamps before touching the DB", async () => {
		const f = fixture();
		const invalidHeaders: Record<string, string>[] = [
			{ "X-SEEAPI-Signature": "v1=" + "0".repeat(64) },
			{ "X-SEEAPI-Timestamp": "1" },
		];
		for (const headers of invalidHeaders)
			expect((await f.handler(f.request("{}", headers))).status).toBe(401);
		expect(f.wake).not.toHaveBeenCalled();
	});
	it("bounds the body even without Content-Length", async () => {
		const f = fixture();
		expect((await f.handler(f.request("x".repeat(65537)))).status).toBe(400);
		expect(f.wake).not.toHaveBeenCalled();
	});
	it.each(["invalid", "recorded", "terminal"] as const)(
		"handles %s without dispatch",
		async (outcome) => {
			const f = fixture();
			f.wake.mockResolvedValue(outcome);
			expect((await f.handler(f.request())).status).toBe(outcome === "invalid" ? 400 : 202);
			expect(f.dispatch).not.toHaveBeenCalled();
		},
	);
	it("asks for redelivery on a lost dispatch without undoing the durable wake", async () => {
		const f = fixture();
		f.dispatch.mockRejectedValue(new Error("lost"));
		expect((await f.handler(f.request())).status).toBe(503);
		expect(f.wake).toHaveBeenCalledTimes(1);
		f.dispatch.mockResolvedValue(undefined);
		expect((await f.handler(f.request())).status).toBe(202);
		expect(f.dispatch.mock.calls[0]).toEqual(f.dispatch.mock.calls[1]);
	});
	it("signals only the owner returned by committed database state", async () => {
		const f = fixture();
		f.wake.mockResolvedValue({ status: "ready", phaseOwner });
		expect((await f.handler(f.request('{"phaseOwner":{"workflowId":"forged"}}'))).status).toBe(202);
		expect(f.dispatch).toHaveBeenCalledExactlyOnceWith(
			"media-verify-upload",
			{ assetId: identity.assetId },
			{
				idempotencyKey: "image-review-callback:asset:2:submission",
				timeoutMs: 3000,
				phaseOwner,
			},
		);
		expect(f.wake.mock.invocationCallOrder[0]).toBeLessThan(
			f.dispatch.mock.invocationCallOrder[0]!,
		);
	});
	it("does not start an unowned execution after an owner signal fails", async () => {
		const f = fixture();
		f.wake.mockResolvedValue({ status: "ready", phaseOwner });
		f.dispatch.mockRejectedValue(new Error("owner signal lost"));
		expect((await f.handler(f.request())).status).toBe(503);
		expect(f.dispatch).toHaveBeenCalledOnce();
		expect(f.dispatch.mock.calls[0]![2]).toMatchObject({ phaseOwner });
	});
	it("keeps consumed signals inert even when the database includes an owner", async () => {
		const f = fixture();
		f.wake.mockResolvedValue({ status: "recorded", phaseOwner });
		expect((await f.handler(f.request())).status).toBe(202);
		expect(f.dispatch).not.toHaveBeenCalled();
	});
});
