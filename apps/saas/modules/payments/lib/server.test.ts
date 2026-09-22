import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	listPurchases: vi.fn(),
	callable: vi.fn(),
	headers: new Headers({ cookie: "test-session=local-fixture" }),
}));

vi.mock("@auth/lib/server", () => ({ getSession: mocks.getSession }));
vi.mock("@repo/api/modules/payments/procedures/list-purchases", () => ({
	listPurchases: { callable: mocks.callable },
}));
vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));

import { listPurchases } from "./server";

describe("server-rendered purchases authentication", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.callable.mockReturnValue(mocks.listPurchases);
		mocks.listPurchases.mockResolvedValue([]);
		mocks.getSession.mockResolvedValue(null);
	});

	it("redirects a missing or expired session to login instead of throwing Unauthorized", async () => {
		mocks.listPurchases.mockRejectedValue(new ORPCError("UNAUTHORIZED"));

		await expect(listPurchases()).rejects.toMatchObject({
			digest: "NEXT_REDIRECT;replace;/login;307;",
		});
	});

	it("redirects an anonymous trial session to the guest workspace", async () => {
		mocks.getSession.mockResolvedValue({ user: { id: "guest", isAnonymous: true } });
		mocks.listPurchases.mockRejectedValue(new ORPCError("UNAUTHORIZED"));

		await expect(listPurchases()).rejects.toMatchObject({
			digest: "NEXT_REDIRECT;replace;/try;307;",
		});
	});

	it("honors API rejection when a previously checked session expires during rendering", async () => {
		mocks.getSession.mockResolvedValue({ user: { id: "member", isAnonymous: false } });
		mocks.listPurchases.mockRejectedValue(new ORPCError("UNAUTHORIZED"));

		await expect(listPurchases()).rejects.toMatchObject({
			digest: "NEXT_REDIRECT;replace;/login;307;",
		});
	});

	it.each([undefined, "organization-1"])(
		"preserves the authenticated API result and owner scope (%s)",
		async (organizationId) => {
			const purchases = [{ id: "purchase-1" }];
			mocks.listPurchases.mockResolvedValue(purchases);

			await expect(listPurchases(organizationId)).resolves.toBe(purchases);
			expect(mocks.callable).toHaveBeenCalledWith({ context: { headers: mocks.headers } });
			expect(mocks.listPurchases).toHaveBeenCalledWith({ organizationId });
			expect(mocks.getSession).not.toHaveBeenCalled();
		},
	);

	it.each([
		new ORPCError("FORBIDDEN"),
		new ORPCError("INTERNAL_SERVER_ERROR"),
		new Error("Unauthorized"),
	])("keeps non-authentication errors visible (%s)", async (error) => {
		mocks.listPurchases.mockRejectedValue(error);

		await expect(listPurchases()).rejects.toBe(error);
		expect(mocks.getSession).not.toHaveBeenCalled();
	});
});
