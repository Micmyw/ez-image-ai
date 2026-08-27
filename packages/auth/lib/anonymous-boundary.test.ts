import { describe, expect, it, vi } from "vitest";

import {
	assertAnonymousSession,
	assertRegisteredSession,
	isAnonymousUser,
	runRegisteredUserCreatedLifecycle,
} from "./anonymous-boundary";

const registeredSession = {
	user: { id: "registered", isAnonymous: false },
	session: { id: "registered-session", userId: "registered" },
};
const anonymousSession = {
	user: { id: "guest", isAnonymous: true },
	session: { id: "guest-session", userId: "guest" },
};

describe("anonymous authentication boundary", () => {
	it.each([
		[{ isAnonymous: true }, true],
		[{ isAnonymous: false }, false],
		[{ isAnonymous: null }, false],
		[{}, false],
	])("classifies Better Auth users without truthy coercion", (user, expected) => {
		expect(isAnonymousUser(user)).toBe(expected);
	});

	it("accepts registered sessions and rejects anonymous or missing sessions", () => {
		expect(() => assertRegisteredSession(registeredSession)).not.toThrow();
		expect(() => assertRegisteredSession(anonymousSession)).toThrow("REGISTERED_SESSION_REQUIRED");
		expect(() => assertRegisteredSession(null)).toThrow("REGISTERED_SESSION_REQUIRED");
	});

	it("accepts anonymous sessions and rejects registered or missing sessions", () => {
		expect(() => assertAnonymousSession(anonymousSession)).not.toThrow();
		expect(() => assertAnonymousSession(registeredSession)).toThrow("ANONYMOUS_SESSION_REQUIRED");
		expect(() => assertAnonymousSession(null)).toThrow("ANONYMOUS_SESSION_REQUIRED");
	});

	it("runs account-created lifecycle work only for registered users", async () => {
		const lifecycle = vi.fn(async () => undefined);

		await expect(
			runRegisteredUserCreatedLifecycle({ id: "guest", isAnonymous: true }, lifecycle),
		).resolves.toBe(false);
		expect(lifecycle).not.toHaveBeenCalled();

		await expect(
			runRegisteredUserCreatedLifecycle({ id: "registered", isAnonymous: false }, lifecycle),
		).resolves.toBe(true);
		expect(lifecycle).toHaveBeenCalledWith("registered");
	});
});
