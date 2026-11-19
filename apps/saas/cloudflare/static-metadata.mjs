import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { prerenderedMetadata } from "./public-metadata-paths.mjs";

const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
const sitemapPaths = ["/sitemap.xml", "/sitemap-images.xml"];

export async function stageStaticMetadata(appDirectory, canonicalOrigin) {
	const next = path.join(appDirectory, ".next");
	const assets = path.join(appDirectory, ".open-next/assets");
	const manifest = await readJson(path.join(next, "prerender-manifest.json"));
	if (manifest.version !== 4 || !manifest.routes)
		throw new Error("STATIC_METADATA_MANIFEST_INVALID");

	const files = await Promise.all(
		Object.entries(prerenderedMetadata).map(async ([pathname, contentType]) => {
			const entry = manifest.routes[pathname];
			if (
				entry?.routeType !== "route" ||
				entry.compute !== "static" ||
				entry.response !== "complete" ||
				entry.initialRevalidateSeconds !== false ||
				entry.srcRoute !== pathname ||
				entry.dataRoute !== null ||
				entry.initialHeaders?.["content-type"] !== contentType
			)
				throw new Error(`STATIC_METADATA_ROUTE_NOT_PRERENDERED: ${pathname}`);

			const source = path.join(next, "server/app", pathname.slice(1));
			const target = path.join(assets, pathname.slice(1));
			const [metadata, body, existing] = await Promise.all([
				readJson(`${source}.meta`),
				readFile(`${source}.body`),
				readIfPresent(target),
			]);
			const headers = metadata.headers;
			if (
				metadata.status !== 200 ||
				headers?.["content-type"] !== contentType ||
				headers["set-cookie"] !== undefined ||
				headers.vary !== undefined ||
				/\b(?:private|no-store)\b/i.test(headers["cache-control"] ?? "") ||
				body.length === 0
			)
				throw new Error(`STATIC_METADATA_RESPONSE_INVALID: ${pathname}`);
			if (existing && !existing.equals(body))
				throw new Error(`STATIC_METADATA_ASSET_CONFLICT: ${pathname}`);
			return { pathname, target, body, existing };
		}),
	);

	const robots = files.find(({ pathname }) => pathname === "/robots.txt").body.toString("utf8");
	const sitemapLinks = [...robots.matchAll(/^Sitemap:\s+(\S+)\s*$/gm)].map((match) => match[1]);
	// A native local build can let Next pick its origin from dotenv. Production
	// and the isolated Linux build both provide NEXT_PUBLIC_SAAS_URL explicitly.
	const origin = metadataUrl(canonicalOrigin ?? sitemapLinks[0], "/robots.txt").origin;
	if (
		sitemapLinks.length !== sitemapPaths.length ||
		sitemapPaths.some((pathname) => !sitemapLinks.includes(new URL(pathname, origin).href))
	)
		throw new Error("STATIC_METADATA_SITEMAP_REFERENCES_INVALID: /robots.txt");

	for (const { pathname, body } of files) {
		if (sitemapPaths.includes(pathname)) verifySitemap(pathname, body.toString("utf8"), origin);
		if (pathname === "/icon.png" && !body.subarray(0, 8).equals(pngSignature))
			throw new Error("STATIC_METADATA_RESPONSE_INVALID: /icon.png");
	}

	// Validate all sources and collisions before touching the asset directory.
	await Promise.all(
		files
			.filter(({ existing }) => !existing)
			.map(({ target, body }) => writeFile(target, body, { flag: "wx" })),
	);
}

async function readIfPresent(filename) {
	try {
		return await readFile(filename);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

async function readJson(filename) {
	return JSON.parse(await readFile(filename, "utf8"));
}

function metadataUrl(value, pathname) {
	const url = URL.parse(value);
	if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw new Error(`STATIC_METADATA_ORIGIN_INVALID: ${pathname}`);
	return url;
}

function verifySitemap(pathname, xml, origin) {
	const locations = [...xml.matchAll(/<(loc|image:loc)>([^<]+)<\/\1>/g)].map((match) => match[2]);
	const alternates = [...xml.matchAll(/<xhtml:link\b[^>]*\bhref="([^"]+)"/g)].map(
		(match) => match[1],
	);
	if (!xml.startsWith('<?xml version="1.0"') || !xml.includes("</urlset>") || !locations.length)
		throw new Error(`STATIC_METADATA_RESPONSE_INVALID: ${pathname}`);
	for (const url of [...locations, ...alternates]) {
		if (metadataUrl(url, pathname).origin !== origin)
			throw new Error(`STATIC_METADATA_ORIGIN_MISMATCH: ${pathname}`);
	}
}
