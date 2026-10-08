import { RAINDANCE_PATH } from "./paths";

/** A restored preference must become URL state so every sign-in entry sees the same mode. */
export function restoredRaindanceDuetPath(href: string, savedMode: string | null): string | null {
	const url = new URL(href);
	if (
		savedMode !== "duo" ||
		url.pathname !== RAINDANCE_PATH ||
		url.searchParams.has("mode") ||
		url.searchParams.has("job")
	)
		return null;
	url.searchParams.set("mode", "duo");
	return `${url.pathname}${url.search}${url.hash}`;
}
