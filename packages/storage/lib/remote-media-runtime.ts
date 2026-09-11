import { AsyncLocalStorage } from "node:async_hooks";

import type { ResolvedAddress, ValidatedRemoteUrl } from "./remote-url-policy";
import type { RemoteMediaRequestOptions, RemoteStreamResponse } from "./stream-copy";

export interface RemoteMediaTransport {
	exactHostsOnly: boolean;
	resolve: (hostname: string) => Promise<ResolvedAddress[]>;
	request: (
		input: ValidatedRemoteUrl,
		options: RemoteMediaRequestOptions,
	) => Promise<RemoteStreamResponse>;
}

// Next server chunks and the Worker entrypoint must use the same request scope.
const contextKey = Symbol.for("ezpic.remote-media-transport-context");
const contexts = globalThis as typeof globalThis & {
	[contextKey]?: AsyncLocalStorage<RemoteMediaTransport>;
};
const context = (contexts[contextKey] ??= new AsyncLocalStorage<RemoteMediaTransport>());

export function currentRemoteMediaTransport(): RemoteMediaTransport | undefined {
	return context.getStore();
}

export function runWithRemoteMediaTransport<T>(
	transport: RemoteMediaTransport,
	operation: () => T,
): T {
	return context.run(transport, operation);
}
