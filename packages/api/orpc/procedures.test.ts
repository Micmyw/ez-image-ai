import { call, ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: {
		api: {
			getSession: vi.fn(),
		},
	},
}));

import { auth } from "@repo/auth";

import { guestMediaProcedure } from "../modules/media/guest-procedure";
import { adminProcedure, protectedProcedure, publicProcedure } from "./procedures";

describe("publicProcedure", () => {
	it("is defined", () => {
		expect(publicProcedure).toBeDefined();
	});
});

describe("protectedProcedure", () => {
	it("is defined", () => {
		expect(protectedProcedure).toBeDefined();
	});

	it("throws UNAUTHORIZED when session is null", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

		const testProcedure = protectedProcedure.handler(async () => ({
			success: true,
		}));

		await expect(
			call(testProcedure, undefined, {
				context: { headers: new Headers() },
			}),
		).rejects.toThrow(ORPCError);
		await expect(
			call(testProcedure, undefined, {
				context: { headers: new Headers() },
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("passes user and session to context when authenticated", async () => {
		const mockUser = { id: "user-1", role: "user", name: "Test User", isAnonymous: false };
		const mockSession = { id: "session-1", userId: "user-1" };
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: mockUser,
			session: mockSession,
		} as never);

		let capturedContext: unknown;
		const testProcedure = protectedProcedure.handler(async ({ context }: { context: unknown }) => {
			capturedContext = context;
			return { success: true };
		});

		await call(testProcedure, undefined, {
			context: { headers: new Headers() },
		});

		expect(capturedContext).toMatchObject({
			user: mockUser,
			session: mockSession,
		});
	});

	it("rejects an anonymous user at the registered procedure boundary", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest", role: "user", isAnonymous: true },
			session: { id: "guest-session", userId: "guest" },
		} as never);
		const testProcedure = protectedProcedure.handler(async () => ({ success: true }));

		await expect(
			call(testProcedure, undefined, { context: { headers: new Headers() } }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});

describe("guestMediaProcedure", () => {
	it("accepts only an anonymous Better Auth user", async () => {
		const testProcedure = guestMediaProcedure.handler(async ({ context }) => context.user.id);
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "registered", role: "user", isAnonymous: false },
			session: { id: "registered-session", userId: "registered" },
		} as never);
		await expect(
			call(testProcedure, undefined, { context: { headers: new Headers() } }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest", role: "user", isAnonymous: true },
			session: { id: "guest-session", userId: "guest" },
		} as never);
		await expect(
			call(testProcedure, undefined, { context: { headers: new Headers() } }),
		).resolves.toBe("guest");
	});
});

describe("adminProcedure", () => {
	it("is defined", () => {
		expect(adminProcedure).toBeDefined();
	});

	it("throws FORBIDDEN when user role is not admin", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "user-1", role: "user" },
			session: { id: "session-1" },
		} as never);

		const testProcedure = adminProcedure.handler(async () => ({
			success: true,
		}));

		await expect(
			call(testProcedure, undefined, {
				context: { headers: new Headers() },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("allows admin users through", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin-1", role: "admin" },
			session: { id: "session-1" },
		} as never);

		const testProcedure = adminProcedure.handler(async () => ({
			success: true,
		}));

		const result = await call(testProcedure, undefined, {
			context: { headers: new Headers() },
		});

		expect(result).toEqual({ success: true });
	});
});
