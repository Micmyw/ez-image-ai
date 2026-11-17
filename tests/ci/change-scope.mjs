import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function readWorkspaces(root) {
	return ["apps", "packages", "tooling"].flatMap((group) =>
		readdirSync(resolve(root, group), { withFileTypes: true }).flatMap((entry) => {
			const directory = `${group}/${entry.name}`;
			const manifest = resolve(root, directory, "package.json");
			if (!entry.isDirectory() || !existsSync(manifest)) return [];
			const pkg = JSON.parse(readFileSync(manifest, "utf8"));
			return [
				{
					name: pkg.name,
					directory,
					dependencies: Object.keys({
						...pkg.dependencies,
						...pkg.devDependencies,
						...pkg.optionalDependencies,
					}),
				},
			];
		}),
	);
}

export function affectedWorkspaces(names, workspaces) {
	const affected = new Set(names);
	let added;
	do {
		added = false;
		for (const pkg of workspaces) {
			if (!affected.has(pkg.name) && pkg.dependencies.some((name) => affected.has(name))) {
				affected.add(pkg.name);
				added = true;
			}
		}
	} while (added);
	return [...affected].sort((left, right) => left.localeCompare(right));
}

const documentation =
	/^(?:docs\/.*\.md$|\.agents\/.*\.md$|\.github\/.*\.md$|(?:README|CHANGELOG|AGENTS|agents)\.md$)/;
const runtimeNames = new Set(["@repo/workflows", "@repo/jobs-runtime", "@repo/web-host"]);
const backendNames = new Set([
	"@repo/api",
	"@repo/database",
	"@repo/jobs",
	"@repo/auth",
	"@repo/payments",
	"@repo/storage",
	"@repo/config",
	"@repo/ai",
	"@repo/utils",
]);
const publicPresentation =
	/^apps\/saas\/(?:content\/|public\/|modules\/(?:marketing|public-content|docs)\/)/;
const browserSurface =
	/^apps\/saas\/(?:modules\/(?:media|landing|gta|video-v1|auth|payments|billing|shared|saas)\/|tests\/|playwright|proxy\.|app\/(?:api\/|\(saas\)\/))/;

export function classifyChanges(files, workspaces, forceFull = false) {
	const scope = {
		code: false,
		builds: false,
		postgres: false,
		admin: false,
		media: false,
		runtime: false,
		full: false,
		units: [],
	};
	const units = new Set();
	const full = () => ({
		code: true,
		builds: true,
		postgres: true,
		admin: true,
		media: true,
		runtime: true,
		full: true,
		units: null,
	});
	if (forceFull) return full();
	for (const file of files) {
		if (documentation.test(file)) continue;
		// Dependency, tooling, workflow and unclassified paths fail open to all checks.
		if (
			/(?:^|\/)package\.json$/.test(file) ||
			file.startsWith(".github/") ||
			file.startsWith("tests/")
		)
			return full();
		const owner = workspaces.find((pkg) => file.startsWith(`${pkg.directory}/`));
		if (!owner) return full();
		scope.code = true;
		const testOnly = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || /\/tests\//.test(file);
		const affected = testOnly ? [owner.name] : affectedWorkspaces([owner.name], workspaces);
		for (const name of affected) units.add(name);
		if (testOnly) {
			if (/\.integration\.test\./.test(file)) scope.postgres = true;
			if (/minio|workerd/.test(file)) {
				scope.media = true;
				scope.runtime = true;
			}
			if (/apps\/saas\/tests\/admin|playwright\.admin/.test(file)) scope.admin = true;
			else if (/\.spec\.|apps\/saas\/tests\//.test(file)) scope.media = true;
			continue;
		}
		if (affected.includes("saas")) scope.builds = true;
		if (affected.some((name) => runtimeNames.has(name))) scope.runtime = true;
		if (backendNames.has(owner.name)) {
			scope.postgres = true;
			scope.admin = true;
			scope.media = true;
			scope.runtime = true;
		}
		if (owner.name === "saas") {
			if (/\/cloudflare\/|\/wrangler[^/]*$|\/(?:next|open-next)\.config\./.test(file))
				scope.runtime = true;
			// Pure public rendering/content and styles do not need funded-account E2E.
			if (!publicPresentation.test(file) && !/\.(?:css|mdx?)$/.test(file)) {
				if (browserSurface.test(file)) scope.media = true;
				else {
					scope.media = true;
					scope.admin = true;
				}
				if (/\/modules\/(?:admin|shared|auth|saas|payments|billing)\/|\/proxy\./.test(file))
					scope.admin = true;
			}
			if (/\/app\/api\//.test(file)) scope.postgres = true;
		}
		if (["@repo/ui", "@repo/i18n", "@repo/tailwind-config"].includes(owner.name)) {
			scope.admin = true;
			scope.media = true;
		}
		if (owner.name === "@repo/e2e-media") scope.media = true;
	}
	scope.units = [...units].sort((left, right) => left.localeCompare(right));
	return scope;
}

export function changedFiles(eventName, event, git) {
	if (eventName === "workflow_dispatch") return null;
	const base = eventName === "pull_request" ? event.pull_request?.base?.sha : event.before;
	const head = eventName === "pull_request" ? event.pull_request?.head?.sha : event.after;
	if (!/^[a-f0-9]{40}$/.test(base ?? "") || /^0+$/.test(base) || !/^[a-f0-9]{40}$/.test(head ?? ""))
		return null;
	try {
		// Merge-base for PRs, the full pushed range for pushes. No API pagination limit.
		// Disable rename detection so both the removed and added paths are classified.
		return git([
			"diff",
			"--name-only",
			"--no-renames",
			"-z",
			eventName === "pull_request" ? `${base}...${head}` : base,
			...(eventName === "pull_request" ? [] : [head]),
			"--",
		])
			.split("\0")
			.filter(Boolean);
	} catch {
		return null;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
	const files = changedFiles(process.env.GITHUB_EVENT_NAME, event, (args) =>
		execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }),
	);
	const scope = classifyChanges(files ?? [], readWorkspaces(process.cwd()), files === null);
	const outputs = Object.entries(scope)
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
		.join("\n");
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${outputs}\n`);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(
			process.env.GITHUB_STEP_SUMMARY,
			`## Selected validation\n\nChanged paths: ${files?.length ?? "unknown (full validation)"}\n\n\`\`\`json\n${JSON.stringify(scope, null, 2)}\n\`\`\`\n`,
		);
	console.log(outputs);
}
