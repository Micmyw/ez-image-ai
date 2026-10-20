import { z } from "zod";

import { ADMIN_PERMISSION_CODES } from "./admin-permissions";

const id = z.string().trim().min(1).max(191);
const timestamp = z.iso.datetime({ offset: true });
export const adminScopeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("platform") }).strict(),
	z.object({ kind: z.literal("organization"), organizationId: id }).strict(),
	z.object({ kind: z.literal("user"), userId: id }).strict(),
]);
export const adminPermissionSchema = z.enum(ADMIN_PERMISSION_CODES);
export const adminIdempotencyKeySchema = z
	.string()
	.regex(
		/^[A-Za-z0-9_.:-]{8,128}$/,
		"Use 8–128 letters, digits, dots, underscores, colons or hyphens.",
	);
export const adminExecuteInputSchema = z
	.object({
		operation: z.string().min(1).max(80),
		input: z.unknown(),
		idempotencyKey: adminIdempotencyKeySchema.optional(),
	})
	.strict();
export const adminExecutionResultSchema = z.object({
	executionId: z.string(),
	replayed: z.boolean(),
	result: z.unknown(),
});
export const adminOperationDescriptorSchema = z.object({
	name: z.string(),
	description: z.string(),
	permission: adminPermissionSchema,
	readOnly: z.boolean(),
	method: z.enum(["GET", "POST", "PATCH"]),
	path: z.string(),
	inputSchema: z.record(z.string(), z.unknown()),
});
export const adminOperationsOutputSchema = z.object({
	operations: z.array(adminOperationDescriptorSchema),
	permissions: z.array(adminPermissionSchema),
	scope: adminScopeSchema,
});
export const adminKeySummarySchema = z.object({
	id: z.string(),
	name: z.string(),
	keyPrefix: z.string(),
	expiresAt: timestamp,
	revokedAt: timestamp.nullable(),
	lastUsedAt: timestamp.nullable(),
	createdAt: timestamp,
});
export const adminServiceAccountSchema = z.object({
	id: z.string(),
	name: z.string(),
	scope: adminScopeSchema,
	permissions: z.array(adminPermissionSchema),
	disabledAt: timestamp.nullable(),
	createdAt: timestamp,
	updatedAt: timestamp,
	keys: z.array(adminKeySummarySchema),
});
export const adminAccountsOutputSchema = z.object({
	accounts: z.array(adminServiceAccountSchema),
});
export const adminAccountCreateInputSchema = z
	.object({
		name: z.string().trim().min(1).max(100),
		scope: adminScopeSchema,
		permissions: z.array(adminPermissionSchema).min(1).max(ADMIN_PERMISSION_CODES.length),
		idempotencyKey: adminIdempotencyKeySchema,
	})
	.strict();
export const adminAccountUpdateInputSchema = z
	.object({
		id,
		name: z.string().trim().min(1).max(100).optional(),
		scope: adminScopeSchema.optional(),
		permissions: z.array(adminPermissionSchema).max(ADMIN_PERMISSION_CODES.length).optional(),
		disabled: z.boolean().optional(),
		expectedUpdatedAt: timestamp,
		idempotencyKey: adminIdempotencyKeySchema,
	})
	.strict();
export const adminKeyCreateInputSchema = z
	.object({
		serviceAccountId: id,
		name: z.string().trim().min(1).max(100),
		expiresAt: timestamp,
		idempotencyKey: adminIdempotencyKeySchema,
	})
	.strict();
export const adminKeyCreatedSchema = z.object({
	id: z.string(),
	name: z.string(),
	keyPrefix: z.string(),
	expiresAt: timestamp,
	token: z.string(),
});
export const adminKeyRevokeInputSchema = z
	.object({
		serviceAccountId: id,
		id,
		idempotencyKey: adminIdempotencyKeySchema,
	})
	.strict();
export const adminAuditInputSchema = z
	.object({
		page: z.coerce.number().int().min(1).max(100_000).default(1),
		pageSize: z.coerce.number().int().min(1).max(100).default(20),
		serviceAccountId: id.optional(),
	})
	.strict();
export const adminAuditItemSchema = z.object({
	id: z.string(),
	actorId: z.string(),
	actorType: z.enum(["user", "service"]),
	credentialId: z.string().nullable(),
	scope: adminScopeSchema,
	operation: z.string(),
	targetId: z.string().nullable(),
	status: z.enum(["pending", "completed", "failed", "unknown"]),
	errorCode: z.string().nullable(),
	createdAt: timestamp,
	completedAt: timestamp.nullable(),
});
export const adminAuditOutputSchema = z.object({
	items: z.array(adminAuditItemSchema),
	total: z.number().int().nonnegative(),
});

export type AdminExecutionResult = z.infer<typeof adminExecutionResultSchema>;
export type AdminServiceAccountSummary = z.infer<typeof adminServiceAccountSchema>;
export type AdminOperationDescriptor = z.infer<typeof adminOperationDescriptorSchema>;
export type AdminAuditItem = z.infer<typeof adminAuditItemSchema>;
