import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
	begin: vi.fn(),
	complete: vi.fn(),
}));

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));
vi.mock("@repo/database", () => ({
	beginGuestLinkIntentTransaction: databaseMocks.begin,
	completeGuestLinkIntentTransaction: databaseMocks.complete,
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("../lib/guest-capability", () => ({
	assertGuestCapabilityVersion: vi.fn(),
	hashGuestBinding: vi.fn(() => "b".repeat(64)),
	hashGuestSecret: vi.fn(() => "c".repeat(64)),
	loadGuestCapability: vi.fn(async () => ({
		snapshot: { version: "guest-v7" },
		config: {
			enabled: true,
			promotionPeriod: "launch-2026-08",
			linkIntentTtlMs: 15 * 60_000,
		},
	})),
}));

import { auth } from "@repo/auth";

import { beginGuestLinkIntent } from "./begin-guest-link-intent";
import { completeGuestLinkIntent } from "./complete-guest-link-intent";

const linkToken = "a".repeat(43);

describe("beginGuestLinkIntent response ordering", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://app.ezpic.test");
		vi.stubEnv("GUEST_ABUSE_HMAC_SECRET", "independent-guest-abuse-secret");
		vi.mocked(auth.api.getSession).mockImplementation(async (request) => {
			const headers = (request as { headers: Headers }).headers;
			return headers.get("x-test-principal") === "guest"
				? ({
						user: { id: "guest-1", isAnonymous: true },
						session: { id: "anonymous-session-1", userId: "guest-1" },
					} as never)
				: ({
						user: { id: "registered-1", isAnonymous: false },
						session: { id: "registered-session-1", userId: "registered-1" },
					} as never);
		});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("never lets a delayed LINKED begin response overwrite completion cookie deletion", async () => {
		let releaseBegin!: () => void;
		databaseMocks.begin.mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseBegin = () =>
						resolve({
							id: "intent-1",
							state: "LINKED",
							trialId: null,
							claimedDraftId: "draft-1",
							returnPath: "/create",
							expiresAt: new Date("2026-08-28T00:15:00.000Z"),
						});
				}),
		);
		databaseMocks.complete.mockResolvedValue({
			mode: "DRAFT",
			draftId: "draft-1",
			returnPath: "/create",
		});
		const beginResponseHeaders = new Headers();
		const beginCall = call(
			beginGuestLinkIntent,
			{
				capabilityVersion: "guest-v7",
				deviceId: "d4fbf8d2-945a-4f2c-8359-f179f6c734de",
				returnPath: "/create",
				idempotencyKey: "guest-link-order-0001",
			},
			{
				context: {
					headers: new Headers({
						origin: "https://app.ezpic.test",
						"x-test-principal": "guest",
					}),
					responseHeaders: beginResponseHeaders,
				},
			},
		);
		await vi.waitFor(() => expect(databaseMocks.begin).toHaveBeenCalledOnce());

		const completionResponseHeaders = new Headers();
		await expect(
			call(
				completeGuestLinkIntent,
				{},
				{
					context: {
						headers: new Headers({
							cookie: `media_guest_link_intent=${linkToken}`,
							"x-test-principal": "registered",
						}),
						responseHeaders: completionResponseHeaders,
					},
				},
			),
		).resolves.toMatchObject({ mode: "DRAFT", draftId: "draft-1" });
		expect(completionResponseHeaders.get("set-cookie")).toContain("Max-Age=0");

		releaseBegin();
		await expect(beginCall).rejects.toThrow("GUEST_LINK_UNAVAILABLE");
		expect(beginResponseHeaders.get("set-cookie")).toBeNull();
	});
});
