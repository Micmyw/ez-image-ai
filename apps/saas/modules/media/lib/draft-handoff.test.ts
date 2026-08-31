import { describe, expect, it } from "vitest";

import { createDraftHandoffResponse, DRAFT_HANDOFF_INTENT } from "./draft-handoff";

const claimToken = "c".repeat(43);

function request(
	origin = "https://www.example.com",
	requestUrl = "https://app.example.com/draft/continue",
	analytics?: { consent: boolean; anonymousSessionHash: string },
) {
	const form = new URLSearchParams({ intent: DRAFT_HANDOFF_INTENT, claimToken });
	if (analytics?.consent) {
		form.set("analyticsConsent", "true");
		form.set("anonymousSessionHash", analytics.anonymousSessionHash);
	}
	return new Request(requestUrl, {
		method: "POST",
		headers: {
			Origin: origin,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: form,
	});
}

function paidAccountRequest() {
	return new Request("https://app.example.com/draft/continue", {
		method: "POST",
		headers: {
			Origin: "https://www.example.com",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ intent: "continue-account-draft", claimToken }),
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
				isRegistered: false,
			},
		);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("https://app.example.com/draft/continue");
		expect(response.headers.get("location")).not.toContain(claimToken);
		expect(response.headers.get("set-cookie")).toContain(`media_draft_claim=${claimToken}`);
		expect(response.headers.get("set-cookie")).toContain("HttpOnly");
		expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
		expect(response.headers.get("set-cookie")).toContain("Secure");
		expect(response.headers.get("set-cookie")).toContain("Path=/draft/continue");
		expect(response.headers.getSetCookie().join("\n")).toContain(
			"Path=/api/auth/sign-in/anonymous",
		);
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	});

	it("rejects a malicious origin before setting a cookie", async () => {
		await expect(
			createDraftHandoffResponse(request("https://evil.example"), {
				marketingOrigin: "https://www.example.com",
				saasOrigin: "https://app.example.com",
				secure: true,
				isRegistered: false,
			}),
		).rejects.toThrow("FORBIDDEN_ORIGIN");
	});

	it("routes a paid-tier draft through login without creating an anonymous bootstrap", async () => {
		const response = await createDraftHandoffResponse(paidAccountRequest(), {
			marketingOrigin: "https://www.example.com",
			saasOrigin: "https://app.example.com",
			secure: true,
			isRegistered: false,
		});

		const location = new URL(response.headers.get("location")!);
		expect(location.pathname).toBe("/login");
		expect(location.searchParams.get("redirectTo")).toBe("/draft/continue");
		const cookies = response.headers.getSetCookie().join("\n");
		expect(cookies).toContain(`media_draft_claim=${claimToken}`);
		expect(cookies).not.toContain("media_guest_bootstrap");
	});

	it("restores consent and the anonymous funnel hash on the SaaS origin", async () => {
		const anonymousSessionHash =
			"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
		const response = await createDraftHandoffResponse(
			request("https://www.example.com", "https://app.example.com/draft/continue", {
				consent: true,
				anonymousSessionHash,
			}),
			{
				marketingOrigin: "https://www.example.com",
				saasOrigin: "https://app.example.com",
				secure: true,
				isRegistered: false,
			},
		);

		const cookies = response.headers.getSetCookie().join("\n");
		expect(cookies).toContain(`media_draft_claim=${claimToken}`);
		expect(cookies).toContain("consent=true");
		expect(cookies).toContain(
			`ezpic_analytics_session=${encodeURIComponent(anonymousSessionHash)}`,
		);
		expect(cookies).toMatch(/SameSite=(?:Lax|lax)/);
		expect(cookies).toContain("Secure");
		expect(cookies).not.toContain("HttpOnly; Path=/; Max-Age=2592000");
	});

	it("rejects malformed cross-app analytics identity", async () => {
		await expect(
			createDraftHandoffResponse(
				request("https://www.example.com", "https://app.example.com/draft/continue", {
					consent: true,
					anonymousSessionHash: "raw-user-id",
				}),
				{
					marketingOrigin: "https://www.example.com",
					saasOrigin: "https://app.example.com",
					secure: true,
					isRegistered: false,
				},
			),
		).rejects.toThrow("INVALID_DRAFT_HANDOFF");
	});
});
