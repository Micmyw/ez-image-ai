import { describe, expect, it, vi } from "vitest";

import { persistRegistrationConversion } from "./registration-conversion";

const hash = `sha256:${"a".repeat(64)}`;
const headers = new Headers({
	cookie: `consent=true; consent_version=2; ezpic_analytics_session=${hash}`,
	"user-agent": "iPhone Mobile",
});
describe("server registration observation", () => {
	it.each(["/sign-up/email", "/callback/google", "/callback/github", "/magic-link/verify"])(
		"links a newly created account on %s with a stable server-only ID",
		async (path) => {
			const save = vi.fn();
			expect(
				await persistRegistrationConversion(
					{ id: "new-user" },
					{ path, headers },
					{ origin: "https://ezimageai.com", save },
				),
			).toBe(true);
			expect(save).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "registration:new-user",
					name: "registration_confirmed",
					userId: "new-user",
					sessionHash: hash,
					device: "mobile",
					source: null,
				}),
			);
		},
	);
	it("never backfills ordinary logins, guest accounts or unconsented registrations", async () => {
		const save = vi.fn();
		const deps = { origin: "https://ezimageai.com", save };
		await persistRegistrationConversion({ id: "user" }, { path: "/sign-in/email", headers }, deps);
		await persistRegistrationConversion(
			{ id: "guest", isAnonymous: true },
			{ path: "/sign-up/email", headers },
			deps,
		);
		await persistRegistrationConversion(
			{ id: "user" },
			{ path: "/sign-up/email", headers: new Headers() },
			deps,
		);
		expect(save).not.toHaveBeenCalled();
	});
});
