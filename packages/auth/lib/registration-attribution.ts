import {
	ATTRIBUTION_COOKIE_NAME,
	sanitizeFirstTouchAttribution,
	type RegistrationAttribution,
} from "@repo/utils";
import { parseCookie } from "cookie";

import { isAnonymousUser, type BetterAuthUserBoundary } from "./anonymous-boundary";

interface RegistrationRequestContext {
	path?: string;
	request?: Request;
	headers?: Headers;
	params?: { id?: unknown };
}

/** Only Better Auth's enabled registration journeys can attribute a new user. */
export function isRegistrationCreationPath(
	path: string | undefined,
	providerId?: unknown,
): boolean {
	return (
		path === "/sign-up/email" ||
		path === "/sign-in/social" ||
		path === "/magic-link/verify" ||
		/^\/callback\/(?:google|github)$/.test(path ?? "") ||
		(path === "/callback/:id" && (providerId === "google" || providerId === "github"))
	);
}

export function getRegistrationAttributionSnapshot(
	context: RegistrationRequestContext | null | undefined,
	origin: string,
	now = new Date(),
): RegistrationAttribution | null {
	if (!isRegistrationCreationPath(context?.path, context?.params?.id)) return null;
	const headers = context?.headers ?? context?.request?.headers;
	const cookies = parseCookie(headers?.get("cookie") ?? "");
	if (cookies.consent !== "true") return null;
	const encoded = cookies[ATTRIBUTION_COOKIE_NAME];
	if (!encoded || encoded.length > 4096) return null;

	try {
		// cookie.parseCookie decodes the URI-encoded browser cookie once.
		const value: unknown = JSON.parse(encoded);
		const firstTouch = sanitizeFirstTouchAttribution(value, origin, now);
		return firstTouch ? { ...firstTouch, registeredAt: now.toISOString() } : null;
	} catch {
		return null;
	}
}

/** The user comes from the adapter's create hook, never from an auth request body. */
export async function persistNewUserRegistrationAttribution(
	user: BetterAuthUserBoundary,
	context: RegistrationRequestContext | null | undefined,
	dependencies: {
		origin: string;
		now?: Date;
		save: (userId: string, snapshot: RegistrationAttribution) => Promise<unknown>;
	},
): Promise<boolean> {
	if (!user.id || isAnonymousUser(user)) return false;
	const snapshot = getRegistrationAttributionSnapshot(
		context,
		dependencies.origin,
		dependencies.now,
	);
	if (!snapshot) return false;
	await dependencies.save(user.id, snapshot);
	return true;
}

export function shouldClearRegistrationAttributionCookie(context: {
	path?: string;
	context: {
		newSession?: { user: BetterAuthUserBoundary } | null;
		returned?: unknown;
	};
}): boolean {
	const returned = context.context.returned;
	if (context.path === "/sign-out") {
		return (
			!!returned &&
			typeof returned === "object" &&
			"success" in returned &&
			returned.success === true
		);
	}
	const signedInUser = context.context.newSession?.user;
	if (signedInUser?.id && !isAnonymousUser(signedInUser)) return true;
	if (context.path !== "/sign-up/email") return false;
	if (!returned || typeof returned !== "object" || !("user" in returned)) return false;
	const user = returned.user;
	return !!user && typeof user === "object" && "id" in user && typeof user.id === "string";
}
