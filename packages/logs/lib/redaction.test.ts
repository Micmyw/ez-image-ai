import { describe, expect, it } from "vitest";

import { redactForLog } from "./redaction";

describe("redactForLog", () => {
	it("removes credentials, prompts, provider payload secrets, and media URLs recursively", () => {
		const fixture = {
			prompt: "a private customer prompt",
			headers: {
				Authorization: "Bearer sk_test_authorization",
				Cookie: "session=private-cookie",
				"stripe-signature": "t=1,v1=stripe-private-signature",
				"x-api-key": "provider-api-key",
			},
			input: {
				signedUrl:
					"https://bucket.example/private.png?X-Amz-Credential=private&X-Amz-Signature=signed-secret",
				mediaUrl: "https://cdn.example/customer/private-video.mp4",
			},
			providerRawPayload: {
				api_key: "raw-provider-secret",
				token: "raw-provider-token",
				result: { url: "https://provider.example/private-result.png" },
			},
		};

		const output = JSON.stringify(redactForLog(fixture));

		for (const secret of [
			"a private customer prompt",
			"sk_test_authorization",
			"private-cookie",
			"stripe-private-signature",
			"provider-api-key",
			"X-Amz-Signature",
			"signed-secret",
			"private-video.mp4",
			"raw-provider-secret",
			"raw-provider-token",
			"private-result.png",
		]) {
			expect(output).not.toContain(secret);
		}
	});

	it("serializes circular values and Error causes without leaking secrets", () => {
		const cause = new Error("Authorization: Bearer sk_live_error_secret");
		const error = new Error("request failed for https://cdn.example/private-media.png");
		Object.assign(error, {
			cause,
			request: { headers: { cookie: "session=error-cookie" } },
		});
		const circular: Record<string, unknown> = { error };
		circular.self = circular;

		const output = JSON.stringify(redactForLog(circular));

		expect(output).toContain("[Circular]");
		expect(output).toContain("request failed");
		expect(output).not.toContain("sk_live_error_secret");
		expect(output).not.toContain("private-media.png");
		expect(output).not.toContain("error-cookie");
	});

	it("does not mutate the source object", () => {
		const fixture = { authorization: "Bearer secret", safe: "visible" };

		expect(redactForLog(fixture)).toEqual({ authorization: "[REDACTED]", safe: "visible" });
		expect(fixture.authorization).toBe("Bearer secret");
	});
});
