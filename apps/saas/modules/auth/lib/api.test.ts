import { useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	loaded: vi.fn(),
	getSession: vi.fn(),
	listAccounts: vi.fn(),
	listUserPasskeys: vi.fn(),
}));

vi.mock("@repo/auth/client", () => {
	mocks.loaded();
	return {
		authClient: {
			getSession: mocks.getSession,
			listAccounts: mocks.listAccounts,
			passkey: { listUserPasskeys: mocks.listUserPasskeys },
		},
	};
});
vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }));

import { listUserPasskeys, useSessionQuery, useUserAccountsQuery } from "./api";

function queryFunction() {
	return vi.mocked(useQuery).mock.lastCall![0].queryFn as () => Promise<unknown>;
}

describe("deferred authentication queries", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("leaves the authentication SDK out of module initialization", async () => {
		expect(mocks.loaded).not.toHaveBeenCalled();
		useSessionQuery();
		expect(mocks.loaded).not.toHaveBeenCalled();
		const fetch = vi.fn().mockResolvedValueOnce(new Response("null"));
		vi.stubGlobal("fetch", fetch);
		await expect(queryFunction()()).resolves.toBeNull();
		expect(mocks.loaded).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledWith("/api/auth/get-session?disableCookieCache=true", {
			credentials: "include",
			cache: "no-store",
		});
	});

	it("returns the signed-in session and preserves authentication errors", async () => {
		useSessionQuery();
		const expiresAt = "2026-11-01T00:00:00.000Z";
		const session = {
			user: { id: "member", isAnonymous: false },
			session: { id: "session", expiresAt },
		};
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(Response.json(session))
				.mockResolvedValueOnce(Response.json({ message: "Session unavailable" }, { status: 503 })),
		);
		await expect(queryFunction()()).resolves.toEqual({
			...session,
			session: { ...session.session, expiresAt: new Date(expiresAt) },
		});
		await expect(queryFunction()()).rejects.toThrow("Session unavailable");
	});
	it("does not turn malformed or failed session reads into anonymous success", async () => {
		useSessionQuery();
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(new Response("<html>unavailable</html>"))
				.mockRejectedValueOnce(new Error("offline")),
		);
		await expect(queryFunction()()).rejects.toThrow("Failed to fetch session");
		await expect(queryFunction()()).rejects.toThrow("offline");
	});

	it("preserves linked-account and passkey responses", async () => {
		useUserAccountsQuery();
		const accounts = [{ id: "account" }];
		mocks.listAccounts.mockResolvedValueOnce({ data: accounts, error: null });
		await expect(queryFunction()()).resolves.toBe(accounts);
		mocks.listUserPasskeys.mockResolvedValueOnce({ data: null, error: null });
		await expect(listUserPasskeys()).resolves.toEqual([]);
		const error = new Error("Passkeys unavailable");
		mocks.listUserPasskeys.mockResolvedValueOnce({ data: null, error });
		await expect(listUserPasskeys()).rejects.toBe(error);
	});
});
