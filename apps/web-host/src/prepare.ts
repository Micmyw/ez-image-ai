import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { deploymentEnvironment, publicBuildVariables } from "./deployment";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const target = process.argv[2] ?? "production";
if (target !== "production" && target !== "staging")
	throw new Error("EXPECTED_PRODUCTION_OR_STAGING");
const envFile = path.resolve(root, process.argv[3] ?? `.env.${target}.local`);
const input = Object.fromEntries(
	Object.entries(parseEnv(await readFile(envFile, "utf8"))).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string",
	),
);
const webFile = path.join(root, "apps/web-host/wrangler.jsonc");
const web = JSON.parse(await readFile(webFile, "utf8"));
const canonicalOrigin: string = web.env[target].vars.CANONICAL_ORIGIN;
const environment = deploymentEnvironment(input, canonicalOrigin);
const required = [
	"DATABASE_URL",
	"BETTER_AUTH_SECRET",
	"WORKFLOWS_DISPATCH_SECRET",
	"WORKFLOWS_DISPATCH_URL",
];
const missing = required.filter((key) => !environment[key]);
if (missing.length) throw new Error(`MISSING_RUNTIME_VARIABLES: ${missing.join(", ")}`);
if (environment.BETTER_AUTH_SECRET.length < 32 || environment.WORKFLOWS_DISPATCH_SECRET.length < 32)
	throw new Error("RUNTIME_SECRET_TOO_SHORT");
try {
	const dispatch = new URL(environment.WORKFLOWS_DISPATCH_URL);
	if (
		dispatch.protocol !== "https:" ||
		dispatch.pathname !== "/internal/dispatch" ||
		dispatch.username ||
		dispatch.password ||
		dispatch.search ||
		dispatch.hash
	)
		throw new Error();
} catch {
	throw new Error("INVALID_WORKFLOWS_DISPATCH_URL");
}
if (
	environment.MEDIA_ALLOW_TEST_SAFETY_ADAPTER !== "false" ||
	environment.MEDIA_PROVIDER_ADAPTER === "mock" ||
	environment.MEDIA_SAFETY_ADAPTER === "test"
)
	throw new Error("PRODUCTION_TEST_ADAPTER_FORBIDDEN");

const directory = path.join(root, ".wrangler/deploy", target);
await mkdir(directory, { recursive: true });
for (const [app, secretName] of [
	["web-host", "WEB_RUNTIME_ENV"],
	["workflows", "JOBS_RUNTIME_ENV"],
] as const) {
	const source = path.join(root, "apps", app, "wrangler.jsonc");
	const base = JSON.parse(await readFile(source, "utf8"));
	const config = { ...base, ...base.env[target] };
	delete config.env;
	delete config.$schema;
	config.main = path.resolve(path.dirname(source), base.main);
	config.containers = config.containers.map(
		(container: { image: string; image_build_context: string }) => ({
			...container,
			image: path.resolve(path.dirname(source), container.image),
			image_build_context: root,
			...(app === "web-host" ? { image_vars: publicBuildVariables(environment) } : {}),
		}),
	);
	await writeFile(path.join(directory, `${app}.json`), `${JSON.stringify(config, null, 2)}\n`);
	const secrets: Record<string, string> = { [secretName]: JSON.stringify(environment) };
	if (app === "workflows") {
		secrets.WORKFLOWS_DISPATCH_SECRET = environment.WORKFLOWS_DISPATCH_SECRET;
		secrets.WORKFLOWS_DISPATCH_URL = environment.WORKFLOWS_DISPATCH_URL;
	}
	await writeFile(path.join(directory, `${app}.secrets.json`), `${JSON.stringify(secrets)}\n`, {
		mode: 0o600,
	});
}
const integrations = [
	"S3_ACCESS_KEY_ID",
	"S3_SECRET_ACCESS_KEY",
	"KIE_API_KEY",
	"SIGHTENGINE_API_USER",
	"SIGHTENGINE_API_SECRET",
	"MAIL_FROM",
];
process.stdout.write(
	`Prepared ${target} configuration in .wrangler/deploy/${target}. Secret values were not printed.\n`,
);
process.stdout.write(
	`Unconfigured integrations: ${integrations.filter((key) => !environment[key]).join(", ") || "none"}\n`,
);
process.stdout.write(
	`Generation=${environment.MEDIA_GENERATION_ENABLED}; billing=${environment.BILLING_ENABLED}; guest=${environment.GUEST_MEDIA_ENABLED}. Full launch certification remains a separate gate.\n`,
);
