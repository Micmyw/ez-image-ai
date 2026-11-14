export const AUTH_DRAFT_POINTER_KEY = "ezpic.auth-draft.v1";

/** A presence hint only; the full draft reader validates identity, ownership and expiry. */
export function hasAuthDraftPointer(): boolean {
	try {
		return Boolean(window.sessionStorage.getItem(AUTH_DRAFT_POINTER_KEY));
	} catch {
		return false;
	}
}
