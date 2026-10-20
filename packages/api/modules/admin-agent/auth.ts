import { auth } from "@repo/auth";
import {
	getHumanAdminPrincipal,
	validateAdminKey,
	type AdminPrincipal,
} from "@repo/database/admin-access";

import { AdminGatewayError, type AdminOperation } from "./types";

export async function authenticateAdmin(request: Request): Promise<AdminPrincipal> {
	const authorization = request.headers.get("authorization");
	// A supplied, unusable credential is a hard failure even when an admin cookie exists.
	if (authorization !== null) {
		const token = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
		const principal = token ? await validateAdminKey(token) : null;
		if (!principal) throw new AdminGatewayError("ADMIN_KEY_INVALID", 401);
		return principal;
	}
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user || session.user.role !== "admin" || session.user.isAnonymous) {
		throw new AdminGatewayError("HUMAN_ADMIN_REQUIRED", session ? 403 : 401);
	}
	const principal = await getHumanAdminPrincipal(session.user.id);
	if (!principal) throw new AdminGatewayError("HUMAN_ADMIN_REQUIRED", 403);
	return principal;
}

export function isAdminOperationAllowed(actor: AdminPrincipal, operation: AdminOperation): boolean {
	return (
		actor.permissions.includes(operation.permission) &&
		(!operation.platformOnly || actor.scope.kind === "platform") &&
		(!operation.humanOnly || actor.actorType === "user")
	);
}

export function requireAdminOperation(actor: AdminPrincipal, operation: AdminOperation) {
	if (!isAdminOperationAllowed(actor, operation)) {
		throw new AdminGatewayError("ADMIN_PERMISSION_DENIED", 403);
	}
}

export function expectedAdminOrigin(request: Request): string {
	const configured = process.env.NEXT_PUBLIC_SAAS_URL;
	return new URL(configured || request.url).origin;
}

export function assertAdminSessionWriteOrigin(request: Request, actor: AdminPrincipal) {
	if (actor.actorType === "service") return;
	if (request.headers.get("origin") !== expectedAdminOrigin(request)) {
		throw new AdminGatewayError("ADMIN_SAME_ORIGIN_REQUIRED", 403);
	}
}

export function assertAdminControlActor(actor: AdminPrincipal) {
	if (
		actor.actorType !== "user" ||
		actor.credentialId !== null ||
		actor.scope.kind !== "platform"
	) {
		throw new AdminGatewayError("HUMAN_ADMIN_REQUIRED", 403);
	}
}
