import { parseJSON } from "better-auth/client";

import type { Session } from ".";

/** Public headers only read a session; account-management plugins load on their own screens. */
export async function readSession(): Promise<Session | null> {
	const response = await fetch("/api/auth/get-session?disableCookieCache=true", {
		credentials: "include",
		cache: "no-store",
	});
	// Keep Better Auth's date parsing and secure JSON reviver, including for account fields.
	const data: unknown = parseJSON(await response.text(), { strict: false });
	if (!response.ok)
		throw new Error(
			data && typeof data === "object" && "message" in data && typeof data.message === "string"
				? data.message
				: "Failed to fetch session",
		);
	if (data === null) return null;
	if (
		!data ||
		typeof data !== "object" ||
		!("user" in data) ||
		!("session" in data) ||
		!data.user ||
		!data.session
	)
		throw new Error("Failed to fetch session");
	return data as Session;
}
