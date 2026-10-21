/** Receives only a sanitized first-touch snapshot. */
export function acquisitionSource(
	value: { utmSource: string | null; referrerOrigin: string | null; source: string } | null,
): string | null {
	if (value?.utmSource) return value.utmSource.toLowerCase();
	if (value?.referrerOrigin) return new URL(value.referrerOrigin).hostname.replace(/^www\./, "");
	return value?.source === "direct" ? "direct" : null;
}

export function analyticsDevice(agent: string): "tablet" | "mobile" | "desktop" | "unknown" {
	return /ipad|tablet/i.test(agent)
		? "tablet"
		: /mobi|android/i.test(agent)
			? "mobile"
			: agent
				? "desktop"
				: "unknown";
}
