const LOAD_PATH_SENTINEL_ORIGIN = "https://ezpic-load-target.invalid";

/**
 * Keeps every configurable scenario path on the already allowlisted base origin.
 * @param {unknown} value
 * @returns {string}
 */
export function safeEzPicLoadPath(value) {
	if (typeof value !== "string") {
		throw new Error("Load paths must be normalized origin-relative path-only values");
	}
	const path = value;
	let containsControlCharacter = false;
	for (let index = 0; index < path.length; index += 1) {
		const codeUnit = path.charCodeAt(index);
		if (codeUnit <= 31 || codeUnit === 127) {
			containsControlCharacter = true;
			break;
		}
	}
	if (
		!path.startsWith("/") ||
		path.startsWith("//") ||
		path.includes("?") ||
		path.includes("#") ||
		path.includes("\\") ||
		containsControlCharacter ||
		/%(?:2f|5c)/i.test(path)
	) {
		throw new Error("Load paths must be normalized origin-relative path-only values");
	}

	let resolved;
	try {
		resolved = new URL(path, LOAD_PATH_SENTINEL_ORIGIN);
	} catch {
		throw new Error("Load paths must be normalized origin-relative path-only values");
	}
	if (
		resolved.origin !== LOAD_PATH_SENTINEL_ORIGIN ||
		resolved.pathname !== path ||
		resolved.search ||
		resolved.hash
	) {
		throw new Error("Load paths must be normalized origin-relative path-only values");
	}
	return path;
}

/**
 * Prevents a local synthetic route from being represented as Provider invocation evidence.
 * Remote has already passed the allowlist, origin confirmations, and staging identity gates.
 * @param {boolean} providerCallsEnabled
 * @param {boolean} remote
 */
export function assertEzPicProviderLoadTarget(providerCallsEnabled, remote) {
	if (providerCallsEnabled && !remote) {
		throw new Error("Provider calls require an explicitly confirmed remote staging target");
	}
}
