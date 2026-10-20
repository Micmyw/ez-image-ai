import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// This client is intentionally dependency-free and can be distributed with the skill.
const TOKEN = /^ez_admin_[A-Za-z0-9_-]{43}$/;
export const storePath = (env = process.env) =>
	env.EZPIC_ADMIN_CONFIG || join(homedir(), ".ezpic", "admin-projects.json");

export function siteUrl(value) {
	const url = new URL(value);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		!["http:", "https:"].includes(url.protocol)
	) {
		throw new Error("Use a site origin without credentials, path, query or fragment.");
	}
	if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
		throw new Error("Remote administration requires HTTPS.");
	}
	return url.origin;
}

function projectName(name) {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name ?? "")) {
		throw new Error("Choose a project name with letters, digits, dots, underscores or hyphens.");
	}
	return name;
}

export async function readStore(env = process.env) {
	try {
		const store = JSON.parse(await readFile(storePath(env), "utf8"));
		if (!store.projects || typeof store.projects !== "object" || Array.isArray(store.projects))
			throw new Error("invalid store");
		return store;
	} catch (error) {
		if (error.code === "ENOENT") return { projects: {} };
		throw new Error("Cannot read the private project store.");
	}
}

async function writeStore(store, env = process.env) {
	const file = storePath(env);
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, file);
}

/** Works with Windows pipes as well as Unix; never uses /dev/stdin. */
export async function readStdin(maximum = 1024 * 1024) {
	let value = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		value += chunk;
		if (Buffer.byteLength(value) > maximum) throw new Error("Input is too large.");
	}
	return value;
}

export async function resolveConnection({ project, env = process.env } = {}) {
	const chosen = project || env.EZPIC_ADMIN_PROJECT;
	if (!chosen)
		throw new Error(
			"Select this site's project explicitly with --project NAME or EZPIC_ADMIN_PROJECT.",
		);
	projectName(chosen);
	if (env.EZPIC_ADMIN_PROJECT === chosen && (env.EZPIC_ADMIN_URL || env.EZPIC_ADMIN_TOKEN)) {
		if (!env.EZPIC_ADMIN_URL || !TOKEN.test(env.EZPIC_ADMIN_TOKEN ?? ""))
			throw new Error("Set the named project's URL and management token together.");
		return { project: chosen, baseUrl: siteUrl(env.EZPIC_ADMIN_URL), token: env.EZPIC_ADMIN_TOKEN };
	}
	const store = await readStore(env);
	const entry = Object.hasOwn(store.projects, chosen) ? store.projects[chosen] : null;
	if (!entry || !TOKEN.test(entry.token ?? ""))
		throw new Error("Unknown project or invalid saved credential.");
	return { project: chosen, baseUrl: siteUrl(entry.url), token: entry.token };
}

export async function adminRequest(path, body, connection) {
	connection ??= await resolveConnection();
	if (!/^\/api\/admin\/agent\/[a-z-]+(?:\?[^#]*)?$/.test(path))
		throw new Error("Unsupported administration path.");
	const response = await fetch(`${connection.baseUrl}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			Authorization: `Bearer ${connection.token}`,
			Accept: "application/json, text/event-stream",
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		redirect: "manual",
		signal: AbortSignal.timeout(120_000),
	});
	if (response.status >= 300 && response.status < 400)
		throw new Error("Administration redirects are refused; verify the saved site origin.");
	const text = await response.text();
	if (Buffer.byteLength(text) > 4 * 1024 * 1024)
		throw new Error("Administration response is too large.");
	let result;
	try {
		result = text ? JSON.parse(text) : null;
	} catch {
		throw new Error("The site returned an invalid JSON response.");
	}
	return { status: response.status, result };
}

export async function addProject(name, url, token, env = process.env) {
	projectName(name);
	token = token.trim();
	if (!TOKEN.test(token)) throw new Error("Pass a management token beginning ez_admin_ on stdin.");
	const connection = { project: name, baseUrl: siteUrl(url), token };
	const check = await adminRequest("/api/admin/agent/operations", undefined, connection);
	if (check.status !== 200 || !Array.isArray(check.result?.operations))
		throw new Error("The site rejected the credential; nothing was saved.");
	const store = await readStore(env);
	store.projects[name] = { url: connection.baseUrl, token };
	await writeStore(store, env);
	return { project: name, url: connection.baseUrl, operations: check.result.operations.length };
}

export function redactTokens(value) {
	return JSON.stringify(value, (_key, item) =>
		typeof item === "string" ? item.replace(/ez_admin_[A-Za-z0-9_-]{43}/g, "[REDACTED]") : item,
	);
}

export function commandArguments(argv = process.argv.slice(2)) {
	const args = [...argv];
	let project;
	const at = args.findIndex((item) => item === "--project");
	if (at !== -1) {
		project = args[at + 1];
		if (!project) throw new Error("--project requires a name.");
		args.splice(at, 2);
	}
	return { project, args };
}

async function main() {
	const { project, args } = commandArguments();
	const [command, first, second, third] = args;
	if (!command || command === "help") {
		process.stdout.write(`EzPic administrator client (Node 22+)
  --project NAME list | openapi | audit
  --project NAME call OPERATION INPUT.json [IDEMPOTENCY_KEY]
  add NAME URL       (token from stdin, verified before saving)
  projects
  remove NAME
Use '-' for INPUT.json to read JSON from stdin. Every call selects a project.
Environment: EZPIC_ADMIN_PROJECT, EZPIC_ADMIN_URL, EZPIC_ADMIN_TOKEN.
Private store: EZPIC_ADMIN_CONFIG or ~/.ezpic/admin-projects.json.
`);
		return;
	}
	if (command === "add") {
		process.stdout.write(
			`${redactTokens(await addProject(first, second, await readStdin(1024)))}\n`,
		);
		return;
	}
	if (command === "projects") {
		const store = await readStore();
		process.stdout.write(
			`${redactTokens(Object.entries(store.projects).map(([name, value]) => ({ name, url: value.url, credential: "saved" })))}\n`,
		);
		return;
	}
	if (command === "remove") {
		const store = await readStore();
		if (!Object.hasOwn(store.projects, projectName(first))) throw new Error("Unknown project.");
		delete store.projects[first];
		await writeStore(store);
		process.stdout.write('{"removed":true}\n');
		return;
	}
	const connection = await resolveConnection({ project });
	let response;
	if (["list", "openapi", "audit"].includes(command)) {
		response = await adminRequest(
			`/api/admin/agent/${command === "list" ? "operations" : command}`,
			undefined,
			connection,
		);
	} else if (command === "call" && first && second) {
		const source = second === "-" ? await readStdin() : await readFile(second, "utf8");
		response = await adminRequest(
			"/api/admin/agent/execute",
			{
				operation: first,
				input: JSON.parse(source),
				...(third ? { idempotencyKey: third } : {}),
			},
			connection,
		);
	} else throw new Error("Invalid command. Run help.");
	process.stdout.write(`${redactTokens(response.result)}\n`);
	if (response.status >= 400 || response.result?.error) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(() => {
		// Neither arbitrary server errors nor credentials ever enter diagnostics.
		process.stderr.write(
			"Admin request failed. Check project selection, input and credentials. For an uncertain write, inspect its original execution; never switch to a new idempotency key.\n",
		);
		process.exitCode = 1;
	});
}
