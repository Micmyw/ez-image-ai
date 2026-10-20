import { listAdminExecutions, listAdminServiceAccounts } from "@repo/database/admin-access";
import {
	adminAccountCreateInputSchema,
	adminAccountUpdateInputSchema,
	adminAuditInputSchema,
	adminExecuteInputSchema,
	adminKeyCreateInputSchema,
	adminKeyRevokeInputSchema,
} from "@repo/database/admin-agent-contracts";
import { Hono } from "hono";

import { assertAdminControlActor, assertAdminSessionWriteOrigin, authenticateAdmin } from "./auth";
import { adminOperations, findAdminOperation } from "./catalog";
import { executeAdminControl } from "./control";
import { adminOpenApi, adminOperationCatalog, adminOperationDescriptor } from "./discovery";
import { executeAdminOperation } from "./execute";
import { adminErrorResponse, privateAdminResponse, readAdminJson } from "./http-utils";
import { handleAdminMcp } from "./mcp";
import { AdminGatewayError, type AdminOperation } from "./types";

const defaultDependencies = {
	authenticate: authenticateAdmin,
	operations: adminOperations,
	execute: executeAdminOperation,
};

function idempotencyKey(request: Request, fromBody?: string) {
	const header = request.headers.get("idempotency-key");
	if (header && fromBody && header !== fromBody)
		throw new AdminGatewayError("ADMIN_IDEMPOTENCY_CONFLICT", 409);
	return fromBody ?? header ?? undefined;
}

function queryInput(request: Request, operation: AdminOperation) {
	const properties = (adminOperationDescriptor(operation).inputSchema.properties ?? {}) as Record<
		string,
		Record<string, unknown>
	>;
	return Object.fromEntries(
		[...new URL(request.url).searchParams].map(([key, value]) => {
			const schema = properties[key];
			if (schema?.type === "number" || schema?.type === "integer") return [key, Number(value)];
			if (schema?.type === "boolean")
				return [key, value === "true" ? true : value === "false" ? false : value];
			if (schema?.type === "object" || schema?.type === "array" || schema?.anyOf || schema?.oneOf) {
				try {
					return [key, JSON.parse(value)];
				} catch {
					return [key, value];
				}
			}
			return [key, value];
		}),
	);
}

function receiptResponse(receipt: Awaited<ReturnType<typeof executeAdminOperation>>) {
	return privateAdminResponse(receipt, 200, {
		"X-Admin-Execution-Id": receipt.executionId,
		...(receipt.replayed ? { "Idempotency-Replayed": "true" } : {}),
	});
}

export async function handleAdminHttpRequest(
	request: Request,
	dependencies = defaultDependencies,
): Promise<Response> {
	const path = new URL(request.url).pathname;
	if (path === "/api/admin/agent/mcp") return handleAdminMcp(request, dependencies);
	try {
		const actor = await dependencies.authenticate(request);
		if (path === "/api/admin/agent/operations" && request.method === "GET") {
			return privateAdminResponse(adminOperationCatalog(actor, dependencies.operations));
		}
		if (path === "/api/admin/agent/openapi" && request.method === "GET") {
			return privateAdminResponse(adminOpenApi(actor, dependencies.operations));
		}
		if (path === "/api/admin/agent/audit" && request.method === "GET") {
			return privateAdminResponse(
				await listAdminExecutions(
					actor,
					adminAuditInputSchema.parse(Object.fromEntries(new URL(request.url).searchParams)),
				),
			);
		}
		if (path === "/api/admin/agent/accounts" && request.method === "GET") {
			assertAdminControlActor(actor);
			return privateAdminResponse(await listAdminServiceAccounts(actor));
		}
		if (path === "/api/admin/agent/execute" && request.method === "POST") {
			const body = adminExecuteInputSchema.parse(await readAdminJson(request));
			const operation = findAdminOperation(body.operation, dependencies.operations);
			if (!operation.readOnly) assertAdminSessionWriteOrigin(request, actor);
			return receiptResponse(
				await dependencies.execute(
					operation,
					body.input,
					actor,
					idempotencyKey(request, body.idempotencyKey),
				),
			);
		}
		if (
			(path === "/api/admin/agent/accounts" || path === "/api/admin/agent/keys") &&
			["POST", "PATCH"].includes(request.method)
		) {
			assertAdminControlActor(actor);
			assertAdminSessionWriteOrigin(request, actor);
			const raw = await readAdminJson(request);
			if (!raw || typeof raw !== "object" || Array.isArray(raw))
				throw new AdminGatewayError("ADMIN_INPUT_INVALID");
			const record = raw as Record<string, unknown>;
			const input = {
				...record,
				idempotencyKey: idempotencyKey(
					request,
					typeof record.idempotencyKey === "string" ? record.idempotencyKey : undefined,
				),
			};
			if (path.endsWith("/accounts")) {
				return receiptResponse(
					request.method === "POST"
						? await executeAdminControl(
								"createAccount",
								adminAccountCreateInputSchema.parse(input),
								actor,
							)
						: await executeAdminControl(
								"updateAccount",
								adminAccountUpdateInputSchema.parse(input),
								actor,
							),
				);
			}
			return receiptResponse(
				request.method === "POST"
					? await executeAdminControl("createKey", adminKeyCreateInputSchema.parse(input), actor)
					: await executeAdminControl("revokeKey", adminKeyRevokeInputSchema.parse(input), actor),
			);
		}
		const operation = dependencies.operations.find(
			(candidate) => candidate.path === path && candidate.method === request.method,
		);
		if (!operation) throw new AdminGatewayError("ADMIN_ROUTE_NOT_FOUND", 404);
		if (!operation.readOnly) assertAdminSessionWriteOrigin(request, actor);
		const input =
			operation.method === "GET" ? queryInput(request, operation) : await readAdminJson(request);
		return receiptResponse(
			await dependencies.execute(operation, input, actor, idempotencyKey(request)),
		);
	} catch (error) {
		return adminErrorResponse(error);
	}
}

export function createAdminAgentRoutes() {
	const routes = new Hono();
	for (const path of ["operations", "openapi", "execute", "audit", "accounts", "keys", "mcp"]) {
		routes.all(`/agent/${path}`, (context) => handleAdminHttpRequest(context.req.raw));
	}
	for (const operation of adminOperations) {
		routes.on(operation.method, operation.path.replace(/^\/api\/admin/, ""), (context) =>
			handleAdminHttpRequest(context.req.raw),
		);
	}
	return routes;
}
