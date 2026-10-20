import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(
	realpathSync(path.join(root, "apps/workflows/node_modules/wrangler/package.json")),
);
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

// These are synthetic bindings. No production configuration or outbound traffic is used.
const bindings = {
	ADMIN_BOT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
	ADMIN_BOT_ALLOWED_HOSTS: "notify.example.test",
};
const script = `
import process from "node:process";
import { DurableObject } from "cloudflare:workers";
const keys = ["ADMIN_BOT_ENCRYPTION_KEY", "ADMIN_BOT_ALLOWED_HOSTS"];
function inspect(env) {
	return {
		allConfigured: keys.every(key => typeof env[key] === "string" && env[key].length > 0),
		processMatchesBindings: keys.every(key => process.env[key] === env[key]),
		noPublicAliases: keys.every(key => process.env["NEXT_PUBLIC_" + key] === undefined),
	};
}
export class BotBindingsProbe extends DurableObject {
	fetch() { return Response.json(inspect(this.env)); }
}
export default {
	fetch(_request, env) { return Response.json(inspect(env)); }
};
`;

for (const configPath of [
	"apps/saas/wrangler.jsonc",
	"apps/workflows/wrangler.workers.jsonc",
	"apps/workflows/wrangler.jsonc",
]) {
	await test(
		`${configPath} injects private bot bindings before HTTP and Durable Object consumers`,
		{ timeout: 30_000 },
		async () => {
			const config = JSON.parse(readFileSync(path.join(root, configPath), "utf8"));
			const runtime = new Miniflare(
				convertV4MiniflareOptions({
					host: "127.0.0.1",
					port: 0,
					modules: true,
					script,
					compatibilityDate: config.compatibility_date,
					compatibilityFlags: config.compatibility_flags,
					bindings,
					durableObjects: { PROBE: { className: "BotBindingsProbe", useSQLite: true } },
					outboundService: () => new Response("External network forbidden", { status: 502 }),
				}),
			);
			const expected = {
				allConfigured: true,
				processMatchesBindings: true,
				noPublicAliases: true,
			};
			try {
				// First access is a Durable Object invocation, with no OpenNext/website hydration.
				const objects = await runtime.getDurableObjectNamespace("PROBE");
				const durableResponse = await objects
					.get(objects.idFromName("bot-environment"))
					.fetch("https://probe.test/");
				assert.deepEqual(await durableResponse.json(), expected);
				const httpResponse = await runtime.dispatchFetch("https://probe.test/");
				assert.deepEqual(await httpResponse.json(), expected);
			} finally {
				await runtime.dispose();
			}
		},
	);
}
