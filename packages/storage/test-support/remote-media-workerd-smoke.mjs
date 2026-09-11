import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.join(root, ".wrangler/remote-media-smoke");
const wranglerRequire = createRequire(
	realpathSync(path.join(root, "apps/workflows/node_modules/wrangler/package.json")),
);
const { build } = wranglerRequire("esbuild");
const miniflareRequire = createRequire(wranglerRequire.resolve("miniflare"));
const workerd = miniflareRequire("workerd");
await mkdir(output, { recursive: true });

const entry = `
import { runWithCloudflareRemoteMedia } from ${JSON.stringify(path.join(root, "packages/storage/lib/cloudflare-remote-media.ts"))};
import { requestRemoteMediaStream, copyRemoteStreamToMultipart } from ${JSON.stringify(path.join(root, "packages/storage/lib/stream-copy.ts"))};
const settings = {
  allowedHosts: ['cdn.provider.test', 'files.provider.test', 'private.provider.test', 'localhost'],
  maxRedirects: 2, connectTimeoutMs: 1000, totalTimeoutMs: 3000,
};
export default { async fetch(request) {
  const mode = new URL(request.url).pathname.slice(1);
  try {
    if (mode === 'private-network') {
      const addresses = ['127.0.0.1', '10.0.0.1', '169.254.169.254', '[::1]', '[fd00::1]', '[::ffff:127.0.0.1]'];
      const results = [];
      for (const address of addresses) {
        try {
          await fetch('https://' + address, { signal: AbortSignal.timeout(1000), redirect: 'manual' });
          results.push({ address, blocked: false });
        } catch (error) { results.push({ address, blocked: true, message: error.message }); }
      }
      return Response.json(results);
    }
    const operation = async () => {
      const response = await requestRemoteMediaStream(
        mode === 'dns-rebinding' ? 'https://localhost/media.png' : 'https://cdn.provider.test/' + mode,
        mode === 'dns-rebinding' || mode === 'no-scope'
          ? { ...settings, resolve: async () => [{ address: '8.8.8.8', family: 4 }] }
          : settings,
      );
      const parts = [];
      let aborted = false;
      try {
        const result = await copyRemoteStreamToMultipart(response.stream, {
          maxBytes: mode === 'byte-cap' ? 8 : 64, partSize: 5,
          uploadPart: async ({ body }) => { parts.push([...body]); return 'etag-' + parts.length; },
          complete: async () => {}, abort: async () => { aborted = true; },
        });
        return Response.json({ bytes: result.bytes, sha256: result.sha256, parts, url: response.url.toString() });
      } catch (error) { return Response.json({ error: error.message, code: error.code, aborted, parts }); }
    };
    return mode === 'no-scope' ? await operation() : await runWithCloudflareRemoteMedia(operation);
  } catch (error) { return Response.json({ error: error.message, code: error.code }); }
} };
`;

const built = await build({
	stdin: {
		contents: entry,
		resolveDir: root,
		sourcefile: "remote-media-smoke-entry.ts",
		loader: "ts",
	},
	bundle: true,
	format: "esm",
	platform: "neutral",
	conditions: ["workerd"],
	mainFields: ["module", "main"],
	external: ["node:*"],
	write: false,
	metafile: true,
});
assert(!Object.keys(built.metafile.inputs).some((file) => file.endsWith("/remote-media-node.ts")));
assert(!/from ["']node:(dns|https)["']/.test(built.outputFiles[0].text));
await writeFile(path.join(output, "worker.mjs"), built.outputFiles[0].text);
await writeFile(
	path.join(output, "fixture.mjs"),
	`
export default { async fetch(request) {
  const url = new URL(request.url);
  if (url.hostname === 'cloudflare-dns.com') {
    const host = url.searchParams.get('name');
    const type = url.searchParams.get('type');
    return Response.json({ Status: 0, Answer: type === 'AAAA' ? [] : [{
      type: 1, data: host === 'private.provider.test' ? '127.0.0.1' : '8.8.8.8',
    }] });
  }
  if (url.pathname === '/redirect') return new Response('discard redirect body', {
    status: 302, headers: { Location: 'https://files.provider.test/final' },
  });
  if (url.pathname === '/private-redirect') return new Response('discard redirect body', {
    status: 302, headers: { Location: 'https://private.provider.test/final' },
  });
  return new Response(new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]), {
    headers: { 'Content-Type': 'image/png' },
  });
} };`,
);
await writeFile(
	path.join(output, "smoke.capnp"),
	`
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "strict", worker = (
      compatibilityDate = "2026-09-08", compatibilityFlags = ["nodejs_compat", "global_fetch_strictly_public"],
      modules = [(name = "worker.mjs", esModule = embed "worker.mjs")]
    )),
    (name = "mocked-provider", worker = (
      compatibilityDate = "2026-09-08", compatibilityFlags = ["nodejs_compat", "global_fetch_strictly_public"],
      globalOutbound = "fixture", modules = [(name = "worker.mjs", esModule = embed "worker.mjs")]
    )),
    (name = "fixture", worker = (
      compatibilityDate = "2026-09-08", modules = [(name = "fixture.mjs", esModule = embed "fixture.mjs")]
    ))
  ],
  sockets = [
    (name = "strict", address = "127.0.0.1:0", http = (), service = "strict"),
    (name = "mocked-provider", address = "127.0.0.1:0", http = (), service = "mocked-provider")
  ]
);`,
);

const runtime = spawn(
	workerd.default,
	["serve", "--control-fd=3", path.join(output, "smoke.capnp")],
	{
		cwd: root,
		stdio: ["ignore", "pipe", "pipe", "pipe"],
		windowsHide: true,
	},
);
const runtimeClosed = once(runtime, "close");
process.stdout.write(`Remote media smoke process ${process.pid}, workerd ${runtime.pid}\n`);
let logs = "";
runtime.stderr.on("data", (chunk) => {
	logs += chunk.toString();
});
const sockets = new Map();
try {
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("workerd startup timeout: " + logs)), 10_000);
		runtime.once("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error("workerd exited: " + code + " " + logs));
		});
		runtime.once("error", reject);
		let data = "";
		runtime.stdio[3].on("data", (chunk) => {
			data += chunk.toString();
			while (data.includes("\n")) {
				const end = data.indexOf("\n");
				const event = JSON.parse(data.slice(0, end));
				data = data.slice(end + 1);
				if (event.event === "listen") sockets.set(event.socket, event.port);
			}
			if (sockets.size === 2) {
				clearTimeout(timeout);
				resolve();
			}
		});
	});
	const read = async (service, mode) => {
		const response = await fetch(`http://127.0.0.1:${sockets.get(service)}/${mode}`, {
			signal: AbortSignal.timeout(10_000),
		});
		assert.equal(response.status, 200);
		return response.json();
	};
	const stream = await read("mocked-provider", "stream");
	assert.equal(stream.bytes, 16, JSON.stringify(stream));
	assert.equal(stream.parts.length, 4);
	const redirect = await read("mocked-provider", "redirect");
	assert.equal(redirect.url, "https://files.provider.test/final");
	assert.equal(redirect.bytes, 16);
	const privateRedirect = await read("mocked-provider", "private-redirect");
	assert.equal(privateRedirect.code, "OUTPUT_REMOTE_URL_PRIVATE_ADDRESS");
	const capped = await read("mocked-provider", "byte-cap");
	assert.equal(capped.code, "OUTPUT_MEDIA_SIZE_EXCEEDED");
	assert.equal(capped.aborted, true);
	assert.deepEqual(capped.parts, []);
	const noScope = await read("strict", "no-scope");
	assert.match(noScope.error, /missing from the request scope/);
	const privateNetwork = await read("strict", "private-network");
	const assertNetworkDenied = (message) => {
		const reference = message.match(/reference = (\S+)/)?.[1];
		if (reference) {
			const lines = logs.split("\n");
			const errorLine = lines.findIndex((line) => line.includes("wdErrId = " + reference));
			assert(errorLine > 0, "Missing workerd network-denial evidence for " + reference);
			assert.match(
				lines[errorLine - 1],
				/blocked by restrictPeers|restricted|not allowed|disallowed/i,
			);
		} else {
			assert.match(message, /restricted|not allowed|permission|private|disallowed/i);
		}
	};
	for (const result of privateNetwork) {
		assert.equal(result.blocked, true, result.address);
		assertNetworkDenied(result.message);
	}
	const rebinding = await read("strict", "dns-rebinding");
	assertNetworkDenied(rebinding.error);
	process.stdout.write(
		JSON.stringify(
			{
				workerd: workerd.version,
				nodeTransportExcluded: true,
				streamedBytes: stream.bytes,
				redirectRevalidated: true,
				byteCapAborted: true,
				missingScopeRejected: true,
				privateNetwork,
				publicPreflightPrivateConnection: rebinding,
				externalProviderCalls: 0,
			},
			null,
			2,
		) + "\n",
	);
} finally {
	if (runtime.exitCode === null && runtime.signalCode === null) {
		runtime.kill();
	}
	await runtimeClosed;
	assert(runtime.exitCode !== null || runtime.signalCode !== null, "workerd did not exit");
	process.stdout.write(`workerd ${runtime.pid} exited\n`);
}
