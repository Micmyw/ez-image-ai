import { describe, expect, it } from "vitest";

import { kieCompletionCallbackUrl, verifyKieCompletionCallback } from "./kie-callback-auth";

const environment = {
	NEXT_PUBLIC_SAAS_URL: "https://example.test",
	WORKFLOWS_DISPATCH_SECRET: "x".repeat(32),
};
describe("Kie completion capabilities", () => {
	it("binds notifications to one attempt without exposing the shared secret", () => {
		const url = new URL(kieCompletionCallbackUrl("attempt-1", environment)!);
		expect(url.pathname).toBe("/api/webhooks/ai/kie");
		expect(url.href).not.toContain(environment.WORKFLOWS_DISPATCH_SECRET);
		expect(verifyKieCompletionCallback(url, environment.WORKFLOWS_DISPATCH_SECRET)).toBe(
			"attempt-1",
		);
		url.searchParams.set("attempt", "attempt-2");
		expect(verifyKieCompletionCallback(url, environment.WORKFLOWS_DISPATCH_SECRET)).toBeNull();
	});
	it("fails closed without a valid signature or secure public callback origin", () => {
		const url = new URL(kieCompletionCallbackUrl("attempt-1", environment)!);
		expect(verifyKieCompletionCallback(url, "y".repeat(32))).toBeNull();
		expect(verifyKieCompletionCallback(url, undefined)).toBeNull();
		url.searchParams.set("token", "invalid");
		expect(verifyKieCompletionCallback(url, environment.WORKFLOWS_DISPATCH_SECRET)).toBeNull();
		expect(kieCompletionCallbackUrl("attempt-1", {})).toBeUndefined();
		expect(
			kieCompletionCallbackUrl("attempt-1", {
				...environment,
				NEXT_PUBLIC_SAAS_URL: "http://localhost:3000",
			}),
		).toBeUndefined();
	});
});
