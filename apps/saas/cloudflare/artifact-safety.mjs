import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function clearEmbeddedEnvironment(appDirectory, { requireOutput = true } = {}) {
	const directory = path.join(appDirectory, ".open-next/cloudflare");
	const environmentFile = path.join(directory, "next-env.mjs");
	try {
		await readFile(environmentFile, "utf8");
	} catch (error) {
		if (!requireOutput && error?.code === "ENOENT") return;
		throw error;
	}
	// OpenNext reads root/app .env files, including local secrets. Runtime values
	// must come from Worker bindings; Next already inlines public build values.
	await writeFile(
		environmentFile,
		"export const production = {};\nexport const development = {};\nexport const test = {};\n",
	);
	const initializerFile = path.join(directory, "init.js");
	const initializer = await readFile(initializerFile, "utf8");
	if (!/from\s+["']\.\/next-env\.mjs["']/.test(initializer)) {
		await writeFile(initializerFile, 'throw new Error("OPENNEXT_ENVIRONMENT_LAYOUT_CHANGED");\n');
		throw new Error("OPENNEXT_ENVIRONMENT_LAYOUT_CHANGED");
	}
}
