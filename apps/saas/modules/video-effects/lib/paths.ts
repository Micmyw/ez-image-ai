/** Shared navigation must not load the template's draft validation or execution contract. */
export const VIDEO_EFFECT_PATH = "/video-effects/hotel-lobby-ai";
export const RAINDANCE_PATH = "/blog/raindance-ai-trend";
export const RUMPELSTILTSKIN_PATH = "/video/effects/rumpelstiltskin";
export function videoEffectPath(effectId: string): string {
	if (effectId === "rumpelstiltskin-solo") return RUMPELSTILTSKIN_PATH;
	return effectId === "raindance-solo" || effectId === "raindance-duo"
		? RAINDANCE_PATH
		: VIDEO_EFFECT_PATH;
}
export function isVideoEffectPath(path: string): boolean {
	return path === VIDEO_EFFECT_PATH || path === RAINDANCE_PATH;
}
/** Checkout return state includes only the public template and explicit Raindance mode. */
export function videoEffectReturnPath(effectId: string): string {
	const path = videoEffectPath(effectId);
	return path === RAINDANCE_PATH
		? `${path}?mode=${effectId === "raindance-duo" ? "duo" : "solo"}`
		: path;
}
export function sanitizeVideoEffectReturnPath(value: string | null | undefined): string | null {
	if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
	try {
		const url = new URL(value, "https://video-effect-return.invalid");
		if (url.origin !== "https://video-effect-return.invalid" || url.hash) return null;
		if (isVideoEffectPath(url.pathname) && !url.search) return url.pathname;
		const mode = url.searchParams.get("mode");
		return url.pathname === RAINDANCE_PATH &&
			url.searchParams.size === 1 &&
			(mode === "solo" || mode === "duo")
			? `${RAINDANCE_PATH}?mode=${mode}`
			: null;
	} catch {
		return null;
	}
}
export function videoEffectJobPath(effectId: string, jobId: string): string {
	return `${videoEffectPath(effectId)}?job=${encodeURIComponent(jobId)}${effectId === "raindance-duo" ? "&mode=duo" : ""}`;
}
