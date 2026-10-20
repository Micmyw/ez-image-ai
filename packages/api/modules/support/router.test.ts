import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	SupportError: class SupportError extends Error {
		constructor(readonly code: string) {
			super(`SUPPORT_${code}`);
		}
	},
}));
vi.mock("./service", () => ({
	createCustomerTicket: vi.fn(),
	getCustomerTicket: vi.fn(),
	listCustomerTickets: vi.fn(),
	replyCustomerTicket: vi.fn(),
}));
import { auth } from "@repo/auth";
import { SupportError } from "@repo/database";

import { supportRouter } from "./router";
import { createCustomerTicket, getCustomerTicket, listCustomerTickets } from "./service";

const context = () => ({ headers: new Headers(), responseHeaders: new Headers() });
describe("customer support API through actual session middleware", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "current-customer", role: "user", isAnonymous: false },
			session: { id: "session" },
		} as never);
	});
	it.each([null, { user: { id: "guest", isAnonymous: true }, session: { id: "guest-session" } }])(
		"denies missing/anonymous sessions",
		async (session) => {
			vi.mocked(auth.api.getSession).mockResolvedValue(session as never);
			await expect(call(supportRouter.list, {}, { context: context() })).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
			expect(listCustomerTickets).not.toHaveBeenCalled();
		},
	);
	it("derives owner from the session and marks private responses no-store", async () => {
		vi.mocked(listCustomerTickets).mockResolvedValue({
			items: [],
			total: 0,
			page: 1,
			pageSize: 20,
		});
		const requestContext = context();
		await call(supportRouter.list, {}, { context: requestContext });
		expect(listCustomerTickets).toHaveBeenCalledWith("current-customer", { page: 1, pageSize: 20 });
		expect(requestContext.responseHeaders.get("Cache-Control")).toBe("private, no-store");
		expect(requestContext.responseHeaders.get("X-Robots-Tag")).toBe("noindex, nofollow");
	});
	it("rejects customer-supplied identity fields before creating a ticket", async () => {
		await expect(
			call(
				supportRouter.create,
				{
					subject: "Support",
					body: "Help",
					requestKey: "request-key",
					userId: "someone-else",
				} as never,
				{ context: context() },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(createCustomerTicket).not.toHaveBeenCalled();
	});
	it.each([
		["NOT_FOUND", "NOT_FOUND"],
		["FORBIDDEN", "FORBIDDEN"],
		["CONFLICT", "CONFLICT"],
		["RATE_LIMITED", "TOO_MANY_REQUESTS"],
	] as const)("maps persisted %s boundary without leaking thread content", async (reason, code) => {
		vi.mocked(getCustomerTicket).mockRejectedValue(new SupportError(reason));
		await expect(
			call(supportRouter.get, { ticketId: "private-ticket" }, { context: context() }),
		).rejects.toMatchObject({ code });
		expect(getCustomerTicket).toHaveBeenCalledWith("current-customer", {
			ticketId: "private-ticket",
		});
	});
});
