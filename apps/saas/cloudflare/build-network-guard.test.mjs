import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { test } from "node:test";

import { assertBuildRequest } from "./build-network-guard.mjs";

await test("isolated build permits only public font GET/HEAD and loopback traffic", () => {
	assert.doesNotThrow(() =>
		assertBuildRequest("https://fonts.googleapis.com/css2?family=Inter", "GET"),
	);
	assert.doesNotThrow(() => assertBuildRequest("https://fonts.gstatic.com/font.woff2", "HEAD"));
	assert.doesNotThrow(() => assertBuildRequest("http://127.0.0.1:8787/api/health", "GET"));
	for (const [url, method] of [
		["https://api.kie.ai/api/v1/jobs/createTask", "POST"],
		["https://api.sightengine.com/1.0/check.json", "POST"],
		["https://fonts.googleapis.com/anything", "POST"],
		["https://fonts.googleapis.com@api.kie.ai/", "GET"],
		["http://fonts.gstatic.com/font.woff2", "GET"],
	])
		assert.throws(
			() => assertBuildRequest(url, method),
			/CLOUDFLARE_BUILD_EXTERNAL_REQUEST_FORBIDDEN/,
		);
});

await test("patched Node transports validate the effective URL and options without opening a connection", () => {
	const guard = new URL("./build-network-guard.mjs", import.meta.url).href;
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
		import assert from 'node:assert/strict';
		import http from 'node:http';
		import https from 'node:https';
		let opened = 0;
		for (const transport of [http, https]) {
			for (const key of ['request', 'get']) transport[key] = () => { opened++; };
		}
		await import(${JSON.stringify(guard)});
		for (const transport of [http, https]) {
			for (const key of ['request', 'get']) {
				assert.throws(() => transport[key]('https://127.0.0.1/', {hostname: 'api.kie.ai', method: 'POST'}), /EXTERNAL_REQUEST_FORBIDDEN/);
				assert.throws(() => transport[key](new URL('https://fonts.googleapis.com/'), {hostname: 'api.sightengine.com'}), /EXTERNAL_REQUEST_FORBIDDEN/);
				assert.throws(() => transport[key]({protocol: 'https:', hostname: 'api.kie.ai', method: 'POST'}), /EXTERNAL_REQUEST_FORBIDDEN/);
			}
		}
		assert.equal(opened, 0);
		https.request('https://fonts.googleapis.com/', {method: 'HEAD'});
		http.get({hostname: '::1', port: 8787});
		assert.equal(opened, 2);
	`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
});

await test("native fetch cannot follow a permitted loopback redirect to an unchecked origin", async () => {
	let targetRequests = 0;
	const target = http.createServer((_request, response) => {
		targetRequests++;
		response.end("unexpected");
	});
	const origin = http.createServer((_request, response) => {
		response.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/` });
		response.end();
	});
	try {
		target.listen(0, "127.0.0.1");
		await once(target, "listening");
		origin.listen(0, "127.0.0.1");
		await once(origin, "listening");
		const url = `http://127.0.0.1:${origin.address().port}/`;
		await assert.rejects(fetch(url), /fetch failed/);
		await assert.rejects(fetch(new Request(url, { redirect: "follow" })), /fetch failed/);
		await assert.rejects(fetch(url, { redirect: "follow" }), /fetch failed/);
		const manual = await fetch(url, { redirect: "manual" });
		assert.equal(manual.status, 302);
		await manual.body.cancel();
		assert.equal(targetRequests, 0);
	} finally {
		origin.closeAllConnections();
		target.closeAllConnections();
		await Promise.all([
			new Promise((resolve) => origin.close(resolve)),
			new Promise((resolve) => target.close(resolve)),
		]);
	}
});
