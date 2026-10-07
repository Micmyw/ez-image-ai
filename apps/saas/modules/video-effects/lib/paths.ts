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
export function videoEffectJobPath(effectId: string, jobId: string): string {
	return `${videoEffectPath(effectId)}?job=${encodeURIComponent(jobId)}${effectId === "raindance-duo" ? "&mode=duo" : ""}`;
}
