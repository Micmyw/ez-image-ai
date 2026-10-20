import { adminExecuteInputSchema } from "@repo/database/admin-agent-contracts";

import { authenticateAdmin, expectedAdminOrigin } from "./auth";
import { adminOperations, findAdminOperation } from "./catalog";
import { adminOperationDescriptor, availableAdminOperations } from "./discovery";
import { executeAdminOperation } from "./execute";
import {
	adminErrorDetails,
	adminErrorResponse,
	privateAdminResponse,
	readAdminJson,
} from "./http-utils";
import { AdminGatewayError } from "./types";

const protocols = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
type RpcId = string | number | null;
function rpcError(id: RpcId, code: number, message: string, status = 200) {
	return privateAdminResponse({ jsonrpc: "2.0", id, error: { code, message } }, status);
}
const defaultDependencies = {
	authenticate: authenticateAdmin,
	operations: adminOperations,
	execute: executeAdminOperation,
};

/** Stateless Streamable HTTP: JSON responses, no SSE stream and no server-side session. */
export async function handleAdminMcp(request: Request, dependencies = defaultDependencies) {
	try {
		if (!request.headers.get("authorization"))
			throw new AdminGatewayError("ADMIN_BEARER_REQUIRED", 401);
		const origin = request.headers.get("origin");
		if (origin && origin !== expectedAdminOrigin(request))
			throw new AdminGatewayError("ADMIN_ORIGIN_DENIED", 403);
		const actor = await dependencies.authenticate(request);
		if (actor.actorType !== "service") throw new AdminGatewayError("ADMIN_BEARER_REQUIRED", 401);
		if (request.method !== "POST") {
			return privateAdminResponse({ error: { code: "MCP_STATELESS_POST_ONLY" } }, 405, {
				Allow: "POST",
			});
		}
		let body: unknown;
		try {
			body = await readAdminJson(request);
		} catch (error) {
			if (error instanceof AdminGatewayError && error.code === "ADMIN_JSON_INVALID") {
				return rpcError(null, -32700, "Invalid JSON.", 400);
			}
			throw error;
		}
		if (!body || typeof body !== "object" || Array.isArray(body))
			return rpcError(null, -32600, "A single JSON-RPC request is required.", 400);
		const rpc = body as Record<string, unknown>;
		if (
			"id" in rpc &&
			rpc.id !== null &&
			typeof rpc.id !== "string" &&
			!(typeof rpc.id === "number" && Number.isFinite(rpc.id))
		) {
			return rpcError(null, -32600, "Invalid JSON-RPC request ID.", 400);
		}
		const id =
			typeof rpc.id === "string" || typeof rpc.id === "number" || rpc.id === null ? rpc.id : null;
		if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string")
			return rpcError(id, -32600, "Invalid JSON-RPC request.", 400);
		if (!("id" in rpc)) {
			if (!rpc.method.startsWith("notifications/"))
				return rpcError(null, -32600, "Request ID is required.", 400);
			return new Response(null, {
				status: 202,
				headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" },
			});
		}
		const protocol = request.headers.get("mcp-protocol-version");
		if (protocol && !protocols.some((supported) => supported === protocol))
			return rpcError(id, -32600, "Unsupported MCP protocol version.", 400);
		const result = (value: unknown) => privateAdminResponse({ jsonrpc: "2.0", id, result: value });
		const params =
			rpc.params && typeof rpc.params === "object" && !Array.isArray(rpc.params)
				? (rpc.params as Record<string, unknown>)
				: {};
		switch (rpc.method) {
			case "initialize": {
				const requested = params.protocolVersion;
				return result({
					protocolVersion: protocols.find((version) => version === requested) ?? protocols[0],
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "ezpic-admin", version: "1.0.0" },
					instructions: `Administration of EzPic at ${new URL(request.url).origin}. Scope: ${JSON.stringify(actor.scope)}. Every call rechecks authorization. Keep project IDs and keys separate. An available tool is not authorization to refund, grant credits or send messages. Unknown writes require reconciliation, never a new key. Pre-issued bearer keys only; no OAuth flow.`,
				});
			}
			case "ping":
				return result({});
			case "tools/list":
				return result({
					tools: availableAdminOperations(actor, dependencies.operations).map((operation) => ({
						name: operation.name,
						description: operation.description,
						inputSchema: {
							type: "object",
							additionalProperties: false,
							properties: {
								input: adminOperationDescriptor(operation).inputSchema,
								idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9_.:-]{8,128}$" },
							},
							required: operation.readOnly ? ["input"] : ["input", "idempotencyKey"],
						},
						annotations: {
							readOnlyHint: operation.readOnly,
							destructiveHint: !operation.readOnly,
							idempotentHint: true,
							openWorldHint: [
								"orders_refund",
								"orders_reconcile",
								"tickets_reply",
								"notifications_test",
							].includes(operation.name),
						},
					})),
				});
			case "tools/call": {
				try {
					const args =
						params.arguments && typeof params.arguments === "object"
							? (params.arguments as Record<string, unknown>)
							: {};
					const input = adminExecuteInputSchema.parse({ ...args, operation: params.name });
					const operation = findAdminOperation(input.operation, dependencies.operations);
					const receipt = await dependencies.execute(
						operation,
						input.input,
						actor,
						input.idempotencyKey,
					);
					return result({
						content: [{ type: "text", text: JSON.stringify(receipt) }],
						structuredContent: receipt,
						isError: false,
					});
				} catch (error) {
					const { status: _status, ...detail } = adminErrorDetails(error);
					return result({
						content: [{ type: "text", text: JSON.stringify({ error: detail }) }],
						structuredContent: { error: detail },
						isError: true,
					});
				}
			}
			default:
				return rpcError(id, -32601, "Method not found.");
		}
	} catch (error) {
		return adminErrorResponse(error);
	}
}
