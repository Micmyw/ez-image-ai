import { describe, expect, it } from "vitest";

import {
	assertExactOrigin,
	createDraftClaimToken,
	getDraftClaimCookie,
	hashDraftClaimToken,
	resolveGuestPublicOrigin,
} from "./draft-security";

describe("draft claim security", () => {
	it("creates at least 256 bits of unguessable material and stores only its hash", () => {
		const first = createDraftClaimToken();
		const second = createDraftClaimToken();

		expect(Buffer.from(first, "base64url")).toHaveLength(32);
		expect(first).not.toBe(second);
		expect(hashDraftClaimToken(first)).toMatch(/^[a-f0-9]{64}$/);
		expect(hashDraftClaimToken(first)).not.toContain(first);
	});

	it("accepts exactly the configured public origin", () => {
		expect(() =>
			assertExactOrigin("https://studio.example.com", "https://studio.example.com"),
		).not.toThrow();
		expect(() => assertExactOrigin("https://evil.example", "https://studio.example.com")).toThrow(
			"FORBIDDEN_ORIGIN",
		);
		expect(() => assertExactOrigin(null, "https://studio.example.com")).toThrow("FORBIDDEN_ORIGIN");
	});

	it("accepts only the configured SaaS origin", () => {
		expect(
			resolveGuestPublicOrigin("https://app.example.com", {
				saasOrigin: "https://app.example.com",
			}),
		).toBe("https://app.example.com");
		expect(() =>
			resolveGuestPublicOrigin("https://www.example.com", {
				saasOrigin: "https://app.example.com",
			}),
		).toThrow("FORBIDDEN_ORIGIN");
		expect(() =>
			resolveGuestPublicOrigin("https://evil.example.com", {
				saasOrigin: "https://app.example.com",
			}),
		).toThrow("FORBIDDEN_ORIGIN");
		expect(() => resolveGuestPublicOrigin(null, { saasOrigin: "https://app.example.com" })).toThrow(
			"FORBIDDEN_ORIGIN",
		);
		expect(() => resolveGuestPublicOrigin("not an origin", { saasOrigin: "not a URL" })).toThrow(
			"FORBIDDEN_ORIGIN",
		);
	});

	it("serializes a short-lived HttpOnly cookie without leaking the token to another path", () => {
		const cookie = getDraftClaimCookie("secret", true);
		expect(cookie).toContain("media_draft_claim=secret");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("Path=/draft/continue");
		expect(cookie).toContain("Max-Age=3600");
	});
});
