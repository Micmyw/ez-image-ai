import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));

vi.mock("@repo/database", () => ({
	beginGuestLinkIntentTransaction: vi.fn(),
	completeGuestLinkIntentTransaction: vi.fn(),
	resolveGuestRuntimeConfigOverride: vi.fn(),
}));

vi.mock("@repo/database/client", () => ({ db: {} }));

import { auth } from "@repo/auth";
import { completeGuestLinkIntentTransaction } from "@repo/database";

import { completeGuestLinkIntent } from "./complete-guest-link-intent";

const linkToken = "a".repeat(43);

describe("completeGuestLinkIntent", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "registered-user", isAnonymous: false },
			session: { id: "registered-session" },
		} as never);
	});

	it("retains the durable intent cookie when completion fails so the registered session can retry", async () => {
		vi.mocked(completeGuestLinkIntentTransaction).mockRejectedValue(
			new Error("database unavailable"),
		);
		const responseHeaders = new Headers();

		await expect(
			call(
				completeGuestLinkIntent,
				{},
				{
					context: {
						headers: new Headers({ cookie: `media_guest_link_intent=${linkToken}` }),
						responseHeaders,
					},
				},
			),
		).rejects.toThrow("database unavailable");

		expect(responseHeaders.get("set-cookie")).toBeNull();
	});

	it("clears the one-time intent cookie after completion commits", async () => {
		vi.mocked(completeGuestLinkIntentTransaction).mockResolvedValue({
			mode: "DRAFT",
			draftId: "draft-1",
			returnPath: "/create",
		});
		const responseHeaders = new Headers();

		await expect(
			call(
				completeGuestLinkIntent,
				{},
				{
					context: {
						headers: new Headers({ cookie: `media_guest_link_intent=${linkToken}` }),
						responseHeaders,
					},
				},
			),
		).resolves.toEqual({ mode: "DRAFT", draftId: "draft-1", returnPath: "/create" });

		expect(responseHeaders.get("set-cookie")).toContain("Max-Age=0");
		const claimedCookie = responseHeaders
			.getSetCookie()
			.find((value) => value.startsWith("media_claimed_draft="));
		expect(claimedCookie).toContain("media_claimed_draft=draft-1");
		expect(claimedCookie).toContain("HttpOnly");
		expect(claimedCookie).toContain("SameSite=Lax");
		expect(claimedCookie).toContain("Path=/create;");
		expect(claimedCookie).toContain("Max-Age=300");
	});
	it("keeps result-only grants on /try without creating an editor draft cookie", async () => {
		vi.mocked(completeGuestLinkIntentTransaction).mockResolvedValue({
			mode: "RESULT",
			jobId: "guest-job-1",
			returnPath: "/try",
			expiresAt: new Date("2026-10-01T00:00:00.000Z"),
		});
		const responseHeaders = new Headers();
		const result = await call(
			completeGuestLinkIntent,
			{},
			{
				context: {
					headers: new Headers({ cookie: `media_guest_link_intent=${linkToken}` }),
					responseHeaders,
				},
			},
		);
		expect(result).toMatchObject({ mode: "RESULT", jobId: "guest-job-1", returnPath: "/try" });
		expect(responseHeaders.getSetCookie().join("\n")).not.toContain("media_claimed_draft");
	});
	it.each(["/blog/1980s-ai-photo", "/effects/1980s-ai-photo"])(
		"scopes a claimed preset draft from %s to its canonical registered article",
		async (pathname) => {
			vi.mocked(completeGuestLinkIntentTransaction).mockResolvedValue({
				mode: "DRAFT",
				draftId: "draft-1",
				returnPath: "/try",
			});
			const responseHeaders = new Headers();
			await call(
				completeGuestLinkIntent,
				{},
				{
					context: {
						headers: new Headers({
							cookie: `media_guest_link_intent=${linkToken}; media_effect_return=${encodeURIComponent(`${pathname}?preset=studio-portrait`)}`,
						}),
						responseHeaders,
					},
				},
			);
			const claimedCookie = responseHeaders
				.getSetCookie()
				.find((value) => value.startsWith("media_claimed_draft="));
			expect(claimedCookie).toContain("Path=/blog/1980s-ai-photo;");
			expect(claimedCookie).toContain("HttpOnly");
			expect(claimedCookie).toContain("SameSite=Lax");
			expect(claimedCookie).toContain("Max-Age=300");
		},
	);
	it.each([
		"/blog/unregistered-photo-idea?preset=studio-portrait",
		"/effects/unregistered-photo-idea?preset=studio-portrait",
		"/blog/1980s-ai-photo?preset=studio-portrait&prompt=private",
		"/blog/1980s-ai-photo?preset=studio-portrait&preset=neon-street",
		"/blog/1980s-ai-photo?preset=studio-portrait#private",
		"https://attacker.example/blog/1980s-ai-photo?preset=studio-portrait",
	])(
		"does not widen claimed draft cookie scope for an unsafe article return: %s",
		async (returnTo) => {
			vi.mocked(completeGuestLinkIntentTransaction).mockResolvedValue({
				mode: "DRAFT",
				draftId: "draft-1",
				returnPath: "/create",
			});
			const responseHeaders = new Headers();
			await call(
				completeGuestLinkIntent,
				{},
				{
					context: {
						headers: new Headers({
							cookie: `media_guest_link_intent=${linkToken}; media_effect_return=${encodeURIComponent(returnTo)}`,
						}),
						responseHeaders,
					},
				},
			);
			expect(
				responseHeaders.getSetCookie().find((value) => value.startsWith("media_claimed_draft=")),
			).toContain("Path=/create;");
		},
	);
	it("ignores a corrupt effect return cookie after a successful draft transfer", async () => {
		vi.mocked(completeGuestLinkIntentTransaction).mockResolvedValue({
			mode: "DRAFT",
			draftId: "draft-1",
			returnPath: "/create",
		});
		const responseHeaders = new Headers();
		await expect(
			call(
				completeGuestLinkIntent,
				{},
				{
					context: {
						headers: new Headers({
							cookie: `media_guest_link_intent=${linkToken}; media_effect_return=%GG`,
						}),
						responseHeaders,
					},
				},
			),
		).resolves.toMatchObject({ mode: "DRAFT" });
		expect(
			responseHeaders.getSetCookie().find((value) => value.startsWith("media_claimed_draft=")),
		).toContain("Path=/create;");
	});
});
