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
	});
});
