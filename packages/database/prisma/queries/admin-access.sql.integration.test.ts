import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_PERMISSION_CODES } from "../../shared/admin-permissions";
import { PrismaClient } from "../generated/client";
import {
	createAdminKey,
	createAdminServiceAccount,
	getAdminExecution,
	getHumanAdminPrincipal,
	listAdminExecutions,
	reserveAdminExecution,
	revokeAdminKey,
	updateAdminServiceAccount,
	validateAdminKey,
	type AdminPrincipal,
} from "./admin-access";

function safeDatabaseUrl() {
	const value = process.env.TEST_DATABASE_URL;
	if (!value) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	const url = new URL(value);
	if (
		!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
		!["55432", "55439"].includes(url.port) ||
		!/test/i.test(url.pathname)
	)
		throw new Error("UNSAFE_TEST_DATABASE");
	return value;
}

describe("admin access on isolated PostgreSQL", () => {
	let client: PrismaClient;
	const fixture = `admin-access-${randomUUID()}`;
	const accountIds = new Set<string>();
	const executionIds = new Set<string>();
	const admin: AdminPrincipal = {
		actorId: `${fixture}-admin`,
		actorType: "user",
		credentialId: null,
		scope: { kind: "platform" },
		permissions: [...ADMIN_PERMISSION_CODES],
	};
	const customerA = `${fixture}-a`;
	const customerB = `${fixture}-b`;

	beforeAll(async () => {
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString: safeDatabaseUrl() }) });
		await client.user.createMany({
			data: [admin.actorId, customerA, customerB].map((id) => ({
				id,
				name: "Isolated admin fixture",
				email: `${id}@example.test`,
				emailVerified: true,
				role: id === admin.actorId ? "admin" : "user",
				createdAt: new Date(),
				updatedAt: new Date(),
			})),
		});
	});
	afterAll(async () => {
		if (!client) return;
		await client.adminExecution.deleteMany({ where: { id: { in: [...executionIds] } } });
		await client.adminApiKey.deleteMany({ where: { serviceAccountId: { in: [...accountIds] } } });
		await client.adminServiceAccount.deleteMany({ where: { id: { in: [...accountIds] } } });
		await client.user.deleteMany({ where: { id: { in: [admin.actorId, customerA, customerB] } } });
		await client.$disconnect();
	});

	async function fixtureAccount() {
		const account = await createAdminServiceAccount(
			{
				name: "SQL fixture",
				scope: { kind: "user", userId: customerA },
				permissions: ["admin.analytics.read", "admin.audit.read"],
			},
			admin,
			client,
		);
		accountIds.add(account.id);
		const key = await createAdminKey(
			{
				serviceAccountId: account.id,
				name: "Fixture key",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			},
			admin,
			client,
		);
		return { account, key };
	}

	it("uses separate non-login identities and stores only hashes; fresh revoke/expiry/disable/grants apply", async () => {
		const { account, key } = await fixtureAccount();
		expect(await client.user.findUnique({ where: { id: account.id } })).toBeNull();
		const stored = await client.adminApiKey.findUniqueOrThrow({ where: { id: key.id } });
		expect(stored.keyHash).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(stored)).not.toContain(key.token);
		expect(await validateAdminKey(key.token, client)).toMatchObject({
			actorId: account.id,
			permissions: ["admin.analytics.read", "admin.audit.read"],
		});
		await updateAdminServiceAccount(
			{ id: account.id, expectedUpdatedAt: account.updatedAt, permissions: ["admin.audit.read"] },
			admin,
			client,
		);
		expect((await validateAdminKey(key.token, client))?.permissions).toEqual(["admin.audit.read"]);
		await client.adminServiceAccount.update({
			where: { id: account.id },
			data: { disabledAt: new Date() },
		});
		expect(await validateAdminKey(key.token, client)).toBeNull();
		await client.adminServiceAccount.update({
			where: { id: account.id },
			data: { disabledAt: null },
		});
		await client.adminApiKey.update({
			where: { id: key.id },
			data: { expiresAt: new Date(Date.now() - 1000) },
		});
		expect(await validateAdminKey(key.token, client)).toBeNull();
		await client.adminApiKey.update({
			where: { id: key.id },
			data: { expiresAt: new Date(Date.now() + 3600_000) },
		});
		await revokeAdminKey({ id: key.id, serviceAccountId: account.id }, admin, client);
		expect(await validateAdminKey(key.token, client)).toBeNull();
		expect(await validateAdminKey(`sk_${"a".repeat(43)}`, client)).toBeNull();
	});

	it("atomically elects a single reservation across concurrent callers", async () => {
		const { key } = await fixtureAccount();
		const actor = (await validateAdminKey(key.token, client))!;
		const id = `${fixture}-reservation`;
		executionIds.add(id);
		const results = await Promise.all(
			Array.from({ length: 12 }, () =>
				reserveAdminExecution(
					{ id, actor, operation: "fixture_write", inputHash: "a".repeat(64), targetId: customerA },
					client,
				),
			),
		);
		expect(results.filter((result) => result.reserved)).toHaveLength(1);
		expect((await getAdminExecution(id, client))?.status).toBe("pending");
	});

	it("limits machine audit to its own current scope across keys, and preserves changed-scope isolation", async () => {
		const { account, key } = await fixtureAccount();
		const actor = (await validateAdminKey(key.token, client))!;
		const id = `${fixture}-scope-a`;
		executionIds.add(id);
		await reserveAdminExecution(
			{ id, actor, operation: "analytics_overview", inputHash: "a".repeat(64), targetId: null },
			client,
		);
		const secondKey = await createAdminKey(
			{
				serviceAccountId: account.id,
				name: "Rotated",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			},
			admin,
			client,
		);
		expect(
			(
				await listAdminExecutions(
					(await validateAdminKey(secondKey.token, client))!,
					{ page: 1, pageSize: 20 },
					client,
				)
			).items.map((row) => row.id),
		).toContain(id);
		await updateAdminServiceAccount(
			{
				id: account.id,
				expectedUpdatedAt: account.updatedAt,
				scope: { kind: "user", userId: customerB },
			},
			admin,
			client,
		);
		const current = (await validateAdminKey(key.token, client))!;
		expect(current.scope).toEqual({ kind: "user", userId: customerB });
		expect((await listAdminExecutions(current, { page: 1, pageSize: 20 }, client)).items).toEqual(
			[],
		);
		await expect(
			listAdminExecutions(
				current,
				{ page: 1, pageSize: 20, serviceAccountId: "someone-else" },
				client,
			),
		).rejects.toThrow("ADMIN_SCOPE_DENIED");
		const adminAudit = await listAdminExecutions(
			admin,
			{ page: 1, pageSize: 20, serviceAccountId: account.id },
			client,
		);
		expect(adminAudit.items).toHaveLength(1);
		expect(adminAudit.items[0]).not.toHaveProperty("inputHash");
		expect(adminAudit.items[0]).not.toHaveProperty("response");
	});

	it("enforces human role, current privilege ceiling and optimistic account updates", async () => {
		expect(await getHumanAdminPrincipal(customerA, client)).toBeNull();
		expect((await getHumanAdminPrincipal(admin.actorId, client))?.actorType).toBe("user");
		const { account, key } = await fixtureAccount();
		await expect(
			createAdminServiceAccount(
				{ name: "Escalation", scope: { kind: "platform" }, permissions: ["admin.payments.refund"] },
				{ ...admin, permissions: ["admin.analytics.read"] },
				client,
			),
		).rejects.toThrow("ADMIN_PERMISSION_CEILING_EXCEEDED");
		await expect(
			createAdminKey(
				{
					serviceAccountId: account.id,
					name: "Forbidden",
					expiresAt: new Date(Date.now() + 3600_000).toISOString(),
				},
				(await validateAdminKey(key.token, client))!,
				client,
			),
		).rejects.toThrow("HUMAN_ADMIN_REQUIRED");
		await expect(
			updateAdminServiceAccount(
				{ id: account.id, expectedUpdatedAt: "2000-01-01T00:00:00.000Z", disabled: true },
				admin,
				client,
			),
		).rejects.toThrow("ADMIN_ACCOUNT_CHANGED");
	});
});
