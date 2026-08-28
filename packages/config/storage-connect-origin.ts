interface StorageConnectOriginOptions {
	allowLoopbackHttp: boolean;
}

export function resolveStorageConnectOrigin(
	value: string | undefined,
	options: StorageConnectOriginOptions,
): string | null {
	if (!value) return null;

	try {
		const url = new URL(value);
		if (url.username || url.password) return null;
		if (url.protocol === "https:") return url.origin;
		if (options.allowLoopbackHttp && url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
			return url.origin;
		}
		return null;
	} catch {
		return null;
	}
}

function isLoopbackHostname(hostname: string): boolean {
	const normalizedHostname = hostname.toLowerCase();
	return (
		normalizedHostname === "localhost" ||
		normalizedHostname.endsWith(".localhost") ||
		normalizedHostname === "[::1]" ||
		/^127(?:\.\d{1,3}){3}$/.test(normalizedHostname)
	);
}
