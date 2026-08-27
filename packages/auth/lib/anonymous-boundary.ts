export interface BetterAuthUserBoundary {
	id: string;
	isAnonymous?: boolean | null;
}

export interface BetterAuthSessionBoundary {
	user: BetterAuthUserBoundary;
	session: { userId?: string } & Record<string, unknown>;
}

export function isAnonymousUser(user: { isAnonymous?: boolean | null }): boolean {
	return user.isAnonymous === true;
}

export function assertRegisteredSession(
	session: BetterAuthSessionBoundary | null | undefined,
): asserts session is BetterAuthSessionBoundary {
	if (!session || isAnonymousUser(session.user)) {
		throw new Error("REGISTERED_SESSION_REQUIRED");
	}
}

export function assertAnonymousSession(
	session: BetterAuthSessionBoundary | null | undefined,
): asserts session is BetterAuthSessionBoundary {
	if (!session || !isAnonymousUser(session.user)) {
		throw new Error("ANONYMOUS_SESSION_REQUIRED");
	}
}

export async function runRegisteredUserCreatedLifecycle(
	user: BetterAuthUserBoundary,
	lifecycle: (userId: string) => Promise<void>,
): Promise<boolean> {
	if (isAnonymousUser(user)) return false;
	await lifecycle(user.id);
	return true;
}
