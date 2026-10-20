import type { AdminScope } from "../../shared/admin-scope";
import { db } from "../client";
import type { Prisma, PrismaClient } from "../generated/client";
import { isDatabaseUniqueConflict, runSerializable } from "./media/types";

export type SupportTicketStatus = "OPEN" | "AWAITING_CUSTOMER" | "CLOSED";
export type SupportAuthor = { id: string; kind: "user" | "service" };
export interface SupportListInput {
	page?: number;
	pageSize?: number;
	status?: SupportTicketStatus;
}

export class SupportError extends Error {
	constructor(readonly code: "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "RATE_LIMITED") {
		super(`SUPPORT_${code}`);
	}
}

export function supportScopeWhere(scope: AdminScope): Prisma.SupportTicketWhereInput {
	switch (scope.kind) {
		case "platform":
			return {};
		case "organization":
			return { organizationId: scope.organizationId };
		case "user":
			return { createdByUserId: scope.userId, organizationId: null };
		default:
			throw new SupportError("FORBIDDEN");
	}
}

const ticketSelect = {
	id: true,
	createdByUserId: true,
	organizationId: true,
	subject: true,
	status: true,
	createdAt: true,
	updatedAt: true,
} satisfies Prisma.SupportTicketSelect;
const messageSelect = {
	id: true,
	authorType: true,
	body: true,
	createdAt: true,
} satisfies Prisma.SupportTicketMessageSelect;

async function supportMutation<T>(
	client: PrismaClient,
	operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
	try {
		return await runSerializable(client, operation);
	} catch (error) {
		// Concurrent identical request keys can surface as a unique conflict rather
		// than serialization failure. Re-read once to replay or reject changed input.
		if (!isDatabaseUniqueConflict(error)) throw error;
		return runSerializable(client, operation);
	}
}

async function assertMembership(
	client: Prisma.TransactionClient,
	userId: string,
	organizationId?: string | null,
) {
	if (
		organizationId &&
		!(await client.member.findUnique({
			where: { organizationId_userId: { organizationId, userId } },
			select: { id: true },
		}))
	)
		throw new SupportError("FORBIDDEN");
}

async function listTickets(
	where: Prisma.SupportTicketWhereInput,
	input: SupportListInput,
	client: Prisma.TransactionClient,
) {
	const page = Math.max(1, Math.min(10_000, Math.trunc(input.page ?? 1)));
	const pageSize = Math.max(1, Math.min(100, Math.trunc(input.pageSize ?? 20)));
	const filtered = { AND: [where, input.status ? { status: input.status } : {}] };
	const [items, total] = await Promise.all([
		client.supportTicket.findMany({
			where: filtered,
			select: ticketSelect,
			orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
			take: pageSize,
			skip: (page - 1) * pageSize,
		}),
		client.supportTicket.count({ where: filtered }),
	]);
	return { items, total, page, pageSize };
}

export async function listAdminSupportTicketRows(
	scope: AdminScope,
	input: SupportListInput,
	client: Prisma.TransactionClient = db,
) {
	return listTickets(supportScopeWhere(scope), input, client);
}

export async function listCustomerSupportTicketRows(
	userId: string,
	input: SupportListInput & { organizationId?: string },
	client: Prisma.TransactionClient = db,
) {
	await assertMembership(client, userId, input.organizationId);
	return listTickets(
		{ createdByUserId: userId, organizationId: input.organizationId ?? null },
		input,
		client,
	);
}

async function readTicket(where: Prisma.SupportTicketWhereInput, client: Prisma.TransactionClient) {
	const ticket = await client.supportTicket.findFirst({
		where,
		select: {
			...ticketSelect,
			messages: { select: messageSelect, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
		},
	});
	if (!ticket) throw new SupportError("NOT_FOUND");
	return ticket;
}

export async function getAdminSupportTicketRow(
	scope: AdminScope,
	ticketId: string,
	client: Prisma.TransactionClient = db,
) {
	return readTicket({ AND: [supportScopeWhere(scope), { id: ticketId }] }, client);
}

export async function getCustomerSupportTicketRow(
	userId: string,
	ticketId: string,
	client: Prisma.TransactionClient = db,
) {
	const ticket = await readTicket({ id: ticketId, createdByUserId: userId }, client);
	await assertMembership(client, userId, ticket.organizationId);
	return ticket;
}

export async function createCustomerSupportTicket(
	userId: string,
	input: { subject: string; body: string; organizationId?: string; requestKey: string },
	client: PrismaClient = db,
) {
	return supportMutation(client, async (tx) => {
		await assertMembership(tx, userId, input.organizationId);
		const previous = await tx.supportTicket.findUnique({
			where: {
				createdByUserId_requestKey: { createdByUserId: userId, requestKey: input.requestKey },
			},
			include: { messages: { orderBy: { createdAt: "asc" }, take: 1 } },
		});
		if (previous) {
			if (
				previous.subject !== input.subject ||
				previous.organizationId !== (input.organizationId ?? null) ||
				previous.messages[0]?.body !== input.body
			)
				throw new SupportError("CONFLICT");
			return { ticket: await readTicket({ id: previous.id }, tx), created: false };
		}
		// Durable account-scoped rate limit, including across Worker isolates.
		if (
			await tx.supportTicket.count({
				where: { createdByUserId: userId, createdAt: { gt: new Date(Date.now() - 30_000) } },
			})
		)
			throw new SupportError("RATE_LIMITED");
		const ticket = await tx.supportTicket.create({
			data: {
				createdByUserId: userId,
				organizationId: input.organizationId ?? null,
				subject: input.subject,
				requestKey: input.requestKey,
				messages: {
					create: {
						authorType: "CUSTOMER",
						authorId: userId,
						body: input.body,
						requestKey: `initial:${input.requestKey}`,
					},
				},
			},
			select: { id: true },
		});
		return { ticket: await readTicket({ id: ticket.id }, tx), created: true };
	});
}

async function appendMessage(
	tx: Prisma.TransactionClient,
	ticketId: string,
	input: { body: string; requestKey: string },
	author: { authorType: "CUSTOMER" | "ADMIN" | "SERVICE"; authorId: string },
) {
	const previous = await tx.supportTicketMessage.findUnique({
		where: { ticketId_requestKey: { ticketId, requestKey: input.requestKey } },
	});
	if (previous) {
		if (
			previous.body !== input.body ||
			previous.authorType !== author.authorType ||
			previous.authorId !== author.authorId
		)
			throw new SupportError("CONFLICT");
		return {
			ticket: await readTicket({ id: ticketId }, tx),
			messageId: previous.id,
			created: false,
		};
	}
	if (
		author.authorType === "CUSTOMER" &&
		(await tx.supportTicketMessage.count({
			where: {
				authorId: author.authorId,
				authorType: "CUSTOMER",
				createdAt: { gt: new Date(Date.now() - 5_000) },
			},
		}))
	)
		throw new SupportError("RATE_LIMITED");
	const message = await tx.supportTicketMessage.create({
		data: { ticketId, ...input, ...author },
		select: { id: true },
	});
	await tx.supportTicket.update({
		where: { id: ticketId },
		data: {
			status: author.authorType === "CUSTOMER" ? "OPEN" : "AWAITING_CUSTOMER",
			updatedAt: new Date(),
		},
	});
	return { ticket: await readTicket({ id: ticketId }, tx), messageId: message.id, created: true };
}

export async function replyCustomerSupportTicket(
	userId: string,
	input: { ticketId: string; body: string; requestKey: string },
	client: PrismaClient = db,
) {
	return supportMutation(client, async (tx) => {
		await getCustomerSupportTicketRow(userId, input.ticketId, tx);
		return appendMessage(tx, input.ticketId, input, { authorType: "CUSTOMER", authorId: userId });
	});
}

export async function replyAdminSupportTicketRow(
	scope: AdminScope,
	input: { ticketId: string; body: string; requestKey: string },
	actor: SupportAuthor,
	client: PrismaClient = db,
) {
	return supportMutation(client, async (tx) => {
		await getAdminSupportTicketRow(scope, input.ticketId, tx);
		return appendMessage(tx, input.ticketId, input, {
			authorType: actor.kind === "service" ? "SERVICE" : "ADMIN",
			authorId: actor.id,
		});
	});
}

export async function updateAdminSupportTicketStatusRow(
	scope: AdminScope,
	input: { ticketId: string; status: SupportTicketStatus; expectedUpdatedAt: Date },
	client: PrismaClient = db,
) {
	return runSerializable(client, async (tx) => {
		await getAdminSupportTicketRow(scope, input.ticketId, tx);
		const changed = await tx.supportTicket.updateMany({
			where: {
				AND: [supportScopeWhere(scope), { id: input.ticketId, updatedAt: input.expectedUpdatedAt }],
			},
			data: { status: input.status, updatedAt: new Date() },
		});
		if (changed.count !== 1) throw new SupportError("CONFLICT");
		return readTicket({ id: input.ticketId }, tx);
	});
}
