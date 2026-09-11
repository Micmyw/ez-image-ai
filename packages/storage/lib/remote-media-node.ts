import { promises as dns } from "node:dns";
import * as https from "node:https";

import type { ResolvedAddress, ValidatedRemoteUrl } from "./remote-url-policy";
import type { RemoteMediaRequestOptions, RemoteStreamResponse } from "./stream-copy";

export async function resolveRemoteHostname(hostname: string): Promise<ResolvedAddress[]> {
	const records = await dns.lookup(hostname, { all: true, verbatim: true });
	return records.map((record) => ({ address: record.address, family: record.family as 4 | 6 }));
}

export function requestRemoteHttps(
	validated: ValidatedRemoteUrl,
	options?: RemoteMediaRequestOptions,
): Promise<RemoteStreamResponse> {
	return new Promise((resolve, reject) => {
		const controller = new AbortController();
		const totalTimer = setTimeout(() => controller.abort(), options?.totalTimeoutMs ?? 600_000);
		try {
			const request = https.request(
				validated.url.toString(),
				{
					method: "GET",
					lookup: validated.lookup,
					signal: controller.signal,
					timeout: options?.connectTimeoutMs ?? 5_000,
					headers: { Accept: "image/*,video/*" },
				},
				(response) => {
					const firstByteTimer = setTimeout(
						() => response.destroy(new Error("Remote media first-byte timeout")),
						options?.firstByteTimeoutMs ?? 10_000,
					);
					const clearTimers = () => {
						clearTimeout(firstByteTimer);
						clearTimeout(totalTimer);
					};
					response.once("data", () => clearTimeout(firstByteTimer));
					response.once("end", clearTimers);
					response.once("close", clearTimers);
					const headers: Record<string, string | undefined> = {};
					for (const [name, value] of Object.entries(response.headers)) {
						headers[name] = Array.isArray(value) ? value[0] : value;
					}
					resolve({ status: response.statusCode ?? 0, headers, stream: response });
				},
			);
			request.once("timeout", () => request.destroy(new Error("Remote media connection timeout")));
			request.once("error", (error) => {
				clearTimeout(totalTimer);
				reject(error);
			});
			request.end();
		} catch (error) {
			clearTimeout(totalTimer);
			reject(error);
		}
	});
}
