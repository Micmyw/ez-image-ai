import { AsyncLocalStorage } from "node:async_hooks";

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

/**
 * Better Auth owns anonymous User/Session creation. This request-local value
 * only gives its anonymous plugin a deterministic, claim-bound email so a
 * failed bootstrap can identify and remove the exact temporary principal.
 */
export function runAnonymousBootstrapIdentity<T>(email: string, operation: () => T): T {
	return anonymousBootstrapIdentity.run({ email }, operation);
}

export function getAnonymousBootstrapEmail(): string {
	const email = anonymousBootstrapIdentity.getStore()?.email;
	if (!email) throw new Error("GUEST_BOOTSTRAP_CONTEXT_REQUIRED");
	return email;
}

const anonymousBootstrapIdentity = new AsyncLocalStorage<{ email: string }>();
