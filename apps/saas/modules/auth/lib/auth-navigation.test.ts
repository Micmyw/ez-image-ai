import { describe, expect, it } from "vitest";

import { authErrorReturnPath } from "./auth-navigation";

describe("authentication cancellation recovery", () => {
	it("returns to login carrying the exact safe draft destination and invitation", () => {
		const redirectTo =
			"/create?model=image-nano-banana-2-lite&authDraft=10000000-0000-4000-8000-000000000001";
		const url = new URL(authErrorReturnPath(redirectTo, "invitation-a"), "https://ezimageai.com");
		expect(url.pathname).toBe("/login");
		expect(url.searchParams.get("redirectTo")).toBe(redirectTo);
		expect(url.searchParams.get("invitationId")).toBe("invitation-a");
	});
	it.each(["https://attacker.test", "//attacker.test", "/\\attacker.test"])(
		"rejects external return target %s",
		(path) => {
			expect(
				new URL(authErrorReturnPath(path), "https://ezimageai.com").searchParams.get("redirectTo"),
			).toBe("/create");
		},
	);
});
