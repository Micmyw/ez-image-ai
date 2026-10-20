import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	loaded: vi.fn(),
	signIn: vi.fn(),
	getSession: vi.fn(),
}));

vi.mock("@repo/auth/client", () => {
	mocks.loaded();
	return {
		authClient: {
			signIn: { email: mocks.signIn },
			getSession: mocks.getSession,
		},
	};
});

import { loadAuthClient, preloadAuthClient } from "./auth-client";

describe("authentication SDK loading", () => {
	it("loads only on intent and shares the original singleton without sending auth requests", async () => {
		expect(mocks.loaded).not.toHaveBeenCalled();
		preloadAuthClient();
		const firstLoad = loadAuthClient();
		const secondLoad = loadAuthClient();
		expect(secondLoad).toBe(firstLoad);
		const client = await firstLoad;
		expect(await secondLoad).toBe(client);
		expect(client.signIn.email).toBe(mocks.signIn);
		expect(mocks.loaded).toHaveBeenCalledOnce();
		expect(mocks.signIn).not.toHaveBeenCalled();
		expect(mocks.getSession).not.toHaveBeenCalled();
	});
});
