import type { ResolvedAddress, ValidatedRemoteUrl } from "./remote-url-policy";
import type { RemoteMediaRequestOptions, RemoteStreamResponse } from "./stream-copy";

function unavailable(): never {
	throw new Error("Cloudflare remote media transport is missing from the request scope");
}

export function resolveRemoteHostname(_hostname: string): Promise<ResolvedAddress[]> {
	return unavailable();
}

export function requestRemoteHttps(
	_validated: ValidatedRemoteUrl,
	_options?: RemoteMediaRequestOptions,
): Promise<RemoteStreamResponse> {
	return unavailable();
}
