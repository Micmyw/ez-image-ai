import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { clearEmbeddedEnvironment } from "./artifact-safety.mjs";

const directories = [];
const fixturePrefix = path.resolve(tmpdir(), "ezpic-opennext-env-");

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		if (!path.resolve(directory).startsWith(fixturePrefix)) throw new Error("INVALID_FIXTURE_PATH");
		await rm(directory, { recursive: true, force: true });
	}
});

async function fixture(initializer) {
	const directory = await mkdtemp(fixturePrefix);
	directories.push(directory);
	const output = path.join(directory, ".open-next/cloudflare");
	await mkdir(output, { recursive: true });
	await writeFile(
		path.join(output, "next-env.mjs"),
		'export const production = { DATABASE_URL: "private-fixture-value" };',
	);
	await writeFile(path.join(output, "init.js"), initializer);
	return { directory, output };
}

describe("OpenNext runtime environment artifact", () => {
	it("removes embedded local secrets before Wrangler can bundle the runtime", async () => {
		const { directory, output } = await fixture('import * as nextEnvVars from "./next-env.mjs";');
		await clearEmbeddedEnvironment(directory);
		const source = await readFile(path.join(output, "next-env.mjs"), "utf8");
		expect(source).not.toContain("private-fixture-value");
		expect(source).not.toContain("DATABASE_URL");
		const values = await import(`data:text/javascript,${encodeURIComponent(source)}`);
		expect(values.production).toEqual({});
		expect(values.development).toEqual({});
		expect(values.test).toEqual({});
	});

	it("fails closed if an adapter update inlines environment values into the initializer", async () => {
		const { directory, output } = await fixture(
			'const nextEnvVars = { DATABASE_URL: "private-fixture-value" };',
		);
		await expect(clearEmbeddedEnvironment(directory)).rejects.toThrow(
			"OPENNEXT_ENVIRONMENT_LAYOUT_CHANGED",
		);
		const source = await readFile(path.join(output, "next-env.mjs"), "utf8");
		expect(source).not.toContain("private-fixture-value");
	});
});
