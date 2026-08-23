import { describe, expect, it } from "vitest";

import { sentryBeforeSend } from "./sentry";

describe("sentryBeforeSend", () => {
	it("scrubs request, breadcrumb, exception, and extra data before transport", () => {
		const event = {
			request: {
				url: "https://app.example.com/private.png?X-Amz-Signature=secret",
				headers: { Authorization: "Bearer sk_live_secret", Cookie: "session=secret" },
				data: { prompt: "private prompt" },
			},
			breadcrumbs: [{ data: { providerRawPayload: { token: "provider-secret" } } }],
			extra: { mediaUrl: "https://cdn.example/private.mp4" },
			exception: { values: [{ value: "failed Bearer sk_live_exception" }] },
		};

		const output = JSON.stringify(sentryBeforeSend(event));

		for (const secret of [
			"X-Amz-Signature",
			"sk_live_secret",
			"session=secret",
			"private prompt",
			"provider-secret",
			"private.mp4",
			"sk_live_exception",
		]) {
			expect(output).not.toContain(secret);
		}
	});

	it("adds stable release correlation without replacing an explicit fingerprint", () => {
		expect(sentryBeforeSend({ message: "failed" }, "release-42")).toMatchObject({
			release: "release-42",
			fingerprint: ["{{ default }}", "release-42"],
		});
		expect(sentryBeforeSend({ fingerprint: ["provider", "timeout"] }, "release-42")).toMatchObject({
			fingerprint: ["provider", "timeout"],
			release: "release-42",
		});
	});
});
