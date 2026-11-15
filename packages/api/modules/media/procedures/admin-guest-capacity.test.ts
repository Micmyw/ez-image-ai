import { call } from "@orpc/server";
import { auth } from "@repo/auth";
import { getAdminGuestPrincipalCapacity, setAdminGuestPrincipalCapacity } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	getAdminGuestPrincipalCapacity: vi.fn(),
	setAdminGuestPrincipalCapacity: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));

import { adminGuestCapacity, setGuestPrincipalCapacity } from "./admin-guest-capacity";

const context = { context: { headers: new Headers() } };
const input = {
	maximumTemporaryPrincipals: 250,
	idempotencyKey: "guest-capacity-update-1",
	reason: "Increase capacity for new guest trials",
};

describe("administrator guest capacity API", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin-1", role: "admin" },
			session: { id: "session-1" },
		} as never);
	});
	it.each(["user", null])("denies capacity reads and writes for role %s", async (role) => {
		vi.mocked(auth.api.getSession).mockResolvedValue(
			role
				? ({
						user: { id: "user-1", role },
						session: { id: "session-1" },
					} as never)
				: null,
		);
		await expect(call(adminGuestCapacity, undefined, context)).rejects.toMatchObject({
			code: role ? "FORBIDDEN" : "UNAUTHORIZED",
		});
		await expect(call(setGuestPrincipalCapacity, input, context)).rejects.toMatchObject({
			code: role ? "FORBIDDEN" : "UNAUTHORIZED",
		});
		expect(getAdminGuestPrincipalCapacity).not.toHaveBeenCalled();
		expect(setAdminGuestPrincipalCapacity).not.toHaveBeenCalled();
	});
	it("returns the effective capacity and occupancy without identity records", async () => {
		vi.mocked(getAdminGuestPrincipalCapacity).mockResolvedValue({
			generatedAt: "2026-11-15T07:40:00Z",
			maximumTemporaryPrincipals: 100,
			version: 0,
			source: "environment",
			anonymousPrincipals: 20,
			activePrincipalLeases: 0,
			used: 20,
			remaining: 80,
		});
		await expect(call(adminGuestCapacity, undefined, context)).resolves.toMatchObject({
			maximumTemporaryPrincipals: 100,
			used: 20,
			remaining: 80,
		});
	});
	it("persists a numeric capacity using the authenticated administrator", async () => {
		vi.mocked(setAdminGuestPrincipalCapacity).mockResolvedValue({
			maximumTemporaryPrincipals: 250,
			version: 4,
			replayed: false,
		});
		await expect(call(setGuestPrincipalCapacity, input, context)).resolves.toMatchObject({
			maximumTemporaryPrincipals: 250,
			version: 4,
		});
		expect(setAdminGuestPrincipalCapacity).toHaveBeenCalledWith(
			{ ...input, actorUserId: "admin-1" },
			{},
		);
	});
	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid capacity %s",
		async (maximumTemporaryPrincipals) => {
			await expect(
				call(setGuestPrincipalCapacity, { ...input, maximumTemporaryPrincipals }, context),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(setAdminGuestPrincipalCapacity).not.toHaveBeenCalled();
		},
	);
	it("requires a reason and a stable operation key", async () => {
		for (const invalid of [{ reason: "short" }, { idempotencyKey: "short" }]) {
			await expect(
				call(setGuestPrincipalCapacity, { ...input, ...invalid }, context),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(setAdminGuestPrincipalCapacity).not.toHaveBeenCalled();
	});
	it("returns a conflict for a changed replay", async () => {
		vi.mocked(setAdminGuestPrincipalCapacity).mockRejectedValue(new Error("IDEMPOTENCY_CONFLICT"));
		await expect(call(setGuestPrincipalCapacity, input, context)).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});
});
