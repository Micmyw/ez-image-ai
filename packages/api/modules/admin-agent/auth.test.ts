import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), key: vi.fn(), human: vi.fn() }));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.session } } }));
vi.mock("@repo/database/admin-access", () => ({
	validateAdminKey: mocks.key,
	getHumanAdminPrincipal: mocks.human,
}));

import { assertAdminControlActor, assertAdminSessionWriteOrigin, authenticateAdmin } from "./auth";
import type { AdminActor } from "./types";

const human: AdminActor = {
	actorId: "admin",
	actorType: "user",
	credentialId: null,
	scope: { kind: "platform" },
	permissions: ["admin.analytics.read"],
};
beforeEach(() => {
	vi.resetAllMocks();
	process.env.NEXT_PUBLIC_SAAS_URL = "https://ezpic.test";
	mocks.session.mockResolvedValue({ user: { id: "admin", role: "admin" } });
	mocks.human.mockResolvedValue(human);
	mocks.key.mockResolvedValue(null);
});

describe("admin credential boundary", () => {
	it.each(["Bearer invalid", "Basic abc", "", "Bearer product_key"])(
		"never falls back to a cookie for %s",
		async (authorization) => {
			await expect(
				authenticateAdmin(
					new Request("https://ezpic.test/api/admin/agent/operations", {
						headers: { authorization, cookie: "admin" },
					}),
				),
			).rejects.toMatchObject({ code: "ADMIN_KEY_INVALID" });
			expect(mocks.session).not.toHaveBeenCalled();
		},
	);
	it("requires Better Auth admin role and rechecks the current database role", async () => {
		mocks.session.mockResolvedValueOnce({ user: { id: "owner", role: "owner" } });
		await expect(authenticateAdmin(new Request("https://ezpic.test"))).rejects.toMatchObject({
			code: "HUMAN_ADMIN_REQUIRED",
		});
		mocks.human.mockResolvedValueOnce(null);
		await expect(authenticateAdmin(new Request("https://ezpic.test"))).rejects.toMatchObject({
			code: "HUMAN_ADMIN_REQUIRED",
		});
		expect(await authenticateAdmin(new Request("https://ezpic.test"))).toEqual(human);
	});
	it("requires configured same origin for browser writes and refuses machine control", () => {
		for (const origin of [undefined, "https://other.test"]) {
			expect(() =>
				assertAdminSessionWriteOrigin(
					new Request("https://ezpic.test", { headers: origin ? { Origin: origin } : {} }),
					human,
				),
			).toThrow("ADMIN_SAME_ORIGIN_REQUIRED");
		}
		expect(() =>
			assertAdminSessionWriteOrigin(
				new Request("https://spoof.test", { headers: { Origin: "https://ezpic.test" } }),
				human,
			),
		).not.toThrow();
		expect(() =>
			assertAdminControlActor({ ...human, actorType: "service", credentialId: "key" }),
		).toThrow("HUMAN_ADMIN_REQUIRED");
	});
});
