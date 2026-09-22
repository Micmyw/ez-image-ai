import { useQuery } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

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
	it("leaves the authentication SDK out of module initialization", async () => {
		expect(mocks.loaded).not.toHaveBeenCalled();
		useSessionQuery();
		expect(mocks.loaded).not.toHaveBeenCalled();
		mocks.getSession.mockResolvedValueOnce({ data: null, error: null });
		await expect(queryFunction()()).resolves.toBeNull();
		expect(mocks.loaded).toHaveBeenCalledOnce();
		expect(mocks.getSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } });
	});

	it("returns the signed-in session and preserves authentication errors", async () => {
		useSessionQuery();
		const session = { user: { id: "member" }, session: { id: "session" } };
		mocks.getSession.mockResolvedValueOnce({ data: session, error: null });
		await expect(queryFunction()()).resolves.toBe(session);
		mocks.getSession.mockResolvedValueOnce({
			data: null,
			error: { message: "Session unavailable" },
		});
		await expect(queryFunction()()).rejects.toThrow("Session unavailable");
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
