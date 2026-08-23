import { describe, expect, it } from "vitest";

import {
	assertMarketingOrigin,
	createDraftClaimToken,
	getDraftClaimCookie,
	hashDraftClaimToken,
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

	it("accepts exactly the configured marketing origin", () => {
		expect(() =>
			assertMarketingOrigin("https://studio.example.com", "https://studio.example.com"),
		).not.toThrow();
		expect(() =>
			assertMarketingOrigin("https://evil.example", "https://studio.example.com"),
		).toThrow("FORBIDDEN_ORIGIN");
		expect(() => assertMarketingOrigin(null, "https://studio.example.com")).toThrow(
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
