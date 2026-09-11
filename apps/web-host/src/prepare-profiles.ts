import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { deploymentEnvironment, publicBuildVariables } from "./deployment";
import { createProfileArtifacts, deploymentProfile } from "./profiles";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const target = process.argv[2] ?? "production";
if (target !== "production" && target !== "staging")
	throw new Error("EXPECTED_PRODUCTION_OR_STAGING");
const input = Object.fromEntries(
	Object.entries(
		parseEnv(await readFile(path.resolve(root, process.argv[3] ?? `.env.${target}.local`), "utf8")),
	).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);
const profile = deploymentProfile(input);
const canonicalOrigin =
	target === "production" ? "https://ezimageai.com" : input.NEXT_PUBLIC_SAAS_URL;
if (
	!canonicalOrigin ||
	new URL(canonicalOrigin).origin !== canonicalOrigin ||
	!canonicalOrigin.startsWith("https://")
)
	throw new Error("INVALID_CANONICAL_ORIGIN");
const environment = deploymentEnvironment(input, canonicalOrigin);
const readConfig = async (filename: string) =>
	JSON.parse(await readFile(path.join(root, filename), "utf8")) as Record<string, unknown>;
const artifacts = createProfileArtifacts({
	root,
	target,
	profile,
	environment,
	canonicalOrigin,
	websiteTemplate: await readConfig("apps/saas/wrangler.jsonc"),
	jobsTemplate: await readConfig(
		`apps/workflows/${profile === "workers" ? "wrangler.workers.jsonc" : "wrangler.jsonc"}`,
	),
});
const directory = path.join(root, ".wrangler/deploy", target, profile);
await mkdir(directory, { recursive: true });
for (const [name, value] of Object.entries(artifacts)) {
	await writeFile(path.join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
	});
}
await writeFile(
	path.join(directory, "public-build.env"),
	Object.entries(publicBuildVariables(environment))
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
		.join("\n") + "\n",
);
process.stdout.write(
	`Prepared ${profile} configuration in .wrangler/deploy/${target}/${profile}. No resources were deployed.\n`,
);
