import { describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ db: {} }));

import {
	getAdminSupportTicketRow,
	getCustomerSupportTicketRow,
	replyAdminSupportTicketRow,
	supportScopeWhere,
} from "./admin-support";

describe("support ownership boundaries", () => {
	it("keeps organization and personal service scopes distinct", () => {
		expect(supportScopeWhere({ kind: "user", userId: "owner" })).toEqual({
			createdByUserId: "owner",
			organizationId: null,
		});
		expect(supportScopeWhere({ kind: "organization", organizationId: "org" })).toEqual({
			organizationId: "org",
		});
		expect(supportScopeWhere({ kind: "platform" })).toEqual({});
		expect(() => supportScopeWhere({ kind: "invalid" } as never)).toThrow("SUPPORT_FORBIDDEN");
	});
	it("queries customer ownership before exposing a thread", async () => {
		const findFirst = vi.fn().mockResolvedValue(null);
		await expect(
			getCustomerSupportTicketRow("alice", "bob-ticket", { supportTicket: { findFirst } } as never),
		).rejects.toThrow("SUPPORT_NOT_FOUND");
		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "bob-ticket", createdByUserId: "alice" } }),
		);
	});
	it("revoked organization membership denies the creating customer", async () => {
		const client = {
			supportTicket: {
				findFirst: vi.fn().mockResolvedValue({ id: "ticket", organizationId: "org", messages: [] }),
			},
			member: { findUnique: vi.fn().mockResolvedValue(null) },
		};
		await expect(getCustomerSupportTicketRow("owner", "ticket", client as never)).rejects.toThrow(
			"SUPPORT_FORBIDDEN",
		);
	});
	it("passes tenant scope into both reads and transactional admin replies", async () => {
		const tx = {
			supportTicket: { findFirst: vi.fn().mockResolvedValue(null) },
			supportTicketMessage: { create: vi.fn() },
		};
		const client = {
			$transaction: async (operation: (value: unknown) => unknown) => operation(tx),
		};
		const scope = { kind: "organization", organizationId: "org-a" } as const;
		await expect(getAdminSupportTicketRow(scope, "org-b-ticket", tx as never)).rejects.toThrow(
			"SUPPORT_NOT_FOUND",
		);
		await expect(
			replyAdminSupportTicketRow(
				scope,
				{ ticketId: "org-b-ticket", body: "reply", requestKey: "request-key" },
				{ id: "service", kind: "service" },
				client as never,
			),
		).rejects.toThrow("SUPPORT_NOT_FOUND");
		expect(tx.supportTicket.findFirst).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: { AND: [{ organizationId: "org-a" }, { id: "org-b-ticket" }] },
			}),
		);
		expect(tx.supportTicketMessage.create).not.toHaveBeenCalled();
	});
});
