import { call, ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => vi.fn());
vi.mock("@repo/logs", () => ({ logger: { info: log } }));

vi.mock("@repo/auth", () => ({
	auth: {
		api: {
			getSession: vi.fn(),
		},
	},
}));

import { auth } from "@repo/auth";
import {
	createLazyDatabaseClient,
	createRuntimeDatabaseClient,
	runWithDatabaseClient,
} from "@repo/database/client";

import { guestMediaProcedure } from "../modules/media/guest-procedure";
import { adminProcedure, protectedProcedure, publicProcedure } from "./procedures";

beforeEach(() => log.mockClear());
afterEach(() => vi.restoreAllMocks());

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

	it.each(["identity", "handler"] as const)(
		"records successful client construction during %s without attributing awaited work to SQL or CPU",
		async (constructionPhase) => {
			const lazy = createLazyDatabaseClient(() =>
				createRuntimeDatabaseClient(
					"postgresql://private-secret:private-secret@localhost/private-db",
				),
			);
			vi.mocked(auth.api.getSession).mockImplementation(async () => {
				if (constructionPhase === "identity") void lazy.user;
				return {
					user: { id: "user-1", isAnonymous: false },
					session: { id: "private-session" },
				} as never;
			});
			const testProcedure = protectedProcedure.handler(async ({ context }) => {
				if (constructionPhase === "handler") void lazy.user;
				return context.user.id;
			});
			await expect(
				runWithDatabaseClient(lazy, () =>
					call(testProcedure, undefined, {
						path: ["media", "getJob"],
						context: {
							headers: new Headers({ cookie: "private-cookie" }),
							requestId: "request-1",
						},
					}),
				),
			).resolves.toBe("user-1");
			await lazy.$disconnect();
			expect(log).toHaveBeenCalledTimes(2);
			expect(log).toHaveBeenCalledWith(
				"media.flow.timing",
				expect.objectContaining({
					requestId: "request-1",
					stage: "request.database.client.construct",
					stageMs: expect.any(Number),
					outcome: "ok",
					connectionWaitMs: null,
					sqlExecutionMs: null,
				}),
			);
			expect(log).toHaveBeenCalledWith(
				"media.flow.timing",
				expect.objectContaining({ stage: "request.identity", outcome: "ok" }),
			);
			expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|cookie|cpuMs/i);
		},
	);

	it("leaves unobserved construction unknown and retains authorization on the timed status path", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest", isAnonymous: true },
			session: { id: "guest-session" },
		} as never);
		const handler = vi.fn(async () => ({ success: true }));
		const testProcedure = protectedProcedure.handler(handler);
		await expect(
			call(testProcedure, undefined, {
				path: ["media", "getJob"],
				context: { headers: new Headers() },
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(handler).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0][1].stage).toBe("request.identity");
	});

	it("does not enable construction logging for other procedures", async () => {
		const constructed: ReturnType<typeof createRuntimeDatabaseClient>[] = [];
		vi.mocked(auth.api.getSession).mockImplementation(async () => {
			constructed.push(createRuntimeDatabaseClient("postgresql://unused:unused@localhost/unused"));
			return {
				user: { id: "user-1", isAnonymous: false },
				session: { id: "session-1" },
			} as never;
		});
		const testProcedure = protectedProcedure.handler(async () => ({ success: true }));
		for (const path of [
			["media", "createQuote"],
			["organizations", "get"],
		]) {
			await call(testProcedure, undefined, { path, context: { headers: new Headers() } });
		}
		await Promise.all(constructed.map((value) => value.$disconnect()));
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0][1].stage).toBe("request.identity");
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
