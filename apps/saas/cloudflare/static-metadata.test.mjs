import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { prerenderedMetadata, workerFirstMetadataPaths } from "./public-metadata-paths.mjs";
import { stageStaticMetadata } from "./static-metadata.mjs";

const app = new URL("../", import.meta.url);
const origin = "https://metadata.example.test";
const entries = {
	"/sitemap.xml":
		'<?xml version="1.0"?><urlset><url><loc>' +
		origin +
		'/</loc><xhtml:link rel="alternate" hreflang="de" href="' +
		origin +
		'/?lang=de" /></url></urlset>',
	"/sitemap-images.xml":
		'<?xml version="1.0"?><urlset><url><loc>' +
		origin +
		"/</loc><image:image><image:loc>" +
		origin +
		"/images/published.png</image:loc></image:image></url></urlset>",
	"/robots.txt": `User-Agent: *\nSitemap: ${origin}/sitemap.xml\nSitemap: ${origin}/sitemap-images.xml\n`,
	"/icon.png": Buffer.from("89504e470d0a1a0a0000000d494844520000020000000200", "hex"),
};

async function withBuild(verify) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ezpic-static-metadata-"));
	const source = path.join(directory, ".next/server/app");
	const assets = path.join(directory, ".open-next/assets");
	const manifestFile = path.join(directory, ".next/prerender-manifest.json");
	try {
		await Promise.all([mkdir(source, { recursive: true }), mkdir(assets, { recursive: true })]);
		const routes = Object.fromEntries(
			Object.entries(prerenderedMetadata).map(([pathname, contentType]) => [
				pathname,
				{
					routeType: "route",
					compute: "static",
					response: "complete",
					initialRevalidateSeconds: false,
					srcRoute: pathname,
					dataRoute: null,
					initialHeaders: { "content-type": contentType },
				},
			]),
		);
		const manifest = { version: 4, routes };
		const writeManifest = () => writeFile(manifestFile, JSON.stringify(manifest));
		await writeManifest();
		for (const [pathname, body] of Object.entries(entries)) {
			const filename = path.join(source, pathname.slice(1));
			await writeFile(`${filename}.body`, body);
			await writeFile(
				`${filename}.meta`,
				JSON.stringify({ status: 200, headers: manifest.routes[pathname].initialHeaders }),
			);
		}
		await verify({ directory, source, assets, manifest, writeManifest });
	} finally {
		assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
		assert.ok(path.basename(directory).startsWith("ezpic-static-metadata-"));
		await rm(directory, { recursive: true, force: true });
	}
}

await test("ships only the exact metadata filenames through the website Worker", async () => {
	assert.deepEqual(Object.keys(prerenderedMetadata), [
		"/sitemap.xml",
		"/sitemap-images.xml",
		"/robots.txt",
		"/icon.png",
	]);
	const wrangler = JSON.parse(await readFile(new URL("wrangler.jsonc", app), "utf8"));
	assert.deepEqual(wrangler.assets.run_worker_first, workerFirstMetadataPaths);
});

await test("stages byte-identical metadata from the current build and keeps identical assets", async () => {
	await withBuild(async ({ directory, source, assets }) => {
		await writeFile(path.join(source, "unlisted.body"), "never stage this");
		await writeFile(path.join(assets, "icon.png"), entries["/icon.png"]);
		await stageStaticMetadata(directory, origin);
		await stageStaticMetadata(directory);
		assert.deepEqual(
			await readdir(assets),
			Object.keys(entries)
				.map((name) => name.slice(1))
				.sort(),
		);
		for (const [pathname, body] of Object.entries(entries)) {
			assert.deepEqual(await readFile(path.join(assets, pathname.slice(1))), Buffer.from(body));
		}
	});
});

await test("fails without writing files when a source body or response record is missing", async () => {
	for (const extension of ["body", "meta"]) {
		await withBuild(async ({ directory, source, assets }) => {
			await rm(path.join(source, `sitemap-images.xml.${extension}`));
			await assert.rejects(stageStaticMetadata(directory, origin), {
				code: "ENOENT",
				path: path.join(source, `sitemap-images.xml.${extension}`),
			});
			assert.deepEqual(await readdir(assets), []);
		});
	}
});

await test("requires every allowed route to have a complete static manifest entry", async () => {
	for (const fields of [
		{ compute: "dynamic" },
		{ response: "partial" },
		{ initialRevalidateSeconds: 60 },
		{ srcRoute: "/[organizationSlug]" },
	]) {
		await withBuild(async ({ directory, assets, manifest, writeManifest }) => {
			Object.assign(manifest.routes["/robots.txt"], fields);
			await writeManifest();
			await assert.rejects(stageStaticMetadata(directory, origin), {
				message: "STATIC_METADATA_ROUTE_NOT_PRERENDERED: /robots.txt",
			});
			assert.deepEqual(await readdir(assets), []);
		});
	}
});

await test("rejects a response that sets a cookie", async () => {
	await withBuild(async ({ directory, source, assets }) => {
		await writeFile(
			path.join(source, "robots.txt.meta"),
			JSON.stringify({
				status: 200,
				headers: { "content-type": "text/plain", "set-cookie": "private=fixture" },
			}),
		);
		await assert.rejects(stageStaticMetadata(directory, origin), {
			message: "STATIC_METADATA_RESPONSE_INVALID: /robots.txt",
		});
		assert.deepEqual(await readdir(assets), []);
	});
});

await test("refuses to overwrite a different staged file", async () => {
	await withBuild(async ({ directory, assets }) => {
		const target = path.join(assets, "icon.png");
		await writeFile(target, "stale icon");
		await assert.rejects(stageStaticMetadata(directory, origin), {
			message: "STATIC_METADATA_ASSET_CONFLICT: /icon.png",
		});
		assert.deepEqual(await readdir(assets), ["icon.png"]);
		assert.equal(await readFile(target, "utf8"), "stale icon");
	});
});

await test("rejects a stale build origin in alternate links, image locations and robots references", async () => {
	for (const [pathname, suffix] of [
		["/sitemap.xml", "/?lang=de"],
		["/sitemap-images.xml", "/images/published.png"],
		["/robots.txt", "/sitemap-images.xml"],
	]) {
		await withBuild(async ({ directory, source, assets }) => {
			await writeFile(
				path.join(source, `${pathname.slice(1)}.body`),
				entries[pathname].replace(`${origin}${suffix}`, `https://elsewhere.test${suffix}`),
			);
			await assert.rejects(
				stageStaticMetadata(directory, origin),
				/STATIC_METADATA_(ORIGIN_MISMATCH|SITEMAP_REFERENCES_INVALID)/,
			);
			assert.deepEqual(await readdir(assets), []);
		});
	}
});
