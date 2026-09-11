import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { runWithRemoteMediaTransport, type RemoteMediaTransport } from "./remote-media-runtime";
import type { ResolvedAddress, ValidatedRemoteUrl } from "./remote-url-policy";
import type { RemoteMediaRequestOptions, RemoteStreamResponse } from "./stream-copy";

// Capture the native public-Internet capability before framework fetch wrappers.
// Never replace this with a VPC or service-binding fetch implementation. Deploy
// with global_fetch_strictly_public: the platform rejects private destinations
// at connection time even if DNS changes after the application preflight.
const publicInternetFetch = globalThis.fetch.bind(globalThis);

const transport: RemoteMediaTransport = {
	exactHostsOnly: true,
	resolve: resolveCloudflareRemoteHostname,
	request: requestCloudflareRemoteHttps,
};

export function runWithCloudflareRemoteMedia<T>(operation: () => T): T {
	const navigator = (globalThis as { navigator?: { userAgent?: string } }).navigator;
	if (navigator?.userAgent !== "Cloudflare-Workers") {
		throw new Error("Public Internet media transport requires the Cloudflare Workers runtime");
	}
	return runWithRemoteMediaTransport(transport, operation);
}

async function resolveCloudflareRemoteHostname(hostname: string): Promise<ResolvedAddress[]> {
	const results = await Promise.all([
		resolveFamily(hostname, "A", 1, 4),
		resolveFamily(hostname, "AAAA", 28, 6),
	]);
	return results.flat();
}

async function resolveFamily(
	hostname: string,
	type: "A" | "AAAA",
	recordType: 1 | 28,
	family: 4 | 6,
): Promise<ResolvedAddress[]> {
	const url = new URL("https://cloudflare-dns.com/dns-query");
	url.searchParams.set("name", hostname);
	url.searchParams.set("type", type);
	const response = await publicInternetFetch(url.toString(), {
		headers: { Accept: "application/dns-json" },
		redirect: "manual",
		signal: AbortSignal.timeout(5_000),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error("Remote media DNS resolver request failed");
	}
	const data: unknown = await response.json();
	if (!isRecord(data) || data.Status !== 0) throw new Error("Remote media DNS lookup failed");
	if (data.Answer === undefined) return [];
	if (!Array.isArray(data.Answer)) throw new Error("Remote media DNS answer is malformed");
	const addresses: ResolvedAddress[] = [];
	for (const record of data.Answer) {
		if (!isRecord(record)) throw new Error("Remote media DNS answer is malformed");
		if (record.type !== recordType) continue;
		if (typeof record.data !== "string") throw new Error("Remote media DNS address is malformed");
		addresses.push({ address: record.data, family });
	}
	return addresses;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestCloudflareRemoteHttps(
	validated: ValidatedRemoteUrl,
	options: RemoteMediaRequestOptions,
): Promise<RemoteStreamResponse> {
	const controller = new AbortController();
	let stream: Readable | undefined;
	let firstByteTimer: ReturnType<typeof setTimeout> | undefined;
	const fail = (message: string) => {
		const error = new Error(message);
		controller.abort(error);
		stream?.destroy(error);
	};
	const totalTimer = setTimeout(
		() => fail("Remote media total timeout"),
		options.totalTimeoutMs ?? 600_000,
	);
	// Fetch does not expose the TCP handshake. Bound the stricter interval from
	// connection start through headers instead, then separately bound first byte.
	const connectionTimer = setTimeout(
		() => fail("Remote media connection timeout"),
		options.connectTimeoutMs ?? 5_000,
	);
	const cleanup = () => {
		clearTimeout(totalTimer);
		clearTimeout(connectionTimer);
		clearTimeout(firstByteTimer);
		controller.abort();
	};
	try {
		const response = await publicInternetFetch(validated.url.toString(), {
			method: "GET",
			redirect: "manual",
			headers: { Accept: "image/*,video/*", "Accept-Encoding": "identity" },
			signal: controller.signal,
		});
		clearTimeout(connectionTimer);
		stream = response.body
			? Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>)
			: Readable.from([]);
		firstByteTimer = setTimeout(
			() => fail("Remote media first-byte timeout"),
			options.firstByteTimeoutMs ?? 10_000,
		);
		// 'readable' starts bounded buffering without flowing past the consumer.
		stream.once("readable", () => clearTimeout(firstByteTimer));
		stream.once("end", cleanup);
		stream.once("close", cleanup);
		stream.once("error", cleanup);
		return {
			status: response.status,
			headers: Object.fromEntries(response.headers.entries()),
			stream,
		};
	} catch (error) {
		cleanup();
		throw error;
	}
}
