/** Scope is resolved from a server-authenticated principal, never from an operation's input. */
export type AdminScope =
	| { kind: "platform" }
	| { kind: "organization"; organizationId: string }
	| { kind: "user"; userId: string };

export function adminScopeKey(scope: AdminScope): string {
	switch (scope.kind) {
		case "platform":
			return "platform";
		case "organization":
			return `organization:${scope.organizationId}`;
		case "user":
			return `user:${scope.userId}`;
	}
}

export function adminScopeAllowsOwner(
	scope: AdminScope,
	owner: { ownerType: string; ownerId: string },
): boolean {
	return (
		scope.kind === "platform" ||
		(scope.kind === "organization" &&
			owner.ownerType === "ORGANIZATION" &&
			owner.ownerId === scope.organizationId) ||
		(scope.kind === "user" && owner.ownerType === "USER" && owner.ownerId === scope.userId)
	);
}
