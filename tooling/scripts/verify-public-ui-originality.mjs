import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const forbiddenExpression = [
	["competitor-name", /raphael(?:\.app)?/i],
	["competitor-route", /seedream/i],
	["internal-model-field", /providerModelId/i],
	["internal-cost-field", /providerCostMicros/i],
	["internal-task-field", /providerTaskId/i],
	["internal-route-brand", /fal-ai|replicate\.com/i],
];
const providerDisclosureExpression = /\bOpenAI\b/i;
const publicTextExtensions = new Set([
	".css",
	".csv",
	".html",
	".js",
	".json",
	".map",
	".md",
	".mdx",
	".mjs",
	".rsc",
	".svg",
	".ts",
	".txt",
	".webmanifest",
	".xml",
]);
const publicResourceAttribute = /(?:src|href|poster)=["']((?:https?:)?\/\/[^"']+)["']/gi;
const markdownImageResource = /!\[[^\]]*\]\(((?:https?:)?\/\/[^)\s]+)[^)]*\)/gi;
const serializedRscResourceProperty =
	/\\?"(?:src|href|poster)\\?"\s*:\s*\\?"((?:https?:)?\/\/[^"\\]+)\\?"/gi;
const cssResourceUrl = /url\(\s*["']?((?:https?:)?\/\/[^)'"\s]+)["']?\s*\)/gi;
const scriptAssetUrl =
	/["']((?:https?:)?\/\/[^"']+\.(?:avif|css|gif|jpe?g|js|mjs|mp4|png|svg|webm|webp|woff2?)(?:\?[^"']*)?)["']/gi;
const browserArtifactReference =
	/["']((?:(?:\.{1,2}\/)|(?:\/_next\/)?static\/)[^"']+\.(?:css|js|mjs))["']/g;
const ownedHosts = new Set(["ezpic.ai", "www.ezpic.ai", "app.ezpic.ai", "localhost", "127.0.0.1"]);
const approvedPublicResourceHosts = new Set(["challenges.cloudflare.com"]);
const saasBuildRoot = path.resolve("apps/saas/.next");
const builtPublicRoutes = [
	publicBuildRoute("home", ["page_client-reference-manifest.js"], "/page", "/"),
	publicBuildRoute(
		"try",
		["(guest)", "try", "page_client-reference-manifest.js"],
		"/(guest)/try/page",
		"/try",
		["try"],
	),
	publicBuildRoute(
		"pricing",
		["(public)", "pricing", "page_client-reference-manifest.js"],
		"/(public)/pricing/page",
		"/pricing",
		["pricing"],
	),
	publicBuildRoute(
		"privacy",
		["(public)", "privacy", "page_client-reference-manifest.js"],
		"/(public)/privacy/page",
		"/privacy",
		["privacy"],
	),
	publicBuildRoute(
		"terms",
		["(public)", "terms", "page_client-reference-manifest.js"],
		"/(public)/terms/page",
		"/terms",
		["terms"],
	),
	publicBuildRoute(
		"blog-index",
		["(public)", "blog", "page_client-reference-manifest.js"],
		"/(public)/blog/page",
		"/blog",
		["blog"],
	),
	publicBuildRoute(
		"blog-article",
		["(public)", "blog", "[...path]", "page_client-reference-manifest.js"],
		"/(public)/blog/[...path]/page",
		"/blog/private-image-editing-workflow",
		["blog/private-image-editing-workflow"],
	),
	publicBuildRoute(
		"changelog",
		["(public)", "changelog", "page_client-reference-manifest.js"],
		"/(public)/changelog/page",
		"/changelog",
		["changelog"],
	),
	publicBuildRoute(
		"contact",
		["(public)", "contact", "page_client-reference-manifest.js"],
		"/(public)/contact/page",
		"/contact",
		["contact"],
	),
	publicBuildRoute(
		"docs-index",
		["docs", "[[...slug]]", "page_client-reference-manifest.js"],
		"/docs/[[...slug]]/page",
		"/docs",
		["docs"],
	),
	publicBuildRoute(
		"docs-page",
		["docs", "[[...slug]]", "page_client-reference-manifest.js"],
		"/docs/[[...slug]]/page",
		"/docs/quick-start",
		["docs/quick-start"],
	),
	publicBuildRoute(
		"docs-search",
		["docs", "api", "search", "route_client-reference-manifest.js"],
		"/docs/api/search/route",
		"/docs/api/search?query=image",
	),
	publicBuildRoute(
		"docs-llms-index",
		["docs", "llms.txt", "route_client-reference-manifest.js"],
		"/docs/llms.txt/route",
		"/docs/llms.txt",
	),
	publicBuildRoute(
		"docs-llms-full",
		["docs", "llms-full.txt", "route_client-reference-manifest.js"],
		"/docs/llms-full.txt/route",
		"/docs/llms-full.txt",
	),
	publicBuildRoute(
		"docs-llms-page",
		["docs", "llms.mdx", "[[...slug]]", "route_client-reference-manifest.js"],
		"/docs/llms.mdx/[[...slug]]/route",
		"/docs/llms.mdx/quick-start",
	),
	publicBuildRoute(
		"docs-og",
		["docs", "og", "[...slug]", "route_client-reference-manifest.js"],
		"/docs/og/[...slug]/route",
		"/docs/og/quick-start/image.png",
		[],
		false,
	),
];
const deployedPublicRoots = [path.resolve("apps/saas/public")];
const publicContentRoots = [path.resolve("apps/saas/content")];
const requiredPublicRouteCoverage = new Map([
	["home", ["/page", "/", true]],
	["try", ["/(guest)/try/page", "/try", true]],
	["pricing", ["/(public)/pricing/page", "/pricing", true]],
	["privacy", ["/(public)/privacy/page", "/privacy", true]],
	["terms", ["/(public)/terms/page", "/terms", true]],
	["blog-index", ["/(public)/blog/page", "/blog", true]],
	["blog-article", ["/(public)/blog/[...path]/page", "/blog/private-image-editing-workflow", true]],
	["changelog", ["/(public)/changelog/page", "/changelog", true]],
	["contact", ["/(public)/contact/page", "/contact", true]],
	["docs-index", ["/docs/[[...slug]]/page", "/docs", true]],
	["docs-page", ["/docs/[[...slug]]/page", "/docs/quick-start", true]],
	["docs-search", ["/docs/api/search/route", "/docs/api/search?query=image", true]],
	["docs-llms-index", ["/docs/llms.txt/route", "/docs/llms.txt", true]],
	["docs-llms-full", ["/docs/llms-full.txt/route", "/docs/llms-full.txt", true]],
	["docs-llms-page", ["/docs/llms.mdx/[[...slug]]/route", "/docs/llms.mdx/quick-start", true]],
	["docs-og", ["/docs/og/[...slug]/route", "/docs/og/quick-start/image.png", false]],
]);

function publicBuildRoute(
	id,
	manifestSegments,
	appPathKey,
	representativePath,
	outputRoutes = [],
	scanArtifacts = true,
) {
	return {
		id,
		buildRoot: saasBuildRoot,
		manifest: path.join("server", "app", ...manifestSegments),
		appPathKey,
		representativePath,
		outputRoutes,
		scanArtifacts,
	};
}

export function assertSaasOnlyScannerConfiguration(
	routes = builtPublicRoutes,
	roots = deployedPublicRoots,
	contentRoots = publicContentRoots,
) {
	const expectedBuildRoot = path.resolve("apps", "saas", ".next");
	const expectedPublicRoot = path.resolve("apps", "saas", "public");
	const expectedContentRoot = path.resolve("apps", "saas", "content");
	if (!routes.length || routes.some(({ buildRoot }) => buildRoot !== expectedBuildRoot)) {
		throw new Error("Public UI originality scanner must use only the SaaS build root");
	}
	const routeById = new Map();
	for (const route of routes) {
		if (!route.id || routeById.has(route.id)) {
			throw new Error(`Public UI originality scanner has an invalid route id: ${route.id ?? ""}`);
		}
		routeById.set(route.id, route);
	}
	for (const [id, [appPathKey, representativePath, scanArtifacts]] of requiredPublicRouteCoverage) {
		const route = routeById.get(id);
		if (!route) throw new Error(`Missing required public route coverage: ${id}`);
		if (
			route.appPathKey !== appPathKey ||
			route.representativePath !== representativePath ||
			route.scanArtifacts !== scanArtifacts
		) {
			throw new Error(`Invalid required public route coverage: ${id}`);
		}
	}
	if (roots.length !== 1 || roots[0] !== expectedPublicRoot) {
		throw new Error("Public UI originality scanner must use only the SaaS public root");
	}
	if (contentRoots.length !== 1 || contentRoots[0] !== expectedContentRoot) {
		throw new Error("Public UI originality scanner must include only the SaaS public content root");
	}
}

export async function scanPublicUiRoots(roots) {
	const files = [];
	for (const root of roots) {
		files.push(...(await publicArtifactFiles(root)));
	}
	return [...(await scanPublicUiFiles(files)), ...(await scanProviderDisclosureFiles(files))];
}

async function scanPublicUiFiles(files) {
	const findings = [];
	for (const file of [...new Set(files)].sort((left, right) => left.localeCompare(right))) {
		const content = await readFile(file, "utf8");
		for (const [kind, pattern] of forbiddenExpression) {
			const match = pattern.exec(content);
			if (match) findings.push({ file, kind, value: match[0] });
		}
		for (const pattern of resourcePatternsFor(file)) {
			pattern.lastIndex = 0;
			for (const match of content.matchAll(pattern)) {
				const value = match[1];
				if (value && !isOwnedResource(value)) {
					findings.push({ file, kind: "foreign-hotlink", value });
				}
			}
		}
	}
	return findings;
}

async function scanProviderDisclosureFiles(files) {
	const findings = [];
	for (const file of [...new Set(files)].sort((left, right) => left.localeCompare(right))) {
		const content = await readFile(file, "utf8");
		const match = providerDisclosureExpression.exec(content);
		if (match) findings.push({ file, kind: "provider-disclosure", value: match[0] });
	}
	return findings;
}

function resourcePatternsFor(file) {
	switch (path.extname(file)) {
		case ".css":
			return [cssResourceUrl];
		case ".html":
			return [publicResourceAttribute, cssResourceUrl];
		case ".md":
			return [markdownImageResource, publicResourceAttribute];
		case ".rsc":
			return [publicResourceAttribute, serializedRscResourceProperty, cssResourceUrl];
		case ".svg":
		case ".xml":
			return [publicResourceAttribute, cssResourceUrl];
		case ".js":
		case ".map":
		case ".mjs":
			return [scriptAssetUrl];
		default:
			return [];
	}
}

async function publicArtifactFiles(root) {
	const result = [];
	const resolvedRoot = path.resolve(root);
	if (!(await fileExists(resolvedRoot))) return result;
	const stack = [resolvedRoot];
	while (stack.length) {
		const current = stack.pop();
		if (!current) continue;
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(absolute);
			} else if (entry.isFile() && publicTextExtensions.has(path.extname(entry.name))) {
				result.push(absolute);
			}
		}
	}
	return result.sort();
}

function isOwnedResource(value) {
	try {
		const hostname = new URL(
			value.startsWith("//") ? `https:${value}` : value,
		).hostname.toLowerCase();
		return ownedHosts.has(hostname) || approvedPublicResourceHosts.has(hostname);
	} catch {
		return false;
	}
}

async function assertProductionBuild(root) {
	await readFile(path.join(root, "BUILD_ID"), "utf8");
}

async function publicRouteArtifactFiles(
	buildRoot,
	manifestRelativePath,
	{ appPathKey, outputRoutes = [] } = {},
) {
	const manifest = await readFile(path.join(buildRoot, manifestRelativePath), "utf8");
	const buildRootPrefix = `${path.resolve(buildRoot)}${path.sep}`;
	const browserSeeds = new Set();
	const artifactPath = /(?:\/_next\/)?(static\/[^"'\\]+?\.(?:css|js|mjs))/g;
	for (const match of manifest.matchAll(artifactPath)) {
		const relativePath = match[1];
		if (!relativePath) continue;
		const absolute = path.resolve(buildRoot, ...relativePath.split("/"));
		if (!absolute.startsWith(buildRootPrefix)) {
			throw new Error(`Public route manifest escaped its build root: ${relativePath}`);
		}
		browserSeeds.add(absolute);
	}
	if (!browserSeeds.size && !appPathKey?.endsWith("/route"))
		throw new Error(
			`Public route manifest contained no browser artifacts: ${manifestRelativePath}`,
		);
	const files = browserSeeds.size
		? await recursivelyReferencedBrowserFiles([...browserSeeds], buildRoot)
		: new Set();
	if (appPathKey) {
		const appPaths = JSON.parse(
			await readFile(path.join(buildRoot, "server", "app-paths-manifest.json"), "utf8"),
		);
		const routePage = appPaths[appPathKey];
		if (typeof routePage !== "string") {
			throw new Error(`Public app path was absent from its build manifest: ${appPathKey}`);
		}
		files.add(
			resolveBuildArtifact(
				buildRoot,
				/^server[\\/]/.test(routePage) ? routePage : path.join("server", routePage),
			),
		);
	}
	for (const outputRoute of outputRoutes) {
		for (const extension of [".html", ".rsc"]) {
			const artifact = resolveBuildArtifact(
				buildRoot,
				path.join("server", "app", `${outputRoute}${extension}`),
			);
			if (await fileExists(artifact)) files.add(artifact);
		}
	}
	for (const file of [...files]) {
		const sourceMap = `${file}.map`;
		if (await fileExists(sourceMap)) files.add(sourceMap);
	}
	return [...files];
}

async function recursivelyReferencedBrowserFiles(seeds, buildRoot) {
	const files = new Set();
	const stack = [...seeds];
	const staticRoot = `${path.resolve(buildRoot, "static")}${path.sep}`;
	while (stack.length) {
		const file = stack.pop();
		if (!file || files.has(file)) continue;
		files.add(file);
		const content = await readFile(file, "utf8");
		browserArtifactReference.lastIndex = 0;
		for (const match of content.matchAll(browserArtifactReference)) {
			const reference = match[1];
			if (!reference) continue;
			const candidate =
				reference.startsWith("./") || reference.startsWith("../")
					? path.resolve(path.dirname(file), reference)
					: path.resolve(buildRoot, reference.replace(/^\/_next\//, ""));
			if (!candidate.startsWith(staticRoot) || !(await fileExists(candidate))) continue;
			stack.push(candidate);
		}
	}
	return files;
}

function resolveBuildArtifact(buildRoot, relativePath) {
	const resolvedRoot = path.resolve(buildRoot);
	const absolute = path.resolve(resolvedRoot, relativePath);
	if (!absolute.startsWith(`${resolvedRoot}${path.sep}`)) {
		throw new Error(`Public route artifact escaped its build root: ${relativePath}`);
	}
	return absolute;
}

async function fileExists(file) {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

async function selfTest() {
	assertSaasOnlyScannerConfiguration();
	const root = await mkdtemp(path.join(tmpdir(), "ezpic-originality-test-"));
	try {
		const good = path.join(root, "good");
		const bad = path.join(root, "bad");
		const build = path.join(root, "build");
		const manifest = path.join("server", "app", "public", "page_client-reference-manifest.js");
		await Promise.all([mkdir(good, { recursive: true }), mkdir(bad, { recursive: true })]);
		await Promise.all([
			writeFixture(
				good,
				'<img src="/owned.webp"><script src="https://www.ezpic.ai/app.js"></script>',
			),
			writeFixture(
				bad,
				'<img src="https://foreign.example/borrowed.png"><script>const providerModelId="competitor"; const name="Seedream";</script>',
			),
			writeFile(
				path.join(good, "client.js"),
				'const documentation="https://base-ui.com/production-error"; location.href=documentation;',
				"utf8",
			),
			writeFile(
				path.join(bad, "client.js"),
				'const providerTaskId="private-task"; const borrowed="https://foreign.example/borrowed.png";',
				"utf8",
			),
			writeRouteFixture(build, manifest),
		]);
		const goodFindings = await scanPublicUiRoots([good]);
		const badFindings = await scanPublicUiRoots([bad]);
		const routeFiles = await publicRouteArtifactFiles(build, manifest, {
			appPathKey: "/public/page",
			outputRoutes: ["public"],
		});
		const routeFindings = await scanPublicUiFiles(routeFiles);
		if (goodFindings.length !== 0) throw new Error("Controlled owned fixture was rejected");
		if (routeFiles.length !== 5) {
			throw new Error(`Controlled route graph selected ${routeFiles.length} files instead of 5`);
		}
		for (const expected of ["competitor-route", "internal-task-field", "foreign-hotlink"]) {
			if (!routeFindings.some((finding) => finding.kind === expected)) {
				throw new Error(`Controlled route-owned fixture did not trigger ${expected}`);
			}
		}
		if (routeFindings.some((finding) => finding.kind === "internal-model-field")) {
			throw new Error("Server-only or unreferenced private chunks entered the public scan");
		}
		for (const expected of [
			"https://rsc-foreign.example/serialized.png",
			"https://nested-rsc-foreign.example/preview.webp",
		]) {
			if (
				!routeFindings.some(
					(finding) =>
						finding.kind === "foreign-hotlink" &&
						path.basename(finding.file) === "public.rsc" &&
						finding.value === expected,
				)
			) {
				throw new Error(`Controlled serialized RSC resource was not detected: ${expected}`);
			}
		}
		for (const expected of [
			"competitor-route",
			"internal-model-field",
			"internal-task-field",
			"foreign-hotlink",
		]) {
			if (!badFindings.some((finding) => finding.kind === expected)) {
				throw new Error(`Controlled forbidden fixture did not trigger ${expected}`);
			}
		}
		process.stdout.write("Public UI originality scanner controlled fixtures: PASS\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function writeFixture(root, content) {
	await mkdir(root, { recursive: true });
	await writeFile(path.join(root, "artifact.html"), content, "utf8");
}

async function writeRouteFixture(buildRoot, manifestRelativePath) {
	const publicChunk = path.join(buildRoot, "static", "chunks", "public.js");
	const dynamicChunk = path.join(buildRoot, "static", "chunks", "dynamic.js");
	const privateChunk = path.join(buildRoot, "server", "chunks", "private.js");
	const routePage = path.join(buildRoot, "server", "app", "public", "page.js");
	const routeHtml = path.join(buildRoot, "server", "app", "public.html");
	const routeRsc = path.join(buildRoot, "server", "app", "public.rsc");
	const appPathsManifest = path.join(buildRoot, "server", "app-paths-manifest.json");
	const manifestPath = path.join(buildRoot, manifestRelativePath);
	await Promise.all([
		mkdir(path.dirname(publicChunk), { recursive: true }),
		mkdir(path.dirname(privateChunk), { recursive: true }),
		mkdir(path.dirname(routePage), { recursive: true }),
		mkdir(path.dirname(manifestPath), { recursive: true }),
	]);
	await Promise.all([
		writeFile(publicChunk, 'import("./dynamic.js"); const asset="/owned.webp";', "utf8"),
		writeFile(dynamicChunk, 'const providerTaskId="public-dynamic-leak";', "utf8"),
		writeFile(privateChunk, 'const providerModelId="server-only";', "utf8"),
		writeFile(routePage, 'const publicHeading="Seedream route leak";', "utf8"),
		writeFile(routeHtml, '<img src="//foreign.example/route-owned.png">', "utf8"),
		writeFile(
			routeRsc,
			'1:["$","img",null,{"src":"https://rsc-foreign.example/serialized.png"}]\n2:"{\\"poster\\":\\"https://nested-rsc-foreign.example/preview.webp\\"}"',
			"utf8",
		),
		writeFile(appPathsManifest, '{"/public/page":"server/app/public/page.js"}', "utf8"),
		writeFile(manifestPath, '{"chunks":["/_next/static/chunks/public.js"]}', "utf8"),
	]);
}

async function main() {
	const arguments_ = process.argv.slice(2);
	if (arguments_.includes("--self-test")) {
		await selfTest();
		return;
	}
	const explicitRoots = arguments_
		.flatMap((value, index) => (value === "--root" ? [arguments_[index + 1]] : []))
		.filter(Boolean);
	let roots = explicitRoots;
	let files;
	let providerDisclosureFiles;
	if (explicitRoots.length) {
		files = (await Promise.all(explicitRoots.map(publicArtifactFiles))).flat();
		providerDisclosureFiles = files;
	} else {
		assertSaasOnlyScannerConfiguration();
		await Promise.all(
			[...new Set(builtPublicRoutes.map(({ buildRoot }) => buildRoot))].map(assertProductionBuild),
		);
		const existingPublicRoots = [];
		for (const root of deployedPublicRoots) {
			if (await fileExists(root)) existingPublicRoots.push(root);
		}
		const existingPublicContentRoots = [];
		for (const root of publicContentRoots) {
			if (await fileExists(root)) existingPublicContentRoots.push(root);
		}
		const builtFiles = (
			await Promise.all(
				builtPublicRoutes.map(
					async ({ buildRoot, manifest, appPathKey, outputRoutes, scanArtifacts }) => {
						const routeFiles = await publicRouteArtifactFiles(buildRoot, manifest, {
							appPathKey,
							outputRoutes,
						});
						return scanArtifacts ? routeFiles : [];
					},
				),
			)
		).flat();
		const rawPublicFiles = (
			await Promise.all(existingPublicRoots.map((root) => publicArtifactFiles(root)))
		).flat();
		const rawPublicContentFiles = (
			await Promise.all(existingPublicContentRoots.map((root) => publicArtifactFiles(root)))
		).flat();
		files = [...new Set([...builtFiles, ...rawPublicFiles, ...rawPublicContentFiles])];
		providerDisclosureFiles = rawPublicFiles;
		roots = [saasBuildRoot, ...existingPublicRoots, ...existingPublicContentRoots];
	}
	const findings = [
		...(await scanPublicUiFiles(files)),
		...(await scanProviderDisclosureFiles(providerDisclosureFiles)),
	];
	if (findings.length) {
		for (const finding of findings) {
			process.stderr.write(`${finding.kind}: ${finding.file}: ${finding.value}\n`);
		}
		throw new Error(`Public UI originality verification failed with ${findings.length} finding(s)`);
	}
	process.stdout.write(
		`Public UI originality verification: PASS (${files.length} public route/content artifacts across ${roots.length} roots)\n`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
