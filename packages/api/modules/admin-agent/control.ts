import {
	createAdminKey,
	createAdminServiceAccount,
	revokeAdminKey,
	updateAdminServiceAccount,
} from "@repo/database/admin-access";
import {
	adminAccountCreateInputSchema,
	adminAccountUpdateInputSchema,
	adminKeyCreateInputSchema,
	adminKeyRevokeInputSchema,
} from "@repo/database/admin-agent-contracts";

import { assertAdminControlActor } from "./auth";
import { executeAdminOperation } from "./execute";
import type { AdminActor, AdminOperation } from "./types";

const controlOperations: Record<
	"createAccount" | "updateAccount" | "createKey" | "revokeKey",
	AdminOperation
> = {
	createAccount: {
		name: "control.accounts.create",
		description: "Create a service account",
		permission: "admin.audit.read",
		method: "POST",
		path: "/api/admin/agent/accounts",
		inputSchema: adminAccountCreateInputSchema.omit({ idempotencyKey: true }),
		readOnly: false,
		humanOnly: true,
		platformOnly: true,
		handler: (input, _context, actor) =>
			createAdminServiceAccount(
				adminAccountCreateInputSchema.omit({ idempotencyKey: true }).parse(input),
				actor,
			),
	},
	updateAccount: {
		name: "control.accounts.update",
		description: "Update service authorization",
		permission: "admin.audit.read",
		method: "PATCH",
		path: "/api/admin/agent/accounts",
		inputSchema: adminAccountUpdateInputSchema.omit({ idempotencyKey: true }),
		readOnly: false,
		humanOnly: true,
		platformOnly: true,
		handler: (input, _context, actor) =>
			updateAdminServiceAccount(
				adminAccountUpdateInputSchema.omit({ idempotencyKey: true }).parse(input),
				actor,
			),
	},
	createKey: {
		name: "control.keys.create",
		description: "Issue a management key once",
		permission: "admin.audit.read",
		method: "POST",
		path: "/api/admin/agent/keys",
		inputSchema: adminKeyCreateInputSchema.omit({ idempotencyKey: true }),
		readOnly: false,
		humanOnly: true,
		platformOnly: true,
		omitReplay: true,
		handler: (input, _context, actor) =>
			createAdminKey(adminKeyCreateInputSchema.omit({ idempotencyKey: true }).parse(input), actor),
	},
	revokeKey: {
		name: "control.keys.revoke",
		description: "Revoke a management key",
		permission: "admin.audit.read",
		method: "PATCH",
		path: "/api/admin/agent/keys",
		inputSchema: adminKeyRevokeInputSchema.omit({ idempotencyKey: true }),
		readOnly: false,
		humanOnly: true,
		platformOnly: true,
		handler: (input, _context, actor) =>
			revokeAdminKey(adminKeyRevokeInputSchema.omit({ idempotencyKey: true }).parse(input), actor),
	},
};

export function executeAdminControl(
	action: keyof typeof controlOperations,
	input: { idempotencyKey: string; [key: string]: unknown },
	actor: AdminActor,
) {
	assertAdminControlActor(actor);
	const { idempotencyKey, ...value } = input;
	return executeAdminOperation(controlOperations[action], value, actor, idempotencyKey);
}
