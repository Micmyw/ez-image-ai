// Loaded in every test subprocess. Real provider traffic is never part of this runner.
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const local = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const assertLocal = (target, method = "GET") => {
	const url = new URL(typeof target === "string" || target instanceof URL ? target : target.url);
	// Build/browser verification may download public font assets only. Provider,
	// moderation and other remote traffic remain blocked, including POST to fonts.
	if (
		process.env.VIDEO_TEST_ALLOW_FONT_DOWNLOADS === "true" &&
		url.protocol === "https:" &&
		["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname) &&
		["GET", "HEAD"].includes(method.toUpperCase())
	)
		return;
	if (!local.has(url.hostname)) throw new Error("VIDEO_TEST_EXTERNAL_NETWORK_FORBIDDEN");
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (target, init) => {
	assertLocal(target, init?.method ?? target?.method ?? "GET");
	return originalFetch(target, init);
};
for (const transport of [http, https]) {
	for (const key of ["request", "get"]) {
		const original = transport[key];
		transport[key] = function (target, ...args) {
			if (typeof target === "string" || target instanceof URL)
				assertLocal(target, args[0]?.method ?? "GET");
			else
				assertLocal(
					new URL(
						`${target.protocol ?? (transport === https ? "https:" : "http:")}//${target.hostname ?? target.host ?? "localhost"}${target.port ? `:${target.port}` : ""}${target.path ?? "/"}`,
					),
					target.method ?? "GET",
				);
			return original.call(this, target, ...args);
		};
	}
}
syncBuiltinESMExports();
