import assert from "node:assert/strict";
import { test } from "node:test";

import { collectPages, parseSitemap, syncIndexNow } from "./sync.mjs";

const config = {
	origin: "https://example.com",
	endpoint: "https://www.bing.com/indexnow",
	keyFile: "indexnow-key.txt",
};
const key = "example-test-key";
const emptyState = () => ({
	version: 1,
	origin: config.origin,
	keyFile: config.keyFile,
	accepted: {},
});
const sitemap = (entries) =>
	`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.map(([url, date]) => `<url><loc>${url}</loc>${date ? `<lastmod>${date}</lastmod>` : ""}</url>`).join("")}</urlset>`;
const samplePages = [
	["https://example.com/blog/birthday", "2026-11-13"],
	["https://example.com/examples?lang=de", ""],
];

function fixture({ entries = samplePages, keyText = key, status = 200, statuses } = {}) {
	const posts = [];
	return {
		posts,
		fetchImpl: async (url, options) => {
			if (url === `${config.origin}/sitemap.xml`) return new Response(sitemap(entries));
			if (url === `${config.origin}/${config.keyFile}`) return new Response(keyText);
			assert.equal(url, config.endpoint);
			assert.equal(options.method, "POST");
			assert.equal(options.redirect, "error");
			posts.push(JSON.parse(options.body));
			return new Response("", { status: statuses?.[posts.length - 1] ?? status });
		},
	};
}

void test("reads page locations and language URLs without collecting image or hreflang URLs", () => {
	const parsed = parseSitemap(
		`<?xml version="1.0"?><urlset><url><loc>https://example.com/?lang=de</loc><lastmod>2026-11-13</lastmod><image:image><image:loc>https://cdn.example.com/image.webp</image:loc></image:image><xhtml:link href="https://example.com/?lang=es" /></url></urlset>`,
	);
	assert.deepEqual(parsed.entries, [
		{ url: "https://example.com/?lang=de", lastmod: "2026-11-13" },
	]);
	assert.equal(
		parseSitemap("<urlset><url><loc>https://example.com/a&#45;b</loc></url></urlset>").entries[0]
			.url,
		"https://example.com/a-b",
	);
});

void test("truncated, empty and non-sitemap responses cannot produce a successful run", () => {
	for (const xml of [
		"<html>Unavailable</html>",
		"<urlset></urlset>",
		"<urlset><url><loc>x</loc></urlset>",
		"<!DOCTYPE x><urlset><url><loc>x</loc></url></urlset>",
	]) {
		assert.throws(() => parseSitemap(xml));
	}
});

void test("walks a sitemap index with deduplication", async () => {
	const fetchImpl = async (url) =>
		new Response(
			url.endsWith("/sitemap.xml")
				? `<sitemapindex><sitemap><loc>${config.origin}/pages.xml</loc></sitemap><sitemap><loc>${config.origin}/pages.xml</loc></sitemap></sitemapindex>`
				: sitemap(samplePages),
		);
	assert.deepEqual([...(await collectPages(config.origin, fetchImpl))], samplePages);
});

void test("initial submission uses exact canonical URLs and a verified key location", async () => {
	const state = emptyState();
	const { fetchImpl, posts } = fixture();
	let saves = 0;
	const result = await syncIndexNow({
		config,
		key,
		state,
		fetchImpl,
		save: async () => {
			saves++;
		},
	});
	assert.equal(result.submitted, 2);
	assert.equal(saves, 1);
	assert.deepEqual(posts[0], {
		host: "example.com",
		key,
		keyLocation: `${config.origin}/${config.keyFile}`,
		urlList: samplePages.map(([url]) => url),
	});
	assert.equal(state.accepted[samplePages[0][0]].status, 200);
	assert.equal((await syncIndexNow({ config, key, state, fetchImpl })).submitted, 0);
	assert.equal(posts.length, 1);
});

void test("only new pages or changed lastmod values are submitted on subsequent runs", async () => {
	const state = emptyState();
	await syncIndexNow({ config, key, state, ...fixture() });
	const { fetchImpl, posts } = fixture({
		entries: [
			[samplePages[0][0], "2026-11-14"],
			samplePages[1],
			["https://example.com/blog/new", ""],
		],
	});
	await syncIndexNow({ config, key, state, fetchImpl });
	assert.deepEqual(posts[0].urlList, [samplePages[0][0], "https://example.com/blog/new"]);
});

void test("dry run makes no submission or state writes", async () => {
	const state = emptyState();
	const { fetchImpl, posts } = fixture();
	const result = await syncIndexNow({
		config,
		key,
		state,
		fetchImpl,
		dryRun: true,
		save: async () => {
			assert.fail("dry run saved state");
		},
	});
	assert.equal(result.changed, 2);
	assert.equal(posts.length, 0);
	assert.deepEqual(state.accepted, {});
});

void test("key mismatch, foreign hosts and private query states never reach Bing", async () => {
	for (const options of [
		{ keyText: "wrong-key" },
		{ entries: [["https://elsewhere.com/page", ""]] },
		{ entries: [["https://example.com/create?job=private", ""]] },
	]) {
		const { fetchImpl, posts } = fixture(options);
		await assert.rejects(syncIndexNow({ config, key, state: emptyState(), fetchImpl }));
		assert.equal(posts.length, 0);
	}
});

void test("200 and 202 are accepted, with key validation pending recorded separately", async () => {
	const state = emptyState();
	const result = await syncIndexNow({ config, key, state, ...fixture({ status: 202 }) });
	assert.equal(result.submitted, 2);
	assert.equal(result.validationPending, 2);
	assert.equal(state.accepted[samplePages[0][0]].status, 202);
});

void test("rate limits and errors retain unaccepted URLs for the next scheduled retry", async () => {
	for (const status of [403, 422, 429, 500]) {
		const state = emptyState();
		await assert.rejects(
			syncIndexNow({ config, key, state, ...fixture({ status }) }),
			new RegExp(`HTTP ${status}`),
		);
		assert.deepEqual(state.accepted, {});
		assert.equal((await syncIndexNow({ config, key, state, ...fixture() })).submitted, 2);
	}
});

void test("batches at 10000 and retains only successful batches when the next one fails", async () => {
	const entries = Array.from({ length: 10_001 }, (_, i) => [`https://example.com/page-${i}`, ""]);
	const state = emptyState();
	const { fetchImpl, posts } = fixture({ entries, statuses: [200, 429] });
	let saved;
	await assert.rejects(
		syncIndexNow({
			config,
			key,
			state,
			fetchImpl,
			save: async (value) => {
				saved = structuredClone(value);
			},
		}),
		/HTTP 429/,
	);
	assert.deepEqual(
		posts.map((post) => post.urlList.length),
		[10_000, 1],
	);
	assert.equal(Object.keys(saved.accepted).length, 10_000);
	const retry = fixture({ entries });
	assert.equal((await syncIndexNow({ config, key, state: saved, ...retry })).submitted, 1);
	assert.deepEqual(retry.posts[0].urlList, [entries[10_000][0]]);
});

void test("an existing state for another host or key cannot suppress this site's pages", async () => {
	await assert.rejects(
		syncIndexNow({
			config,
			key,
			state: { ...emptyState(), origin: "https://other.example" },
			...fixture(),
		}),
		/state does not match/,
	);
});
