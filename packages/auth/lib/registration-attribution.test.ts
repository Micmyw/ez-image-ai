import { ATTRIBUTION_COOKIE_NAME, type FirstTouchAttribution } from "@repo/utils";
import { describe, expect, it, vi } from "vitest";

import {
	getRegistrationAttributionSnapshot,
	persistNewUserRegistrationAttribution,
	shouldClearRegistrationAttributionCookie,
} from "./registration-attribution";

const now = new Date("2026-10-08T12:00:00.000Z");
const origin = "https://ezimageai.com";
const firstTouch: FirstTouchAttribution = {
	version: 1,
	landingPath: "/blog/a-photo-guide?email=private@example.test#token",
	referrerOrigin: "https://www.google.com/search?q=private",
	source: "campaign",
	utmSource: "google",
	utmMedium: "search",
	utmCampaign: "photo-guide",
	capturedAt: "2026-10-07T12:00:00.000Z",
};

function context(path: string, value: unknown = firstTouch, consent = "true") {
	return {
		path,
		request: new Request(`${origin}/api/auth${path}`, {
			headers: {
				cookie: `consent=${consent}; ${ATTRIBUTION_COOKIE_NAME}=${encodeURIComponent(JSON.stringify(value))}`,
			},
		}),
	};
}

describe("registration attribution boundary", () => {
	it.each([
		"/sign-up/email",
		"/sign-in/social",
		"/callback/google",
		"/callback/github",
		"/magic-link/verify",
	])("takes a sanitized server-time snapshot for the %s creation hook", async (path) => {
		const save = vi.fn().mockResolvedValue(true);
		await expect(
			persistNewUserRegistrationAttribution({ id: "new-user" }, context(path), {
				origin,
				now,
				save,
			}),
		).resolves.toBe(true);
		expect(save).toHaveBeenCalledWith("new-user", {
			...firstTouch,
			landingPath: "/blog/a-photo-guide",
			referrerOrigin: "https://www.google.com",
			registeredAt: now.toISOString(),
		});
	});

	it.each(["false", "", "TRUE", "1"])("requires explicit consent=true (%s)", (consent) => {
		expect(
			getRegistrationAttributionSnapshot(
				context("/sign-up/email", firstTouch, consent),
				origin,
				now,
			),
		).toBeNull();
	});

	it("accepts Better Auth's OAuth route template only for a configured provider", () => {
		for (const id of ["google", "github"]) {
			expect(
				getRegistrationAttributionSnapshot(
					{ ...context("/callback/:id"), params: { id } },
					origin,
					now,
				),
			).toMatchObject({ landingPath: "/blog/a-photo-guide" });
		}
		for (const id of [undefined, "unconfigured-provider", "../../sign-up/email"]) {
			expect(
				getRegistrationAttributionSnapshot(
					{ ...context("/callback/:id"), params: { id } },
					origin,
					now,
				),
			).toBeNull();
		}
	});

	it.each([
		"/sign-in/email",
		"/sign-in/anonymous",
		"/admin/create-user",
		"/sign-in/magic-link",
		"/callback/unconfigured-provider",
	])("does not attach a browser's source from %s", (path) =>
		expect(getRegistrationAttributionSnapshot(context(path), origin, now)).toBeNull(),
	);

	it("does not infer a first touch when cookies are missing, blocked, malformed, or stale", () => {
		for (const cookie of [
			"",
			"consent=true",
			`consent=true; ${ATTRIBUTION_COOKIE_NAME}=%invalid`,
			`consent=true; ${ATTRIBUTION_COOKIE_NAME}=${"a".repeat(4097)}`,
		]) {
			expect(
				getRegistrationAttributionSnapshot(
					{ path: "/sign-up/email", headers: new Headers({ cookie }) },
					origin,
					now,
				),
			).toBeNull();
		}
		expect(
			getRegistrationAttributionSnapshot(
				context("/sign-up/email", { ...firstTouch, capturedAt: "2026-01-01T12:00:00.000Z" }),
				origin,
				now,
			),
		).toBeNull();
		expect(getRegistrationAttributionSnapshot(null, origin, now)).toBeNull();
	});

	it("leaves anonymous bootstrap unrecorded and binds the snapshot to the adapter's new user", async () => {
		const save = vi.fn().mockResolvedValue(true);
		await expect(
			persistNewUserRegistrationAttribution(
				{ id: "guest", isAnonymous: true },
				context("/sign-up/email"),
				{ origin, now, save },
			),
		).resolves.toBe(false);
		expect(save).not.toHaveBeenCalled();
		await persistNewUserRegistrationAttribution(
			{ id: "new-principal", isAnonymous: false },
			context("/sign-up/email"),
			{ origin, now, save },
		);
		expect(save.mock.calls[0]?.[0]).toBe("new-principal");
	});

	it("clears a successful signup before verification, and clears only established registered sessions on login", () => {
		expect(
			shouldClearRegistrationAttributionCookie({
				path: "/sign-up/email",
				context: { returned: { token: null, user: { id: "new" } } },
			}),
		).toBe(true);
		expect(
			shouldClearRegistrationAttributionCookie({
				path: "/callback/google",
				context: { newSession: { user: { id: "new" } } },
			}),
		).toBe(true);
		expect(
			shouldClearRegistrationAttributionCookie({
				path: "/sign-in/email",
				context: { newSession: { user: { id: "existing" } } },
			}),
		).toBe(true);
		expect(
			shouldClearRegistrationAttributionCookie({
				path: "/sign-in/anonymous",
				context: { newSession: { user: { id: "guest", isAnonymous: true } } },
			}),
		).toBe(false);
		for (const path of [
			"/sign-in/social",
			"/sign-in/magic-link",
			"/callback/google",
			"/sign-up/email",
		]) {
			expect(
				shouldClearRegistrationAttributionCookie({
					path,
					context: { returned: { error: "failed" } },
				}),
			).toBe(false);
		}
	});

	it("clears sign-out only when Better Auth returns success=true", () => {
		expect(
			shouldClearRegistrationAttributionCookie({
				path: "/sign-out",
				context: { returned: { success: true } },
			}),
		).toBe(true);
		for (const returned of [
			undefined,
			null,
			{ success: false },
			{ success: "true" },
			{ error: "failed" },
			new Error("failed"),
		]) {
			expect(
				shouldClearRegistrationAttributionCookie({
					path: "/sign-out",
					context: { returned, newSession: { user: { id: "previous-account" } } },
				}),
			).toBe(false);
		}
	});
});
