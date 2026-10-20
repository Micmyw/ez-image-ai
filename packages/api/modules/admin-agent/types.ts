import type { AdminPrincipal } from "@repo/database/admin-access";
import type { AdminPermission } from "@repo/database/admin-permissions";
import type { AdminScope } from "@repo/database/admin-scope";
import type { z } from "zod";

export type AdminActor = AdminPrincipal;
export interface AdminHandlerContext {
	scope: AdminScope;
	actorId: string;
	actorKind: "user" | "service";
	executionId: string;
	/** Business references use the stable reservation ID, never a fresh retry ID. */
	idempotencyKey: string;
}
export interface AdminOperation {
	name: string;
	description: string;
	permission: AdminPermission;
	method: "GET" | "POST" | "PATCH";
	path: string;
	inputSchema: z.ZodType;
	readOnly: boolean;
	platformOnly?: boolean;
	humanOnly?: boolean;
	/** Issued credentials must never enter the replay journal. */
	omitReplay?: boolean;
	handler: (input: unknown, context: AdminHandlerContext, actor: AdminActor) => Promise<unknown>;
}
export class AdminGatewayError extends Error {
	constructor(
		readonly code: string,
		readonly status: number = 400,
		message: string = code,
		readonly executionId?: string,
	) {
		super(message);
	}
}
