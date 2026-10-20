import { ORPCError } from "@orpc/server";
import { listAdminExecutions, listAdminServiceAccounts } from "@repo/database/admin-access";
import {
	adminAccountCreateInputSchema,
	adminAccountUpdateInputSchema,
	adminAccountsOutputSchema,
	adminAuditInputSchema,
	adminAuditOutputSchema,
	adminExecuteInputSchema,
	adminExecutionResultSchema,
	adminKeyCreateInputSchema,
	adminKeyRevokeInputSchema,
	adminOperationsOutputSchema,
} from "@repo/database/admin-agent-contracts";
import { z } from "zod";

import { publicProcedure } from "../../orpc/procedures";
import { assertAdminControlActor, assertAdminSessionWriteOrigin, authenticateAdmin } from "./auth";
import { findAdminOperation } from "./catalog";
import { executeAdminControl } from "./control";
import { adminOperationCatalog } from "./discovery";
import { executeAdminOperation } from "./execute";
import { adminErrorDetails } from "./http-utils";

function requestFromHeaders(headers: Headers) {
	// The configured public origin is authoritative; forwarded headers never choose a CSRF origin.
	return new Request(
		new URL("/api/admin/agent", process.env.NEXT_PUBLIC_SAAS_URL || "http://localhost:3000"),
		{
			method: "POST",
			headers,
		},
	);
}

async function rpcErrors<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof ORPCError) throw error;
		const detail = adminErrorDetails(error);
		const codes = {
			400: "BAD_REQUEST",
			401: "UNAUTHORIZED",
			403: "FORBIDDEN",
			404: "NOT_FOUND",
			409: "CONFLICT",
			412: "PRECONDITION_FAILED",
			503: "SERVICE_UNAVAILABLE",
		} as const;
		const code = codes[detail.status as keyof typeof codes] ?? "INTERNAL_SERVER_ERROR";
		throw new ORPCError(code, {
			message: detail.code,
			data: "executionId" in detail ? { executionId: detail.executionId } : undefined,
		});
	}
}

// Module authentication handles both Bearer and session explicitly, avoiding a cookie fallback.
const capabilityProcedure = publicProcedure.use(async ({ context, next }) =>
	rpcErrors(async () => {
		context.responseHeaders?.set("Cache-Control", "private, no-store");
		context.responseHeaders?.set("X-Robots-Tag", "noindex, nofollow");
		const adminRequest = requestFromHeaders(context.headers);
		const adminActor = await authenticateAdmin(adminRequest);
		return next({ context: { adminRequest, adminActor } });
	}),
);
const controlProcedure = capabilityProcedure.use(async ({ context, next }) =>
	rpcErrors(async () => {
		assertAdminControlActor(context.adminActor);
		return next();
	}),
);
const metadata = { tags: ["Administration capabilities"] };

export const adminCapabilitiesRouter = {
	operations: capabilityProcedure
		.route({
			...metadata,
			method: "GET",
			path: "/admin/agent/rpc-operations",
			summary: "Discover available administration operations",
			description: "Fresh permissions and scope, shared with REST and MCP.",
		})
		.input(z.object({}).strict())
		.output(adminOperationsOutputSchema)
		.handler(({ context }) => adminOperationCatalog(context.adminActor)),
	execute: capabilityProcedure
		.route({
			...metadata,
			method: "POST",
			path: "/admin/agent/rpc-execute",
			summary: "Execute a controlled administration operation",
			description:
				"All writes require an idempotency key and session writes require the same origin.",
		})
		.input(adminExecuteInputSchema)
		.output(adminExecutionResultSchema)
		.handler(({ input, context }) =>
			rpcErrors(async () => {
				const operation = findAdminOperation(input.operation);
				if (!operation.readOnly)
					assertAdminSessionWriteOrigin(context.adminRequest, context.adminActor);
				return executeAdminOperation(
					operation,
					input.input,
					context.adminActor,
					input.idempotencyKey,
				);
			}),
		),
	audit: capabilityProcedure
		.route({
			...metadata,
			method: "GET",
			path: "/admin/agent/rpc-audit",
			summary: "Read administration execution receipts",
			description:
				"Machine accounts can read only their own current scope across their credentials; payloads and hashes are excluded.",
		})
		.input(adminAuditInputSchema)
		.output(adminAuditOutputSchema)
		.handler(({ input, context }) =>
			rpcErrors(async () =>
				adminAuditOutputSchema.parse(await listAdminExecutions(context.adminActor, input)),
			),
		),
	accounts: {
		list: controlProcedure
			.route({
				...metadata,
				method: "GET",
				path: "/admin/agent/rpc-accounts",
				summary: "List service accounts",
				description: "Human platform administrator session only.",
			})
			.input(z.object({}).strict())
			.output(adminAccountsOutputSchema)
			.handler(({ context }) => rpcErrors(() => listAdminServiceAccounts(context.adminActor))),
		create: controlProcedure
			.route({
				...metadata,
				method: "POST",
				path: "/admin/agent/rpc-accounts",
				summary: "Create a service account",
				description:
					"Scope and exact capabilities cannot exceed the current administrator ceiling.",
			})
			.input(adminAccountCreateInputSchema)
			.output(adminExecutionResultSchema)
			.handler(({ input, context }) =>
				rpcErrors(async () => {
					assertAdminSessionWriteOrigin(context.adminRequest, context.adminActor);
					return executeAdminControl("createAccount", input, context.adminActor);
				}),
			),
		update: controlProcedure
			.route({
				...metadata,
				method: "PATCH",
				path: "/admin/agent/rpc-accounts",
				summary: "Change a service account",
				description:
					"Compare the last update timestamp; scope, grants and disable changes affect the next request.",
			})
			.input(adminAccountUpdateInputSchema)
			.output(adminExecutionResultSchema)
			.handler(({ input, context }) =>
				rpcErrors(async () => {
					assertAdminSessionWriteOrigin(context.adminRequest, context.adminActor);
					return executeAdminControl("updateAccount", input, context.adminActor);
				}),
			),
	},
	keys: {
		create: controlProcedure
			.route({
				...metadata,
				method: "POST",
				path: "/admin/agent/rpc-keys",
				summary: "Issue a key once",
				description:
					"Only a hash is stored. The token is returned once and never saved in replay records.",
			})
			.input(adminKeyCreateInputSchema)
			.output(adminExecutionResultSchema)
			.handler(({ input, context }) =>
				rpcErrors(async () => {
					assertAdminSessionWriteOrigin(context.adminRequest, context.adminActor);
					return executeAdminControl("createKey", input, context.adminActor);
				}),
			),
		revoke: controlProcedure
			.route({
				...metadata,
				method: "PATCH",
				path: "/admin/agent/rpc-keys",
				summary: "Revoke a key",
				description: "The next request will reject the revoked credential.",
			})
			.input(adminKeyRevokeInputSchema)
			.output(adminExecutionResultSchema)
			.handler(({ input, context }) =>
				rpcErrors(async () => {
					assertAdminSessionWriteOrigin(context.adminRequest, context.adminActor);
					return executeAdminControl("revokeKey", input, context.adminActor);
				}),
			),
	},
};
