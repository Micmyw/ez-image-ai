import {
	createCustomerSupportTicket,
	getAdminSupportTicketRow,
	getCustomerSupportTicketRow,
	listAdminSupportTicketRows,
	listCustomerSupportTicketRows,
	replyAdminSupportTicketRow,
	replyCustomerSupportTicket,
	updateAdminSupportTicketStatusRow,
	type AdminScope,
	type SupportAuthor,
	type SupportListInput,
	type SupportTicketStatus,
} from "@repo/database";
import { notifyAdminTicketEvent } from "@repo/notifications/admin-bots";

import {
	adminSupportReplyResultSchema,
	adminSupportStatusResultSchema,
	supportTicketDetailSchema,
	supportTicketSchema,
} from "./types";

type Ticket = Awaited<ReturnType<typeof getAdminSupportTicketRow>>;
export function serializeSupportTicket<T extends { createdAt: Date; updatedAt: Date }>(ticket: T) {
	return supportTicketSchema.parse({
		...ticket,
		createdAt: ticket.createdAt.toISOString(),
		updatedAt: ticket.updatedAt.toISOString(),
	});
}
function serializeDetail(ticket: Ticket) {
	return supportTicketDetailSchema.parse({
		...serializeSupportTicket(ticket),
		messages: ticket.messages.map((message) => ({
			...message,
			createdAt: message.createdAt.toISOString(),
		})),
	});
}
async function notifyTicket(
	ticket: Ticket,
	messageId: string,
	event: "ticket.created" | "ticket.customer_replied" | "ticket.admin_replied",
) {
	const message = ticket.messages.find((item) => item.id === messageId);
	if (message)
		await notifyAdminTicketEvent({
			event,
			ticket,
			messageId: message.id,
			body: message.body,
			createdAt: message.createdAt.toISOString(),
		});
}
export async function listAdminSupportTickets(scope: AdminScope, input: SupportListInput) {
	const result = await listAdminSupportTicketRows(scope, input);
	return { ...result, items: result.items.map(serializeSupportTicket) };
}
export async function getAdminSupportTicket(scope: AdminScope, input: { ticketId: string }) {
	return serializeDetail(await getAdminSupportTicketRow(scope, input.ticketId));
}
export async function replyAdminSupportTicket(
	scope: AdminScope,
	input: { ticketId: string; body: string },
	actor: SupportAuthor,
	requestKey: string,
) {
	const result = await replyAdminSupportTicketRow(scope, { ...input, requestKey }, actor);
	if (result.created) await notifyTicket(result.ticket, result.messageId, "ticket.admin_replied");
	return adminSupportReplyResultSchema.parse({
		ticketId: result.ticket.id,
		messageId: result.messageId,
		status: result.ticket.status,
		updatedAt: result.ticket.updatedAt.toISOString(),
		created: result.created,
	});
}
export async function updateAdminSupportTicketStatus(
	scope: AdminScope,
	input: { ticketId: string; status: SupportTicketStatus; expectedUpdatedAt: string },
) {
	const ticket = await updateAdminSupportTicketStatusRow(scope, {
		...input,
		expectedUpdatedAt: new Date(input.expectedUpdatedAt),
	});
	return adminSupportStatusResultSchema.parse({
		ticketId: ticket.id,
		status: ticket.status,
		updatedAt: ticket.updatedAt.toISOString(),
	});
}
export async function listCustomerTickets(
	userId: string,
	input: SupportListInput & { organizationId?: string },
) {
	const result = await listCustomerSupportTicketRows(userId, input);
	return { ...result, items: result.items.map(serializeSupportTicket) };
}
export async function getCustomerTicket(userId: string, input: { ticketId: string }) {
	return serializeDetail(await getCustomerSupportTicketRow(userId, input.ticketId));
}
export async function createCustomerTicket(
	userId: string,
	input: { subject: string; body: string; organizationId?: string; requestKey: string },
) {
	const result = await createCustomerSupportTicket(userId, input);
	const first = result.ticket.messages[0];
	if (result.created && first) await notifyTicket(result.ticket, first.id, "ticket.created");
	return { ticket: serializeDetail(result.ticket), created: result.created };
}
export async function replyCustomerTicket(
	userId: string,
	input: { ticketId: string; body: string; requestKey: string },
) {
	const result = await replyCustomerSupportTicket(userId, input);
	if (result.created)
		await notifyTicket(result.ticket, result.messageId, "ticket.customer_replied");
	return { ticket: serializeDetail(result.ticket), created: result.created };
}
