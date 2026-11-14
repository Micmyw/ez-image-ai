import { getSafeRedirectPath } from "@shared/lib/redirect";

export function authErrorReturnPath(redirectPath: string, invitationId?: string | null): string {
	const query = new URLSearchParams({
		redirectTo: getSafeRedirectPath(redirectPath, "/create"),
		authError: "cancelled",
	});
	if (invitationId) query.set("invitationId", invitationId);
	return `/login?${query.toString()}`;
}

/** Dismissing the optional prompt must never prevent the ordinary Google/email controls. */
export function cancelGoogleOneTap(): void {
	if (typeof window === "undefined") return;
	const google = (window as unknown as { google?: { accounts?: { id?: { cancel?: () => void } } } })
		.google;
	try {
		google?.accounts?.id?.cancel?.();
	} catch {
		/* Optional browser capability. */
	}
}
