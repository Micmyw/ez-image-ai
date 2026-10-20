import { createHash, randomBytes } from "node:crypto";

import {
	adminScopeSchema,
	type AdminServiceAccountSummary,
} from "../../shared/admin-agent-contracts";
import {
	adminPermissionsForHumanRole,
	isAdminPermission,
	type AdminPermission,
} from "../../shared/admin-permissions";
import { adminScopeKey, type AdminScope } from "../../shared/admin-scope";
import { db } from "../client";
import type { Prisma, PrismaClient } from "../generated/client";

type Client = PrismaClient;
type Transaction = Prisma.TransactionClient;
export interface AdminPrincipal {
	actorId: string;
	actorType: "user" | "service";
	credentialId: string | null;
	scope: AdminScope;
	permissions: AdminPermission[];
}
export class AdminAccessError extends Error {
	constructor(
		readonly code: string,
		readonly status: 400 | 401 | 403 | 404 | 409 = 400,
	) {
		super(code);
	}
}

const keySummarySelect = {
	id: true,
	name: true,
	keyPrefix: true,
	expiresAt: true,
	revokedAt: true,
	lastUsedAt: true,
	createdAt: true,
} as const;
const accountSelect = {
	id: true,
	name: true,
	scope: true,
	permissions: true,
	disabledAt: true,
	createdAt: true,
	updatedAt: true,
	keys: { select: keySummarySelect, orderBy: { createdAt: "desc" as const } },
} as const;
type AccountProjection = Prisma.AdminServiceAccountGetPayload<{ select: typeof accountSelect }>;
function accountSummary(account: AccountProjection): AdminServiceAccountSummary {
	return {
		...account,
		scope: adminScopeSchema.parse(account.scope),
		permissions: account.permissions.filter(isAdminPermission),
		disabledAt: account.disabledAt?.toISOString() ?? null,
		createdAt: account.createdAt.toISOString(),
		updatedAt: account.updatedAt.toISOString(),
		keys: account.keys.map((key) => ({
			...key,
			expiresAt: key.expiresAt.toISOString(),
			revokedAt: key.revokedAt?.toISOString() ?? null,
			lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
			createdAt: key.createdAt.toISOString(),
		})),
	};
}

export function assertAdminControlPrincipal(principal: AdminPrincipal): void {
	if (principal.actorType !== "user" || principal.credentialId !== null) {
		throw new AdminAccessError("HUMAN_ADMIN_REQUIRED", 403);
	}
	if (principal.scope.kind !== "platform") throw new AdminAccessError("ADMIN_SCOPE_DENIED", 403);
}

export function assertAdminGrantCeiling(principal: AdminPrincipal, permissions: readonly string[]) {
	assertAdminControlPrincipal(principal);
	if (
		permissions.some(
			(permission) => !isAdminPermission(permission) || !principal.permissions.includes(permission),
		)
	) {
		throw new AdminAccessError("ADMIN_PERMISSION_CEILING_EXCEEDED", 403);
	}
}

async function assertScopeExists(scope: AdminScope, client: Transaction | Client) {
	if (
		scope.kind === "user" &&
		!(await client.user.findFirst({
			where: { id: scope.userId, isAnonymous: false },
			select: { id: true },
		}))
	)
		throw new AdminAccessError("ADMIN_SCOPE_TARGET_NOT_FOUND", 404);
	if (
		scope.kind === "organization" &&
		!(await client.organization.findUnique({
			where: { id: scope.organizationId },
			select: { id: true },
		}))
	)
		throw new AdminAccessError("ADMIN_SCOPE_TARGET_NOT_FOUND", 404);
}

/** Session caches do not decide current administrative privileges. */
export async function getHumanAdminPrincipal(
	userId: string,
	client: Client = db,
): Promise<AdminPrincipal | null> {
	const user = await client.user.findUnique({
		where: { id: userId },
		select: { id: true, role: true, isAnonymous: true, banned: true, banExpires: true },
	});
	if (
		!user ||
		user.role !== "admin" ||
		user.isAnonymous ||
		(user.banned && (!user.banExpires || user.banExpires > new Date()))
	)
		return null;
	return {
		actorId: user.id,
		actorType: "user",
		credentialId: null,
		scope: { kind: "platform" },
		permissions: adminPermissionsForHumanRole(user.role),
	};
}

export function hashAdminToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** A fresh read on EVERY authenticated request, including MCP discovery and calls. */
export async function validateAdminKey(
	token: string,
	client: Client = db,
): Promise<AdminPrincipal | null> {
	if (!/^ez_admin_[A-Za-z0-9_-]{43}$/.test(token)) return null;
	const now = new Date();
	const key = await client.adminApiKey.findUnique({
		where: { keyHash: hashAdminToken(token) },
		include: { account: true },
	});
	if (!key || key.revokedAt || key.expiresAt <= now || key.account.disabledAt) return null;
	const parsed = adminScopeSchema.safeParse(key.account.scope);
	if (!parsed.success || adminScopeKey(parsed.data) !== key.account.scopeKey) return null;
	if (key.account.permissions.some((permission) => !isAdminPermission(permission))) return null;
	const touched = await client.adminApiKey.updateMany({
		where: { id: key.id, revokedAt: null, expiresAt: { gt: now }, account: { disabledAt: null } },
		data: { lastUsedAt: now },
	});
	if (touched.count !== 1) return null;
	return {
		actorId: key.serviceAccountId,
		actorType: "service",
		credentialId: key.id,
		scope: parsed.data,
		permissions: key.account.permissions.filter(isAdminPermission),
	};
}

export async function listAdminServiceAccounts(principal: AdminPrincipal, client: Client = db) {
	assertAdminControlPrincipal(principal);
	const accounts = await client.adminServiceAccount.findMany({
		orderBy: { createdAt: "desc" },
		select: accountSelect,
		take: 500,
	});
	return { accounts: accounts.map(accountSummary) };
}

export async function createAdminServiceAccount(
	input: { name: string; scope: AdminScope; permissions: AdminPermission[] },
	principal: AdminPrincipal,
	client: Client = db,
) {
	assertAdminGrantCeiling(principal, input.permissions);
	const scope = adminScopeSchema.parse(input.scope);
	await assertScopeExists(scope, client);
	return accountSummary(
		await client.adminServiceAccount.create({
			data: {
				name: input.name,
				scope,
				scopeKey: adminScopeKey(scope),
				permissions: [...new Set(input.permissions)],
				createdByUserId: principal.actorId,
			},
			select: accountSelect,
		}),
	);
}

export async function updateAdminServiceAccount(
	input: {
		id: string;
		name?: string;
		scope?: AdminScope;
		permissions?: AdminPermission[];
		disabled?: boolean;
		expectedUpdatedAt: string;
	},
	principal: AdminPrincipal,
	client: Client = db,
) {
	assertAdminControlPrincipal(principal);
	if (input.permissions) assertAdminGrantCeiling(principal, input.permissions);
	return client.$transaction(async (tx) => {
		const previous = await tx.adminServiceAccount.findUnique({ where: { id: input.id } });
		if (!previous) throw new AdminAccessError("ADMIN_ACCOUNT_NOT_FOUND", 404);
		assertAdminGrantCeiling(principal, previous.permissions);
		const scope = input.scope ? adminScopeSchema.parse(input.scope) : undefined;
		if (scope) await assertScopeExists(scope, tx);
		const updated = await tx.adminServiceAccount.updateMany({
			where: { id: input.id, updatedAt: new Date(input.expectedUpdatedAt) },
			data: {
				...(input.name === undefined ? {} : { name: input.name }),
				...(scope ? { scope, scopeKey: adminScopeKey(scope) } : {}),
				...(input.permissions ? { permissions: [...new Set(input.permissions)] } : {}),
				...(input.disabled === undefined ? {} : { disabledAt: input.disabled ? new Date() : null }),
			},
		});
		if (updated.count !== 1) throw new AdminAccessError("ADMIN_ACCOUNT_CHANGED", 409);
		return accountSummary(
			await tx.adminServiceAccount.findUniqueOrThrow({
				where: { id: input.id },
				select: accountSelect,
			}),
		);
	});
}

export async function createAdminKey(
	input: { serviceAccountId: string; name: string; expiresAt: string },
	principal: AdminPrincipal,
	client: Client = db,
) {
	assertAdminControlPrincipal(principal);
	const expiresAt = new Date(input.expiresAt);
	const now = Date.now();
	if (
		!Number.isFinite(expiresAt.getTime()) ||
		expiresAt.getTime() <= now ||
		expiresAt.getTime() > now + 366 * 86_400_000
	) {
		throw new AdminAccessError("ADMIN_KEY_EXPIRY_INVALID");
	}
	const token = `ez_admin_${randomBytes(32).toString("base64url")}`;
	return client.$transaction(async (tx) => {
		const account = await tx.adminServiceAccount.findUnique({
			where: { id: input.serviceAccountId },
		});
		if (!account || account.disabledAt)
			throw new AdminAccessError("ADMIN_ACCOUNT_UNAVAILABLE", 404);
		assertAdminGrantCeiling(principal, account.permissions);
		const key = await tx.adminApiKey.create({
			data: {
				serviceAccountId: account.id,
				name: input.name,
				keyHash: hashAdminToken(token),
				keyPrefix: token.slice(0, 17),
				expiresAt,
				createdByUserId: principal.actorId,
			},
			select: { id: true, name: true, keyPrefix: true, expiresAt: true },
		});
		return { ...key, expiresAt: key.expiresAt.toISOString(), token };
	});
}

export async function revokeAdminKey(
	input: { id: string; serviceAccountId: string },
	principal: AdminPrincipal,
	client: Client = db,
) {
	assertAdminControlPrincipal(principal);
	const account = await client.adminServiceAccount.findUnique({
		where: { id: input.serviceAccountId },
	});
	if (!account) throw new AdminAccessError("ADMIN_ACCOUNT_NOT_FOUND", 404);
	assertAdminGrantCeiling(principal, account.permissions);
	const key = await client.adminApiKey.findFirst({
		where: { id: input.id, serviceAccountId: input.serviceAccountId },
		select: { id: true },
	});
	if (!key) throw new AdminAccessError("ADMIN_KEY_NOT_FOUND", 404);
	await client.adminApiKey.updateMany({
		where: { id: input.id, serviceAccountId: input.serviceAccountId, revokedAt: null },
		data: { revokedAt: new Date() },
	});
	return { id: input.id, revoked: true };
}

export interface ReserveAdminExecutionInput {
	id: string;
	actor: AdminPrincipal;
	operation: string;
	inputHash: string;
	targetId: string | null;
}
/** Unique primary-key insertion is the only winning claim. No lease reclaims uncertain writes. */
export async function reserveAdminExecution(
	input: ReserveAdminExecutionInput,
	client: Client = db,
) {
	const result = await client.adminExecution.createMany({
		data: [
			{
				id: input.id,
				actorId: input.actor.actorId,
				actorType: input.actor.actorType,
				credentialId: input.actor.credentialId,
				scope: input.actor.scope,
				scopeKey: adminScopeKey(input.actor.scope),
				operation: input.operation,
				inputHash: input.inputHash,
				targetId: input.targetId,
				status: "pending",
			},
		],
		skipDuplicates: true,
	});
	return { reserved: result.count === 1 };
}

export async function getAdminExecution(id: string, client: Client = db) {
	return client.adminExecution.findUnique({ where: { id } });
}

export async function finishAdminExecution(
	id: string,
	input: {
		status: "completed" | "failed" | "unknown";
		response?: Prisma.InputJsonValue;
		errorCode?: string;
	},
	client: Client = db,
) {
	// Never overwrite a finished receipt with a late failure.
	await client.adminExecution.updateMany({
		where: { id, status: "pending" },
		data: {
			status: input.status,
			...(input.response === undefined ? {} : { response: input.response }),
			errorCode: input.errorCode ?? null,
			completedAt: new Date(),
		},
	});
}

export async function listAdminExecutions(
	principal: AdminPrincipal,
	input: { page: number; pageSize: number; serviceAccountId?: string },
	client: Client = db,
) {
	if (!principal.permissions.includes("admin.audit.read"))
		throw new AdminAccessError("ADMIN_PERMISSION_DENIED", 403);
	if (
		principal.actorType === "service" &&
		input.serviceAccountId &&
		input.serviceAccountId !== principal.actorId
	) {
		throw new AdminAccessError("ADMIN_SCOPE_DENIED", 403);
	}
	const where: Prisma.AdminExecutionWhereInput =
		principal.actorType === "service"
			? {
					actorType: "service",
					actorId: principal.actorId,
					scopeKey: adminScopeKey(principal.scope),
				}
			: input.serviceAccountId
				? { actorType: "service", actorId: input.serviceAccountId }
				: {};
	const [rows, total] = await Promise.all([
		client.adminExecution.findMany({
			where,
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			skip: (input.page - 1) * input.pageSize,
			take: input.pageSize,
			select: {
				id: true,
				actorId: true,
				actorType: true,
				credentialId: true,
				scope: true,
				operation: true,
				targetId: true,
				status: true,
				errorCode: true,
				createdAt: true,
				completedAt: true,
			},
		}),
		client.adminExecution.count({ where }),
	]);
	return {
		items: rows.map((row) => ({
			...row,
			scope: adminScopeSchema.parse(row.scope),
			createdAt: row.createdAt.toISOString(),
			completedAt: row.completedAt?.toISOString() ?? null,
		})),
		total,
	};
}
