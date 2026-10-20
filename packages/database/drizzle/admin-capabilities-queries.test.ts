import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Client } from "pg";
import { describe, expect, it, vi } from "vitest";

import * as bots from "./queries/admin-bots";
import {
	createCustomerSupportTicket,
	getAdminSupportTicketRow,
	getCustomerSupportTicketRow,
	listAdminSupportTicketRows,
	listCustomerSupportTicketRows,
	replyAdminSupportTicketRow,
	replyCustomerSupportTicket,
	supportScopeWhere,
	updateAdminSupportTicketStatusRow,
} from "./queries/admin-support";
import * as schema from "./schema/postgres";

// Exercise the real Drizzle SQL builder with a deterministic PostgreSQL wire
// response. No local or production database is opened by these contract checks.
vi.mock("./client", () => ({ db: {} }));

const instant = new Date("2026-10-20T01:02:03.456Z");
const isoInstant = instant.toISOString();
const platform = { kind: "platform" } as const;
const ticketInput = { subject: "Invoice help", body: "Please help", requestKey: "request-1" };
const replyInput = { ticketId: "ticket-1", body: "Reply", requestKey: "reply-1" };

function ticketRow(organizationId: string | null = null) {
	return [
		"ticket-1",
		"user-1",
		organizationId,
		ticketInput.subject,
		"OPEN",
		isoInstant,
		isoInstant,
		[],
	];
}

function fullTicketRow(subject = ticketInput.subject) {
	return [
		"ticket-1",
		"user-1",
		null,
		subject,
		"OPEN",
		ticketInput.requestKey,
		isoInstant,
		isoInstant,
		[
			[
				"message-1",
				"ticket-1",
				"CUSTOMER",
				"user-1",
				ticketInput.body,
				"initial:request-1",
				isoInstant,
			],
		],
	];
}

function driver(responses: unknown[][][] = []) {
	const calls: { sql: string; params: unknown[] }[] = [];
	let nextError: unknown;
	const client = {
		query: vi.fn(async (query: string | { text: string }, params?: unknown[]) => {
			const text = typeof query === "string" ? query : query.text;
			calls.push({ sql: text, params: params ?? [] });
			if (/^(begin|commit|rollback)\b/i.test(text)) return { rows: [], rowCount: 0 };
			if (nextError) {
				const error = nextError;
				nextError = undefined;
				throw error;
			}
			const rows = responses.shift() ?? [];
			return { rows, rowCount: rows.length };
		}),
	};
	return {
		db: drizzle(client as unknown as Client, { schema }),
		calls,
		failNext(error: unknown) {
			nextError = error;
		},
	};
}

describe("Drizzle administration bot persistence", () => {
	it("returns null for absent config and identity, without exporting unimplemented payment evidence", async () => {
		const test = driver();
		expect(await bots.getAdminBotConfigRow(test.db)).toBeNull();
		expect(await bots.getSupportBotIdentity("user-1", test.db)).toBeNull();
		expect(test.calls[1]!.sql).not.toContain('"password"');
		expect(test.calls[1]!.sql).toContain('"registrationAttribution"');
		expect(bots).not.toHaveProperty("getPaymentBotData");
	});

	it("creates configuration once and detects stale versions instead of overwriting", async () => {
		const test = driver([[["platform"]], [], [["platform"]], []]);
		const input = {
			expectedVersion: 0,
			payload: { enabled: true },
			encryptedSecrets: null,
			updatedBy: "user-1",
		};
		expect(await bots.saveAdminBotConfigRow(input, test.db)).toBe(1);
		await expect(bots.saveAdminBotConfigRow(input, test.db)).rejects.toThrow(
			"ADMIN_BOT_CONFIG_CONFLICT",
		);
		expect(await bots.saveAdminBotConfigRow({ ...input, expectedVersion: 1 }, test.db)).toBe(2);
		await expect(
			bots.saveAdminBotConfigRow({ ...input, expectedVersion: 1 }, test.db),
		).rejects.toThrow("ADMIN_BOT_CONFIG_CONFLICT");
		expect(test.calls[0]!.sql).toContain("on conflict do nothing");
		expect(test.calls[2]!.sql).toContain('"version" = "admin_bot_config"."version" + 1');
		expect(test.calls[2]!.sql).toMatch(/where .*"id" = .* and .*"version" = /);
		expect(test.calls[2]!.params.slice(-2)).toEqual(["platform", 1]);
	});

	it("claims each event once and completes only a claimed receipt", async () => {
		const test = driver([[["receipt-1"]], [], [["receipt-1"]], []]);
		const input = { eventKey: "support:ticket-1", event: "support.created" };
		expect(await bots.claimAdminBotReceipt(input, test.db)).toBe(true);
		expect(await bots.claimAdminBotReceipt(input, test.db)).toBe(false);
		expect(
			await bots.completeAdminBotReceipt({ eventKey: input.eventKey, results: [] }, test.db),
		).toEqual({ count: 1 });
		expect(
			await bots.completeAdminBotReceipt({ eventKey: input.eventKey, results: [] }, test.db),
		).toEqual({ count: 0 });
		expect(test.calls[0]!.sql).toContain("on conflict do nothing");
		expect(test.calls[2]!.sql).toMatch(/where .*"eventKey" = .* and .*"status" = /);
		expect(test.calls[2]!.params.slice(-2)).toEqual([input.eventKey, "CLAIMED"]);
	});
});

describe("Drizzle support ownership and transaction contracts", () => {
	it("isolates user and organization scopes and rejects an unknown scope", () => {
		const dialect = new PgDialect();
		expect(supportScopeWhere(platform)).toBeUndefined();
		const personal = dialect.sqlToQuery(supportScopeWhere({ kind: "user", userId: "user-1" })!);
		expect(personal.sql).toContain('"organizationId" is null');
		expect(personal.params).toEqual(["user-1"]);
		const organization = dialect.sqlToQuery(
			supportScopeWhere({ kind: "organization", organizationId: "org-1" })!,
		);
		expect(organization.sql).toContain('"organizationId" =');
		expect(organization.params).toEqual(["org-1"]);
		expect(() => supportScopeWhere({ kind: "untrusted" } as never)).toThrow("SUPPORT_FORBIDDEN");
	});

	it("applies the same scope, status, stable ordering, and pagination to list and count", async () => {
		const test = driver([[], [[7]]]);
		expect(
			await listAdminSupportTicketRows(
				{ kind: "user", userId: "user-1" },
				{ page: -3, pageSize: 500, status: "OPEN" },
				test.db,
			),
		).toEqual({ items: [], total: 7, page: 1, pageSize: 100 });
		for (const call of test.calls) {
			expect(call.sql).toContain('"organizationId" is null');
			expect(call.sql).toContain('"status" =');
			expect(call.params).toEqual(expect.arrayContaining(["user-1", "OPEN"]));
		}
		expect(test.calls[0]!.sql).toMatch(/order by .*"updatedAt" desc, .*"id" desc/);
		expect(test.calls[0]!.params).toContain(100);
		expect(test.calls[0]!.sql).not.toContain('"requestKey"');
	});

	it("requires current membership for organization lists", async () => {
		const test = driver();
		await expect(
			listCustomerSupportTicketRows("user-1", { organizationId: "org-1" }, test.db),
		).rejects.toThrow("SUPPORT_FORBIDDEN");
		expect(test.calls).toHaveLength(1);
		expect(test.calls[0]!.sql).toContain('"member"');
		expect(test.calls[0]!.params).toEqual(expect.arrayContaining(["org-1", "user-1"]));
	});

	it("keeps a customer's default list personal and hides ticket request keys", async () => {
		const test = driver([[], [[0]]]);
		await listCustomerSupportTicketRows("user-1", {}, test.db);
		expect(test.calls[0]!.sql).toContain('"organizationId" is null');
		expect(test.calls[0]!.sql).toContain('"createdByUserId" =');
		expect(test.calls[0]!.sql).not.toContain('"requestKey"');
	});

	it("rechecks membership before returning a formerly owned organization ticket", async () => {
		const test = driver([[ticketRow("org-1")], []]);
		await expect(getCustomerSupportTicketRow("user-1", "ticket-1", test.db)).rejects.toThrow(
			"SUPPORT_FORBIDDEN",
		);
		expect(test.calls[0]!.params).toEqual(expect.arrayContaining(["ticket-1", "user-1"]));
		expect(test.calls[0]!.sql).not.toContain('"authorId"');
		expect(test.calls[0]!.sql).not.toContain('"requestKey"');
	});

	it("maps a missing scoped ticket to NOT_FOUND", async () => {
		const test = driver();
		await expect(getAdminSupportTicketRow(platform, "ticket-1", test.db)).rejects.toThrow(
			"SUPPORT_NOT_FOUND",
		);
	});

	it("replays a matching ticket request without a new message or insert", async () => {
		const test = driver([[fullTicketRow()], [ticketRow()]]);
		const result = await createCustomerSupportTicket("user-1", ticketInput, test.db);
		expect(result.created).toBe(false);
		expect(result.ticket.id).toBe("ticket-1");
		expect(test.calls.some((call) => /^insert/i.test(call.sql))).toBe(false);
		expect(test.calls[0]!.sql).toContain("serializable");
	});

	it("rejects reuse of a ticket request key for different content", async () => {
		const test = driver([[fullTicketRow("Different subject")]]);
		await expect(createCustomerSupportTicket("user-1", ticketInput, test.db)).rejects.toThrow(
			"SUPPORT_CONFLICT",
		);
		expect(test.calls.at(-1)!.sql).toBe("rollback");
		expect(test.calls.some((call) => /^insert/i.test(call.sql))).toBe(false);
	});

	it("creates the ticket and initial customer message in one serializable transaction", async () => {
		const test = driver([[], [[0]], [["ticket-1"]], [], [ticketRow()]]);
		const result = await createCustomerSupportTicket("user-1", ticketInput, test.db);
		expect(result.created).toBe(true);
		const writes = test.calls.filter((call) => /^insert/i.test(call.sql));
		expect(writes).toHaveLength(2);
		expect(writes[0]!.params).toContain("user-1");
		expect(writes[1]!.params).toEqual(
			expect.arrayContaining([
				"ticket-1",
				"CUSTOMER",
				"user-1",
				ticketInput.body,
				"initial:request-1",
			]),
		);
		expect(test.calls[0]!.sql).toContain("serializable");
		expect(test.calls.at(-1)!.sql).toBe("commit");
	});

	it("enforces the durable customer ticket rate limit before inserting", async () => {
		const test = driver([[], [[1]]]);
		await expect(createCustomerSupportTicket("user-1", ticketInput, test.db)).rejects.toThrow(
			"SUPPORT_RATE_LIMITED",
		);
		expect(test.calls.some((call) => /^insert/i.test(call.sql))).toBe(false);
		expect(test.calls.find((call) => call.sql.includes("count("))!.sql).toContain('"createdAt" >');
	});

	it("records service replies distinctly and moves the ticket to awaiting customer", async () => {
		const test = driver([[ticketRow()], [], [["reply-message"]], [], [ticketRow()]]);
		const result = await replyAdminSupportTicketRow(
			platform,
			replyInput,
			{ kind: "service", id: "service-1" },
			test.db,
		);
		expect(result).toMatchObject({ messageId: "reply-message", created: true });
		const insert = test.calls.find((call) => /^insert/i.test(call.sql))!;
		expect(insert.params).toEqual(expect.arrayContaining(["SERVICE", "service-1", "reply-1"]));
		expect(test.calls.find((call) => /^update/i.test(call.sql))!.params).toContain(
			"AWAITING_CUSTOMER",
		);
	});

	it("rejects a reply idempotency key owned by another author", async () => {
		const previous = [
			"reply-message",
			"ticket-1",
			"ADMIN",
			"other-admin",
			"Reply",
			"reply-1",
			isoInstant,
		];
		const test = driver([[ticketRow()], [previous]]);
		await expect(
			replyAdminSupportTicketRow(platform, replyInput, { kind: "user", id: "admin-1" }, test.db),
		).rejects.toThrow("SUPPORT_CONFLICT");
		expect(test.calls.some((call) => /^insert|^update/i.test(call.sql))).toBe(false);
	});

	it("enforces the customer reply throttle before writing", async () => {
		const test = driver([[ticketRow()], [], [[1]]]);
		await expect(replyCustomerSupportTicket("user-1", replyInput, test.db)).rejects.toThrow(
			"SUPPORT_RATE_LIMITED",
		);
		expect(test.calls.some((call) => /^insert|^update/i.test(call.sql))).toBe(false);
		const countQuery = test.calls.find((call) => call.sql.includes("count("))!;
		expect(countQuery.params).toEqual(expect.arrayContaining(["user-1", "CUSTOMER"]));
	});

	it("detects a stale status edit with scope and timestamp still present in the write", async () => {
		const test = driver([[ticketRow("org-1")], []]);
		await expect(
			updateAdminSupportTicketStatusRow(
				{ kind: "organization", organizationId: "org-1" },
				{ ticketId: "ticket-1", status: "CLOSED", expectedUpdatedAt: instant },
				test.db,
			),
		).rejects.toThrow("SUPPORT_CONFLICT");
		const write = test.calls.find((call) => /^update/i.test(call.sql))!;
		expect(write.sql).toMatch(/where .*"organizationId" = .*"id" = .*"updatedAt" =/);
		expect(write.params).toEqual(expect.arrayContaining(["org-1", "ticket-1", isoInstant]));
		expect(test.calls.at(-1)!.sql).toBe("rollback");
	});

	it("retries PostgreSQL serialization failures around the entire transaction", async () => {
		const test = driver([[ticketRow()], [["ticket-1"]], [ticketRow()]]);
		test.failNext(Object.assign(new Error("serialization conflict"), { code: "40001" }));
		const result = await updateAdminSupportTicketStatusRow(
			platform,
			{ ticketId: "ticket-1", status: "CLOSED", expectedUpdatedAt: instant },
			test.db,
		);
		expect(result.id).toBe("ticket-1");
		expect(test.calls.filter((call) => /^begin/i.test(call.sql))).toHaveLength(2);
		expect(test.calls.filter((call) => /^rollback/i.test(call.sql))).toHaveLength(1);
		expect(test.calls.at(-1)!.sql).toBe("commit");
	});
});
