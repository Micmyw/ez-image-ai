import { AdminAccessError, SupportError, type AdminScope } from "@repo/database";
import {
	AdminBotInputError,
	getAdminBotConfiguration,
	testAdminBotConfiguration,
	updateAdminBotConfiguration,
} from "@repo/notifications/admin-bots";

import {
	getAdminSupportTicket,
	listAdminSupportTickets,
	replyAdminSupportTicket,
	updateAdminSupportTicketStatus,
} from "./service";
import { adminSupportInputSchemas } from "./types";

export { adminSupportInputSchemas, adminSupportOutputSchemas } from "./types";
export type AdminSupportOperation = keyof typeof adminSupportInputSchemas;

export async function executeAdminSupportOperation(
	operation: AdminSupportOperation,
	input: unknown,
	context: {
		scope: AdminScope;
		actorId: string;
		actorKind?: "user" | "service";
		executionId: string;
		idempotencyKey: string;
	},
) {
	try {
		return await executeSupportOperation(operation, input, context);
	} catch (error) {
		// These typed errors represent validation or a rolled-back support transaction.
		// Unknown database/network outcomes retain the gateway's uncertain state.
		if (error instanceof AdminBotInputError) throw new AdminAccessError(error.code, error.status);
		if (error instanceof SupportError) {
			const status =
				error.code === "NOT_FOUND"
					? 404
					: error.code === "FORBIDDEN"
						? 403
						: error.code === "CONFLICT"
							? 409
							: 400;
			throw new AdminAccessError(`SUPPORT_${error.code}`, status);
		}
		throw error;
	}
}

async function executeSupportOperation(
	operation: AdminSupportOperation,
	input: unknown,
	context: {
		scope: AdminScope;
		actorId: string;
		actorKind?: "user" | "service";
		executionId: string;
		idempotencyKey: string;
	},
) {
	switch (operation) {
		case "tickets_list":
			return listAdminSupportTickets(
				context.scope,
				adminSupportInputSchemas.tickets_list.parse(input),
			);
		case "tickets_get":
			return getAdminSupportTicket(
				context.scope,
				adminSupportInputSchemas.tickets_get.parse(input),
			);
		case "tickets_reply":
			return replyAdminSupportTicket(
				context.scope,
				adminSupportInputSchemas.tickets_reply.parse(input),
				{ id: context.actorId, kind: context.actorKind ?? "service" },
				context.idempotencyKey,
			);
		case "tickets_status":
			return updateAdminSupportTicketStatus(
				context.scope,
				adminSupportInputSchemas.tickets_status.parse(input),
			);
		case "notifications_get":
			adminSupportInputSchemas.notifications_get.parse(input);
			return getAdminBotConfiguration(context.scope);
		case "notifications_update":
			return updateAdminBotConfiguration(
				context.scope,
				adminSupportInputSchemas.notifications_update.parse(input),
				context.actorId,
			);
		case "notifications_test":
			return testAdminBotConfiguration(
				context.scope,
				adminSupportInputSchemas.notifications_test.parse(input),
			);
	}
}
