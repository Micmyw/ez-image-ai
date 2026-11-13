import { readFile, mkdir, rename, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const maxBytes = 10 * 1024 * 1024;

function decodeXml(value) {
	return value.trim().replace(/&([^;]+);/g, (_, entity) => {
		const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
		if (Object.hasOwn(named, entity)) return named[entity];
		if (/^#(?:x[\da-f]+|\d+)$/i.test(entity)) {
			return String.fromCodePoint(
				Number.parseInt(entity.slice(entity[1] === "x" ? 2 : 1), entity[1] === "x" ? 16 : 10),
			);
		}
		throw new Error("Unsupported sitemap XML entity");
	});
}

// This deliberately reads the site's standard sitemap vocabulary only. Image
// locs and hreflang links are not page entries and must never become submissions.
export function parseSitemap(xml) {
	const clean = xml
		.replace(/<\?xml[^?]*\?>/g, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.trim();
	const rootMatch = clean.match(/^<(urlset|sitemapindex)\b[^>]*>([\s\S]*)<\/\1>$/);
	if (!rootMatch || /<!DOCTYPE|<!ENTITY/i.test(clean)) throw new Error("Invalid sitemap XML");
	const kind = rootMatch[1] === "urlset" ? "url" : "sitemap";
	const blocks = [
		...rootMatch[2].matchAll(new RegExp(`<${kind}\\b[^>]*>([\\s\\S]*?)<\\/${kind}>`, "g")),
	];
	const remainder = rootMatch[2]
		.replace(new RegExp(`<${kind}\\b[^>]*>[\\s\\S]*?<\\/${kind}>`, "g"), "")
		.trim();
	if (remainder || !blocks.length) throw new Error("Empty or malformed sitemap");
	return {
		isIndex: kind === "sitemap",
		entries: blocks.map(([, block]) => {
			const locations = [...block.matchAll(/<loc>([^<]*)<\/loc>/g)];
			if (locations.length !== 1) throw new Error("Sitemap entry needs one page location");
			return {
				url: decodeXml(locations[0][1]),
				lastmod: decodeXml(block.match(/<lastmod>([^<]*)<\/lastmod>/)?.[1] ?? ""),
			};
		}),
	};
}

function siteUrl(value, origin, isSitemap = false) {
	const url = new URL(value);
	if (url.origin !== origin || url.username || url.password || url.hash) {
		throw new Error("Sitemap URL must belong to the canonical site");
	}
	if (!isSitemap && [...url.searchParams.keys()].some((key) => key !== "lang")) {
		throw new Error("Only public language query parameters can be submitted");
	}
	return url.href;
}

async function textResponse(response) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of response.body) {
		bytes += chunk.length;
		if (bytes > maxBytes) throw new Error("Sitemap response exceeded 10 MiB");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function getText(url, fetchImpl) {
	const response = await fetchImpl(url, {
		redirect: "error",
		headers: { "User-Agent": "EzImageAI-IndexNow/1.0", "Cache-Control": "no-cache" },
		signal: AbortSignal.timeout(30_000),
	});
	if (response.status !== 200)
		throw new Error(`Site fetch returned HTTP ${response.status}: ${new URL(url).pathname}`);
	return textResponse(response);
}

export async function collectPages(origin, fetchImpl = fetch) {
	const queue = [`${origin}/sitemap.xml`];
	const visited = new Set();
	const pages = new Map();
	while (queue.length) {
		const location = siteUrl(queue.shift(), origin, true);
		if (visited.has(location)) continue;
		if (visited.size >= 100) throw new Error("Too many sitemap documents");
		visited.add(location);
		const sitemap = parseSitemap(await getText(location, fetchImpl));
		for (const entry of sitemap.entries) {
			if (sitemap.isIndex) queue.push(siteUrl(entry.url, origin, true));
			else pages.set(siteUrl(entry.url, origin), entry.lastmod);
		}
	}
	if (!pages.size) throw new Error("No public pages found");
	return pages;
}

export function pendingPages(pages, state) {
	return [...pages].filter(([url, lastmod]) => state.accepted[url]?.lastmod !== lastmod);
}

export async function syncIndexNow({
	config,
	key,
	state,
	fetchImpl = fetch,
	dryRun = false,
	save = async () => {},
}) {
	if (!/^[a-zA-Z0-9-]{8,128}$/.test(key)) throw new Error("Invalid IndexNow key");
	if (new URL(config.origin).origin !== config.origin || !config.origin.startsWith("https://")) {
		throw new Error("Expected canonical HTTPS origin");
	}
	if (
		state.version !== 1 ||
		state.origin !== config.origin ||
		state.keyFile !== config.keyFile ||
		!state.accepted ||
		typeof state.accepted !== "object" ||
		Array.isArray(state.accepted)
	) {
		throw new Error("IndexNow state does not match this site/key");
	}
	const pages = await collectPages(config.origin, fetchImpl);
	const pending = pendingPages(pages, state);
	const report = {
		discovered: pages.size,
		changed: pending.length,
		submitted: 0,
		validationPending: 0,
		dryRun,
	};
	if (dryRun || !pending.length) return report;
	const keyLocation = new URL(`/${config.keyFile}`, config.origin).href;
	if ((await getText(keyLocation, fetchImpl)).trim() !== key) {
		throw new Error("Live IndexNow key file does not match; retry after deployment");
	}
	for (let offset = 0; offset < pending.length; offset += 10_000) {
		const batch = pending.slice(offset, offset + 10_000);
		const response = await fetchImpl(config.endpoint, {
			method: "POST",
			redirect: "error",
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify({
				host: new URL(config.origin).host,
				key,
				keyLocation,
				urlList: batch.map(([url]) => url),
			}),
			signal: AbortSignal.timeout(30_000),
		});
		await response.body?.cancel();
		if (![200, 202].includes(response.status)) {
			throw new Error(
				`IndexNow returned HTTP ${response.status}; unaccepted URLs will retry on the next run`,
			);
		}
		for (const [url, lastmod] of batch) {
			state.accepted[url] = {
				lastmod,
				submittedAt: new Date().toISOString(),
				status: response.status,
			};
		}
		report.submitted += batch.length;
		if (response.status === 202) report.validationPending += batch.length;
		// Keep already accepted batches even when a later batch fails.
		await save(state);
	}
	return report;
}

async function main() {
	const args = process.argv.slice(2);
	if (args.some((arg) => arg !== "--dry-run"))
		throw new Error("Usage: node tooling/indexnow/sync.mjs [--dry-run]");
	const config = JSON.parse(await readFile(new URL("./config.json", import.meta.url), "utf8"));
	const key = (await readFile(path.join(root, "apps/saas/public", config.keyFile), "utf8")).trim();
	const statePath = path.resolve(
		root,
		process.env.INDEXNOW_STATE_PATH || ".cache/indexnow/state.json",
	);
	let state;
	try {
		state = JSON.parse(await readFile(statePath, "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		state = { version: 1, origin: config.origin, keyFile: config.keyFile, accepted: {} };
	}
	const report = await syncIndexNow({
		config,
		key,
		state,
		dryRun: args.includes("--dry-run"),
		save: async (value) => {
			await mkdir(path.dirname(statePath), { recursive: true });
			await writeFile(`${statePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
			await rename(`${statePath}.tmp`, statePath);
		},
	});
	console.log(JSON.stringify(report));
	if (process.env.GITHUB_STEP_SUMMARY) {
		await appendFile(
			process.env.GITHUB_STEP_SUMMARY,
			`### Bing IndexNow\n\nPublic pages: ${report.discovered}; new/updated: ${report.changed}; submitted: ${report.submitted}; awaiting key validation: ${report.validationPending}.\n\nSubmission acknowledges receipt, not indexing.\n`,
		);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
