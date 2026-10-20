import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "#prisma-runtime-client";

import {
	claimAdminBotReceipt,
	completeAdminBotReceipt,
	getAdminBotConfigRow,
	saveAdminBotConfigRow,
} from "./admin-bots";
import {
	createCustomerSupportTicket,
	getAdminSupportTicketRow,
	getCustomerSupportTicketRow,
	listAdminSupportTicketRows,
	replyAdminSupportTicketRow,
	replyCustomerSupportTicket,
	updateAdminSupportTicketStatusRow,
} from "./admin-support";

let client: PrismaClient;
const prefix = `admin-support-${crypto.randomUUID()}`;
beforeAll(() => {
	if (process.env.DATABASE_URL) throw new Error("DATABASE_URL_MUST_BE_UNSET");
	const target = new URL(process.env.TEST_DATABASE_URL ?? "");
	if (
		!["127.0.0.1", "localhost"].includes(target.hostname) ||
		target.port !== "55432" ||
		!target.pathname.endsWith("_test")
	)
		throw new Error("DISPOSABLE_LOCAL_ADMIN_DATABASE_REQUIRED");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.toString() }) });
});
afterAll(async () => {
	await client?.$disconnect();
});
async function createUser(label: string) {
	const id = `${prefix}-${label}`;
	await client.user.create({
		data: {
			id,
			name: label,
			email: `${id}@example.invalid`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	return id;
}
describe("durable support threads on isolated PostgreSQL", () => {
	it("replays concurrent identical creates once, conflicts changed input, and enforces owner scope", async () => {
		const owner = await createUser("owner");
		const other = await createUser("other");
		const input = {
			subject: "Paid order",
			body: "Help with my payment",
			requestKey: "same-create-key",
		};
		const results = await Promise.all(
			Array.from({ length: 6 }, () => createCustomerSupportTicket(owner, input, client)),
		);
		expect(results.filter((result) => result.created)).toHaveLength(1);
		const ticket = results[0]!.ticket;
		expect(await client.supportTicket.count({ where: { createdByUserId: owner } })).toBe(1);
		expect(await client.supportTicketMessage.count({ where: { ticketId: ticket.id } })).toBe(1);
		await expect(
			createCustomerSupportTicket(owner, { ...input, body: "Changed" }, client),
		).rejects.toThrow("SUPPORT_CONFLICT");
		await expect(getCustomerSupportTicketRow(other, ticket.id, client)).rejects.toThrow(
			"SUPPORT_NOT_FOUND",
		);
		await expect(
			getAdminSupportTicketRow({ kind: "user", userId: other }, ticket.id, client),
		).rejects.toThrow("SUPPORT_NOT_FOUND");
		expect(
			(await listAdminSupportTicketRows({ kind: "user", userId: owner }, {}, client)).items.map(
				(item) => item.id,
			),
		).toEqual([ticket.id]);
	});
	it("keeps organization tickets owner scoped and checks membership on every read", async () => {
		const owner = await createUser("org-owner");
		const orgId = `${prefix}-org`;
		await client.organization.create({ data: { id: orgId, name: "test", createdAt: new Date() } });
		await client.member.create({
			data: { organizationId: orgId, userId: owner, role: "member", createdAt: new Date() },
		});
		const { ticket } = await createCustomerSupportTicket(
			owner,
			{
				subject: "Organization request",
				body: "Help",
				requestKey: "organization-key",
				organizationId: orgId,
			},
			client,
		);
		await expect(
			getAdminSupportTicketRow({ kind: "user", userId: owner }, ticket.id, client),
		).rejects.toThrow("SUPPORT_NOT_FOUND");
		await expect(
			getAdminSupportTicketRow(
				{ kind: "organization", organizationId: `${orgId}-foreign` },
				ticket.id,
				client,
			),
		).rejects.toThrow("SUPPORT_NOT_FOUND");
		expect(
			(
				await getAdminSupportTicketRow(
					{ kind: "organization", organizationId: orgId },
					ticket.id,
					client,
				)
			).id,
		).toBe(ticket.id);
		await client.member.deleteMany({ where: { organizationId: orgId, userId: owner } });
		await expect(getCustomerSupportTicketRow(owner, ticket.id, client)).rejects.toThrow(
			"SUPPORT_FORBIDDEN",
		);
	});
	it("persists one admin reply, reopens on customer reply, and rejects a stale status write", async () => {
		const owner = await createUser("conversation");
		const { ticket } = await createCustomerSupportTicket(
			owner,
			{ subject: "Conversation", body: "Initial", requestKey: "conversation-create" },
			client,
		);
		const scope = { kind: "platform" } as const;
		const reply = { ticketId: ticket.id, body: "Admin reply", requestKey: "admin-reply-key" };
		const actor = { kind: "service", id: "independent-service-account" } as const;
		const results = await Promise.all(
			Array.from({ length: 4 }, () => replyAdminSupportTicketRow(scope, reply, actor, client)),
		);
		expect(results.filter((result) => result.created)).toHaveLength(1);
		expect(results[0]!.ticket.status).toBe("AWAITING_CUSTOMER");
		await expect(
			updateAdminSupportTicketStatusRow(
				scope,
				{ ticketId: ticket.id, status: "CLOSED", expectedUpdatedAt: ticket.updatedAt },
				client,
			),
		).rejects.toThrow("SUPPORT_CONFLICT");
		await client.supportTicketMessage.updateMany({
			where: { ticketId: ticket.id },
			data: { createdAt: new Date(Date.now() - 10_000) },
		});
		const customer = await replyCustomerSupportTicket(
			owner,
			{ ticketId: ticket.id, body: "Customer reply", requestKey: "customer-reply-key" },
			client,
		);
		expect(customer.ticket.status).toBe("OPEN");
		expect(customer.ticket.messages).toHaveLength(3);
		const closed = await updateAdminSupportTicketStatusRow(
			scope,
			{ ticketId: ticket.id, status: "CLOSED", expectedUpdatedAt: customer.ticket.updatedAt },
			client,
		);
		expect(closed.status).toBe("CLOSED");
	});
	it("claims one best-effort notification and uses optimistic configuration updates", async () => {
		const eventKey = `${prefix}:receipt`;
		const claims = await Promise.all(
			Array.from({ length: 8 }, () =>
				claimAdminBotReceipt({ eventKey, event: "payment.succeeded" }, client),
			),
		);
		expect(claims.filter(Boolean)).toHaveLength(1);
		await completeAdminBotReceipt(
			{ eventKey, results: [{ channel: "webhook", success: false, error: "ADMIN_BOT_TIMEOUT" }] },
			client,
		);
		expect(await claimAdminBotReceipt({ eventKey, event: "payment.succeeded" }, client)).toBe(
			false,
		);
		// Configuration is a singleton. Roll the fixture back rather than leaving
		// malformed test settings for another local acceptance test.
		await expect(
			client.$transaction(async (tx) => {
				const before = await getAdminBotConfigRow(tx);
				const version = before?.version ?? 0;
				const config = {
					expectedVersion: version,
					payload: { test: prefix },
					encryptedSecrets: "test-ciphertext",
					updatedBy: prefix,
				};
				const saved = await saveAdminBotConfigRow(config, tx);
				expect(saved).toBe(version + 1);
				await expect(saveAdminBotConfigRow(config, tx)).rejects.toThrow(
					"ADMIN_BOT_CONFIG_CONFLICT",
				);
				throw new Error("ROLLBACK_TEST_CONFIGURATION");
			}),
		).rejects.toThrow("ROLLBACK_TEST_CONFIGURATION");
	});
});
