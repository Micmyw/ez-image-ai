const INTERNAL_REDIRECT_ORIGIN = "https://saas.invalid";

export function getSafeRedirectPath(redirectTo: string | null | undefined, fallback = "/"): string {
	return normalizeInternalPath(redirectTo) ?? normalizeInternalPath(fallback) ?? "/";
}

function normalizeInternalPath(path: string | null | undefined): string | null {
	if (!path?.startsWith("/")) {
		return null;
	}

	try {
		const url = new URL(path, INTERNAL_REDIRECT_ORIGIN);
		const normalizedPath = `${url.pathname}${url.search}${url.hash}`;

		if (url.origin !== INTERNAL_REDIRECT_ORIGIN || normalizedPath.startsWith("//")) {
			return null;
		}

		return normalizedPath;
	} catch {
		return null;
	}
}
