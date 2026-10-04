import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { urlToHttpOptions } from "node:url";

const local = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export function assertBuildRequest(target, method = "GET") {
	const url = new URL(typeof target === "string" || target instanceof URL ? target : target.url);
	if (local.has(url.hostname)) return;
	if (
		url.protocol === "https:" &&
		["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname) &&
		["GET", "HEAD"].includes(method.toUpperCase())
	)
		return;
	throw new Error("CLOUDFLARE_BUILD_EXTERNAL_REQUEST_FORBIDDEN");
}
const fetch = globalThis.fetch;
globalThis.fetch = (target, init) => {
	assertBuildRequest(target, init?.method ?? target?.method ?? "GET");
	// Native fetch follows redirects internally, outside this wrapper. Fail closed
	// rather than allow a permitted origin to redirect to an unchecked endpoint.
	const redirect = init?.redirect ?? target?.redirect;
	return fetch(target, { ...init, redirect: redirect === "manual" ? "manual" : "error" });
};
for (const transport of [http, https]) {
	for (const key of ["request", "get"]) {
		const original = transport[key];
		transport[key] = function (target, ...args) {
			const options =
				typeof target === "string" || target instanceof URL
					? {
							...urlToHttpOptions(new URL(target)),
							...(typeof args[0] === "object" && args[0] !== null ? args[0] : {}),
						}
					: (target ?? {});
			const hostname = options.hostname || options.host || "localhost";
			// Node accepts unbracketed IPv6 in options and ignores URL href after
			// merging options. Validate the effective endpoint, never that stale href.
			const authority =
				hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
			assertBuildRequest(
				`${options.protocol ?? (transport === https ? "https:" : "http:")}//${authority}${options.port ? `:${options.port}` : ""}/`,
				options.method ?? "GET",
			);
			return original.call(this, target, ...args);
		};
	}
}
syncBuiltinESMExports();
