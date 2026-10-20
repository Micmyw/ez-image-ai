/** A hidden result must not renew credentials or reload video metadata. */
export function schedulePrivatePlaybackRefresh(
	expiresAt: string | undefined,
	visible: boolean,
	refresh: () => void,
): () => void {
	if (!expiresAt || !visible) return () => {};
	const delay = Date.parse(expiresAt) - Date.now();
	if (!Number.isFinite(delay)) return () => {};
	const timer = setTimeout(refresh, Math.max(0, Math.min(delay, 2_147_483_647)));
	return () => clearTimeout(timer);
}
