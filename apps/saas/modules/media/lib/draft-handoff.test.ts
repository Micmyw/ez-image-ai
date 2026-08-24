import { describe, expect, it } from "vitest";

import { createDraftHandoffResponse, DRAFT_HANDOFF_INTENT } from "./draft-handoff";

const claimToken = "c".repeat(43);

function request(
	origin = "https://www.example.com",
	requestUrl = "https://app.example.com/draft/continue",
) {
	return new Request(requestUrl, {
		method: "POST",
		headers: {
			Origin: origin,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ intent: DRAFT_HANDOFF_INTENT, claimToken }),
	});
}

describe("draft handoff POST", () => {
	it("sets the scoped HttpOnly cookie and redirects through the configured SaaS origin", async () => {
		const response = await createDraftHandoffResponse(
			request("https://www.example.com", "https://internal.example/draft/continue"),
			{
				marketingOrigin: "https://www.example.com",
				saasOrigin: "https://app.example.com",
				secure: true,
				isAuthenticated: false,
			},
		);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe(
			"https://app.example.com/login?redirectTo=/draft/continue",
		);
		expect(response.headers.get("location")).not.toContain(claimToken);
		expect(response.headers.get("set-cookie")).toContain(`media_draft_claim=${claimToken}`);
		expect(response.headers.get("set-cookie")).toContain("HttpOnly");
		expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
		expect(response.headers.get("set-cookie")).toContain("Secure");
		expect(response.headers.get("set-cookie")).toContain("Path=/draft/continue");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	});

	it("rejects a malicious origin before setting a cookie", async () => {
		await expect(
			createDraftHandoffResponse(request("https://evil.example"), {
				marketingOrigin: "https://www.example.com",
				saasOrigin: "https://app.example.com",
				secure: true,
				isAuthenticated: false,
			}),
		).rejects.toThrow("FORBIDDEN_ORIGIN");
	});
});
