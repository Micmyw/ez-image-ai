import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	AdminAccessError: class AdminAccessError extends Error {
		constructor(
			readonly code: string,
			readonly status: number,
		) {
			super(code);
		}
	},
	SupportError: class SupportError extends Error {
		constructor(readonly code: string) {
			super(`SUPPORT_${code}`);
		}
	},
	createCustomerSupportTicket: vi.fn(),
	getAdminSupportTicketRow: vi.fn(),
	getCustomerSupportTicketRow: vi.fn(),
	listAdminSupportTicketRows: vi.fn(),
	listCustomerSupportTicketRows: vi.fn(),
	replyAdminSupportTicketRow: vi.fn(),
	replyCustomerSupportTicket: vi.fn(),
	updateAdminSupportTicketStatusRow: vi.fn(),
}));
vi.mock("@repo/notifications/admin-bots", () => ({
	AdminBotInputError: class AdminBotInputError extends Error {
		constructor(
			readonly code: string,
			readonly status: number,
		) {
			super(code);
		}
	},
	getAdminBotConfiguration: vi.fn(),
	testAdminBotConfiguration: vi.fn(),
	updateAdminBotConfiguration: vi.fn(),
	notifyAdminTicketEvent: vi.fn(),
}));

import {
	AdminAccessError,
	SupportError,
	getAdminSupportTicketRow,
	replyAdminSupportTicketRow,
	updateAdminSupportTicketStatusRow,
} from "@repo/database";
import {
	AdminBotInputError,
	getAdminBotConfiguration,
	notifyAdminTicketEvent,
	testAdminBotConfiguration,
} from "@repo/notifications/admin-bots";

import { executeAdminSupportOperation } from "./admin-operations";

const context = {
	scope: { kind: "platform" as const },
	actorId: "support-agent",
	actorKind: "service" as const,
	executionId: "execution-1",
	idempotencyKey: "stable-reply-key",
};
const updatedAt = new Date("2026-10-20T04:00:00.000Z");
const ticket = {
	id: "ticket-1",
	subject: "Private customer subject",
	status: "AWAITING_CUSTOMER",
	createdByUserId: "customer-1",
	organizationId: null,
	createdAt: updatedAt,
	updatedAt,
	messages: [
		{
			id: "message-1",
			body: "Private reply content",
			authorType: "SERVICE",
			createdAt: updatedAt,
		},
	],
};

describe("administrator support operation boundaries", () => {
	beforeEach(() => vi.resetAllMocks());

	it.each([
		["ADMIN_BOT_URL_REJECTED", 400],
		["ADMIN_BOT_FORBIDDEN", 403],
		["ADMIN_BOT_CONFIG_CONFLICT", 409],
	] as const)("classifies typed %s rejections as a definite failure", async (code, status) => {
		vi.mocked(getAdminBotConfiguration).mockRejectedValue(new AdminBotInputError(code, status));
		const result = executeAdminSupportOperation("notifications_get", {}, context);
		await expect(result).rejects.toBeInstanceOf(AdminAccessError);
		await expect(result).rejects.toMatchObject({ code, status });
	});

	it.each([
		["NOT_FOUND", 404],
		["FORBIDDEN", 403],
		["CONFLICT", 409],
	] as const)("maps rolled-back support %s failures", async (code, status) => {
		vi.mocked(getAdminSupportTicketRow).mockRejectedValue(new SupportError(code));
		await expect(
			executeAdminSupportOperation("tickets_get", { ticketId: "ticket-1" }, context),
		).rejects.toMatchObject({ code: `SUPPORT_${code}`, status });
	});

	it("preserves an unknown delivery outcome even if its message resembles a policy error", async () => {
		const unknown = new Error("ADMIN_BOT_CONFIG_CONFLICT");
		vi.mocked(testAdminBotConfiguration).mockRejectedValue(unknown);
		await expect(executeAdminSupportOperation("notifications_test", {}, context)).rejects.toBe(
			unknown,
		);
		expect(unknown).not.toBeInstanceOf(AdminAccessError);
	});

	it("persists the stable service identity and returns a body-free reply receipt", async () => {
		vi.mocked(replyAdminSupportTicketRow).mockResolvedValue({
			ticket,
			messageId: "message-1",
			created: true,
		} as never);
		const result = await executeAdminSupportOperation(
			"tickets_reply",
			{ ticketId: "ticket-1", body: "Private reply content" },
			context,
		);
		expect(replyAdminSupportTicketRow).toHaveBeenCalledWith(
			context.scope,
			{
				ticketId: "ticket-1",
				body: "Private reply content",
				requestKey: context.idempotencyKey,
			},
			{ id: "support-agent", kind: "service" },
		);
		expect(notifyAdminTicketEvent).toHaveBeenCalledOnce();
		expect(result).toEqual({
			ticketId: "ticket-1",
			messageId: "message-1",
			status: "AWAITING_CUSTOMER",
			updatedAt: updatedAt.toISOString(),
			created: true,
		});
	});

	it("returns only the changed status receipt and preserves the caller CAS timestamp", async () => {
		vi.mocked(updateAdminSupportTicketStatusRow).mockResolvedValue({
			...ticket,
			status: "CLOSED",
		} as never);
		const result = await executeAdminSupportOperation(
			"tickets_status",
			{
				ticketId: "ticket-1",
				status: "CLOSED",
				expectedUpdatedAt: updatedAt.toISOString(),
			},
			context,
		);
		expect(updateAdminSupportTicketStatusRow).toHaveBeenCalledWith(context.scope, {
			ticketId: "ticket-1",
			status: "CLOSED",
			expectedUpdatedAt: updatedAt,
		});
		expect(result).toEqual({
			ticketId: "ticket-1",
			status: "CLOSED",
			updatedAt: updatedAt.toISOString(),
		});
		expect(notifyAdminTicketEvent).not.toHaveBeenCalled();
	});
});
