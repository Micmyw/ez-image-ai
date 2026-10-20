import { and, asc, count, desc, eq, gt, isNull, type SQL } from "drizzle-orm";

import type { AdminScope } from "../../shared/admin-scope";
import { db } from "../client";
import { member, supportTicket, supportTicketMessage } from "../schema/postgres";

export type SupportTicketStatus = "OPEN" | "AWAITING_CUSTOMER" | "CLOSED";
export type SupportAuthor = { id: string; kind: "user" | "service" };
export interface SupportListInput {
	page?: number;
	pageSize?: number;
	status?: SupportTicketStatus;
}

type SupportClient = Pick<typeof db, "query" | "select" | "insert" | "update">;
type SupportDatabase = Pick<typeof db, "transaction">;

export class SupportError extends Error {
	constructor(readonly code: "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "RATE_LIMITED") {
		super(`SUPPORT_${code}`);
	}
}

export function supportScopeWhere(scope: AdminScope): SQL | undefined {
	switch (scope.kind) {
		case "platform":
			return undefined;
		case "organization":
			return eq(supportTicket.organizationId, scope.organizationId);
		case "user":
			return and(
				eq(supportTicket.createdByUserId, scope.userId),
				isNull(supportTicket.organizationId),
			);
		default:
			throw new SupportError("FORBIDDEN");
	}
}

const ticketColumns = {
	id: true,
	createdByUserId: true,
	organizationId: true,
	subject: true,
	status: true,
	createdAt: true,
	updatedAt: true,
} as const;
const messageColumns = {
	id: true,
	authorType: true,
	body: true,
	createdAt: true,
} as const;

function isSerializationConflict(error: unknown): boolean {
	const seen = new Set<unknown>();
	let current = error;
	while (current && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		const details = current as { code?: string; cause?: unknown };
		if (details.code === "40001" || details.code === "40P01") return true;
		current = details.cause;
	}
	return false;
}

async function runSerializable<T>(
	client: SupportDatabase,
	operation: (tx: SupportClient) => Promise<T>,
): Promise<T> {
	for (let attempt = 1; attempt <= 4; attempt += 1) {
		try {
			return await client.transaction(operation, { isolationLevel: "serializable" });
		} catch (error) {
			if (!isSerializationConflict(error) || attempt === 4) throw error;
		}
	}
	throw new Error("Serializable transaction retry limit exceeded");
}

async function assertMembership(
	client: SupportClient,
	userId: string,
	organizationId?: string | null,
) {
	if (
		organizationId &&
		!(await client.query.member.findFirst({
			where: and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
			columns: { id: true },
		}))
	)
		throw new SupportError("FORBIDDEN");
}

async function listTickets(where: SQL | undefined, input: SupportListInput, client: SupportClient) {
	const page = Math.max(1, Math.min(10_000, Math.trunc(input.page ?? 1)));
	const pageSize = Math.max(1, Math.min(100, Math.trunc(input.pageSize ?? 20)));
	const filtered = and(where, input.status ? eq(supportTicket.status, input.status) : undefined);
	const [items, totals] = await Promise.all([
		client.query.supportTicket.findMany({
			where: filtered,
			columns: ticketColumns,
			orderBy: [desc(supportTicket.updatedAt), desc(supportTicket.id)],
			limit: pageSize,
			offset: (page - 1) * pageSize,
		}),
		client.select({ count: count() }).from(supportTicket).where(filtered),
	]);
	return { items, total: totals[0]?.count ?? 0, page, pageSize };
}

export async function listAdminSupportTicketRows(
	scope: AdminScope,
	input: SupportListInput,
	client: SupportClient = db,
) {
	return listTickets(supportScopeWhere(scope), input, client);
}

export async function listCustomerSupportTicketRows(
	userId: string,
	input: SupportListInput & { organizationId?: string },
	client: SupportClient = db,
) {
	await assertMembership(client, userId, input.organizationId);
	return listTickets(
		and(
			eq(supportTicket.createdByUserId, userId),
			input.organizationId === undefined
				? isNull(supportTicket.organizationId)
				: eq(supportTicket.organizationId, input.organizationId),
		),
		input,
		client,
	);
}

async function readTicket(where: SQL | undefined, client: SupportClient) {
	const ticket = await client.query.supportTicket.findFirst({
		where,
		columns: ticketColumns,
		with: {
			messages: {
				columns: messageColumns,
				orderBy: [asc(supportTicketMessage.createdAt), asc(supportTicketMessage.id)],
			},
		},
	});
	if (!ticket) throw new SupportError("NOT_FOUND");
	return ticket;
}

export async function getAdminSupportTicketRow(
	scope: AdminScope,
	ticketId: string,
	client: SupportClient = db,
) {
	return readTicket(and(supportScopeWhere(scope), eq(supportTicket.id, ticketId)), client);
}

export async function getCustomerSupportTicketRow(
	userId: string,
	ticketId: string,
	client: SupportClient = db,
) {
	const ticket = await readTicket(
		and(eq(supportTicket.id, ticketId), eq(supportTicket.createdByUserId, userId)),
		client,
	);
	await assertMembership(client, userId, ticket.organizationId);
	return ticket;
}

export async function createCustomerSupportTicket(
	userId: string,
	input: { subject: string; body: string; organizationId?: string; requestKey: string },
	client: SupportDatabase = db,
) {
	return runSerializable(client, async (tx) => {
		await assertMembership(tx, userId, input.organizationId);
		const previous = await tx.query.supportTicket.findFirst({
			where: and(
				eq(supportTicket.createdByUserId, userId),
				eq(supportTicket.requestKey, input.requestKey),
			),
			with: { messages: { orderBy: [asc(supportTicketMessage.createdAt)], limit: 1 } },
		});
		if (previous) {
			if (
				previous.subject !== input.subject ||
				previous.organizationId !== (input.organizationId ?? null) ||
				previous.messages[0]?.body !== input.body
			)
				throw new SupportError("CONFLICT");
			return { ticket: await readTicket(eq(supportTicket.id, previous.id), tx), created: false };
		}
		const [recent] = await tx
			.select({ count: count() })
			.from(supportTicket)
			.where(
				and(
					eq(supportTicket.createdByUserId, userId),
					gt(supportTicket.createdAt, new Date(Date.now() - 30_000)),
				),
			);
		if (recent?.count) throw new SupportError("RATE_LIMITED");
		const [ticket] = await tx
			.insert(supportTicket)
			.values({
				createdByUserId: userId,
				organizationId: input.organizationId ?? null,
				subject: input.subject,
				requestKey: input.requestKey,
			})
			.returning({ id: supportTicket.id });
		await tx.insert(supportTicketMessage).values({
			ticketId: ticket!.id,
			authorType: "CUSTOMER",
			authorId: userId,
			body: input.body,
			requestKey: `initial:${input.requestKey}`,
		});
		return { ticket: await readTicket(eq(supportTicket.id, ticket!.id), tx), created: true };
	});
}

async function appendMessage(
	tx: SupportClient,
	ticketId: string,
	input: { body: string; requestKey: string },
	author: { authorType: "CUSTOMER" | "ADMIN" | "SERVICE"; authorId: string },
) {
	const previous = await tx.query.supportTicketMessage.findFirst({
		where: and(
			eq(supportTicketMessage.ticketId, ticketId),
			eq(supportTicketMessage.requestKey, input.requestKey),
		),
	});
	if (previous) {
		if (
			previous.body !== input.body ||
			previous.authorType !== author.authorType ||
			previous.authorId !== author.authorId
		)
			throw new SupportError("CONFLICT");
		return {
			ticket: await readTicket(eq(supportTicket.id, ticketId), tx),
			messageId: previous.id,
			created: false,
		};
	}
	if (author.authorType === "CUSTOMER") {
		const [recent] = await tx
			.select({ count: count() })
			.from(supportTicketMessage)
			.where(
				and(
					eq(supportTicketMessage.authorId, author.authorId),
					eq(supportTicketMessage.authorType, "CUSTOMER"),
					gt(supportTicketMessage.createdAt, new Date(Date.now() - 5_000)),
				),
			);
		if (recent?.count) throw new SupportError("RATE_LIMITED");
	}
	const [message] = await tx
		.insert(supportTicketMessage)
		.values({ ticketId, body: input.body, requestKey: input.requestKey, ...author })
		.returning({ id: supportTicketMessage.id });
	await tx
		.update(supportTicket)
		.set({
			status: author.authorType === "CUSTOMER" ? "OPEN" : "AWAITING_CUSTOMER",
			updatedAt: new Date(),
		})
		.where(eq(supportTicket.id, ticketId));
	return {
		ticket: await readTicket(eq(supportTicket.id, ticketId), tx),
		messageId: message!.id,
		created: true,
	};
}

export async function replyCustomerSupportTicket(
	userId: string,
	input: { ticketId: string; body: string; requestKey: string },
	client: SupportDatabase = db,
) {
	return runSerializable(client, async (tx) => {
		await getCustomerSupportTicketRow(userId, input.ticketId, tx);
		return appendMessage(tx, input.ticketId, input, { authorType: "CUSTOMER", authorId: userId });
	});
}

export async function replyAdminSupportTicketRow(
	scope: AdminScope,
	input: { ticketId: string; body: string; requestKey: string },
	actor: SupportAuthor,
	client: SupportDatabase = db,
) {
	return runSerializable(client, async (tx) => {
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
	client: SupportDatabase = db,
) {
	return runSerializable(client, async (tx) => {
		await getAdminSupportTicketRow(scope, input.ticketId, tx);
		const changed = await tx
			.update(supportTicket)
			.set({ status: input.status, updatedAt: new Date() })
			.where(
				and(
					supportScopeWhere(scope),
					eq(supportTicket.id, input.ticketId),
					eq(supportTicket.updatedAt, input.expectedUpdatedAt),
				),
			)
			.returning({ id: supportTicket.id });
		if (changed.length !== 1) throw new SupportError("CONFLICT");
		return readTicket(eq(supportTicket.id, input.ticketId), tx);
	});
}
