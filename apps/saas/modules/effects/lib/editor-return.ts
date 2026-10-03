export const EFFECT_EDITOR_RETURN_COOKIE = "media_effect_return";

export function readEffectEditorReturnCookie(header: string | null): string | null {
	try {
		const entry = header
			?.split(";")
			.find((value) => value.trim().startsWith(`${EFFECT_EDITOR_RETURN_COOKIE}=`));
		return entry
			? decodeURIComponent(entry.trim().slice(EFFECT_EDITOR_RETURN_COOKIE.length + 1))
			: null;
	} catch {
		return null;
	}
}
