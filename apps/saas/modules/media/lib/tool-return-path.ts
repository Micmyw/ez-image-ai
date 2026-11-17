export const GTA_IMAGE_TOOL_PATHS = ["/gta-6-wallpaper", "/gta-loading-screen-generator"] as const;

export const PUBLIC_IMAGE_TOOL_PATHS = ["/christmas-wallpaper", ...GTA_IMAGE_TOOL_PATHS] as const;

export type PublicImageToolPath = (typeof PUBLIC_IMAGE_TOOL_PATHS)[number];

export function isGtaToolPath(value: string | null | undefined): value is PublicImageToolPath {
	return value === "/gta-6-wallpaper" || value === "/gta-loading-screen-generator";
}

/** Only registered tool routes and bounded recovery flags may leave the editor. */
export function sanitizeToolReturnPath(value: unknown): string | null {
	if (typeof value !== "string" || !value.startsWith("/") || value.includes("\\")) return null;
	let url: URL;
	try {
		url = new URL(value, "https://tool-return.invalid");
	} catch {
		return null;
	}
	if (
		url.origin !== "https://tool-return.invalid" ||
		url.hash ||
		!PUBLIC_IMAGE_TOOL_PATHS.includes(url.pathname as PublicImageToolPath)
	)
		return null;
	if ([...url.searchParams.keys()].some((key) => !["upgrade", "resume"].includes(key))) return null;
	if (["upgrade", "resume"].some((key) => url.searchParams.getAll(key).length > 1)) return null;
	if (url.searchParams.has("upgrade") && url.searchParams.get("upgrade") !== "complete")
		return null;
	if (url.searchParams.has("resume") && url.searchParams.get("resume") !== "text") return null;
	if (url.searchParams.has("upgrade") && url.searchParams.has("resume")) return null;
	return url.pathname + url.search;
}
