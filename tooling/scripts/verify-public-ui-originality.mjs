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
const publicTextExtensions = new Set([".css", ".html", ".js", ".map", ".mjs", ".rsc"]);
const publicResourceAttribute = /(?:src|href|poster)=["']((?:https?:)?\/\/[^"']+)["']/gi;
const cssResourceUrl = /url\(\s*["']?((?:https?:)?\/\/[^)'"\s]+)["']?\s*\)/gi;
const scriptAssetUrl =
	/["']((?:https?:)?\/\/[^"']+\.(?:avif|css|gif|jpe?g|js|mjs|mp4|png|svg|webm|webp|woff2?)(?:\?[^"']*)?)["']/gi;
const browserArtifactReference =
	/["']((?:(?:\.{1,2}\/)|(?:\/_next\/)?static\/)[^"']+\.(?:css|js|mjs))["']/g;
const ownedHosts = new Set(["ezpic.ai", "www.ezpic.ai", "app.ezpic.ai", "localhost", "127.0.0.1"]);
const approvedPublicResourceHosts = new Set(["challenges.cloudflare.com"]);
const builtPublicRoutes = [
	{
		buildRoot: path.resolve("apps/marketing/.next"),
		manifest: path.join("server", "app", "[locale]", "(home)", "page_client-reference-manifest.js"),
		appPathKey: "/[locale]/(home)/page",
		outputRoutes: [],
	},
	{
		buildRoot: path.resolve("apps/saas/.next"),
		manifest: path.join("server", "app", "(guest)", "try", "page_client-reference-manifest.js"),
		appPathKey: "/(guest)/try/page",
		outputRoutes: ["try"],
	},
];

export async function scanPublicUiRoots(roots) {
	const files = [];
	for (const root of roots) {
		files.push(...(await publicArtifactFiles(root)));
	}
	return scanPublicUiFiles(files);
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

function resourcePatternsFor(file) {
	switch (path.extname(file)) {
		case ".css":
			return [cssResourceUrl];
		case ".html":
		case ".rsc":
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
	const stack = [path.resolve(root)];
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
	if (!browserSeeds.size)
		throw new Error(
			`Public route manifest contained no browser artifacts: ${manifestRelativePath}`,
		);
	const files = await recursivelyReferencedBrowserFiles([...browserSeeds], buildRoot);
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
		if (routeFiles.length !== 4) {
			throw new Error(`Controlled route graph selected ${routeFiles.length} files instead of 4`);
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
	if (explicitRoots.length) {
		files = (await Promise.all(explicitRoots.map(publicArtifactFiles))).flat();
	} else {
		await Promise.all(builtPublicRoutes.map(({ buildRoot }) => assertProductionBuild(buildRoot)));
		files = (
			await Promise.all(
				builtPublicRoutes.map(({ buildRoot, manifest, appPathKey, outputRoutes }) =>
					publicRouteArtifactFiles(buildRoot, manifest, { appPathKey, outputRoutes }),
				),
			)
		).flat();
		roots = builtPublicRoutes.map(({ buildRoot }) => buildRoot);
	}
	const findings = await scanPublicUiFiles(files);
	if (findings.length) {
		for (const finding of findings) {
			process.stderr.write(`${finding.kind}: ${finding.file}: ${finding.value}\n`);
		}
		throw new Error(`Public UI originality verification failed with ${findings.length} finding(s)`);
	}
	process.stdout.write(
		`Public UI originality verification: PASS (${files.length} public route artifacts across ${roots.length} built roots)\n`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
