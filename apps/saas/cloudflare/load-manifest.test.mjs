import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const app = fileURLToPath(new URL("../", import.meta.url));
const packageDirectory = path.dirname(
	realpathSync(path.join(app, "node_modules/@opennextjs/cloudflare/package.json")),
);
const { inlineLoadManifest } = await import(
	pathToFileURL(path.join(packageDirectory, "dist/cli/build/patches/plugins/load-manifest.js")).href
);
const prerender = {
	version: 4,
	preview: {
		previewModeId: "legacy-preview-id",
		previewModeSigningKey: "legacy-signing-key",
		previewModeEncryptionKey: "legacy-encryption-key",
	},
};

async function withManifestLoader(preview, verify) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ezpic-load-manifest-"));
	try {
		const dotNext = path.join(directory, "server-functions/default/apps/saas/.next");
		await mkdir(path.join(dotNext, "server/app/nested"), { recursive: true });
		await writeFile(path.join(dotNext, "prerender-manifest.json"), JSON.stringify(prerender));
		await writeFile(path.join(dotNext, "server/private-config.json"), '{"private":true}');
		await writeFile(path.join(dotNext, "server/app/nested/preview-props.json"), '{"nested":true}');
		if (preview) {
			await writeFile(path.join(dotNext, "server/preview-props.json"), JSON.stringify(preview));
		}
		const plugin = inlineLoadManifest(
			{ updateContent: (_name, entries) => entries[0] },
			{
				outputDir: directory,
				monorepoRoot: directory,
				appBuildOutputPath: path.join(directory, "apps/saas"),
			},
		);
		const source = await plugin.callback({
			contents: `
function loadManifest(filename, options) { throw new Error("Runtime filesystem read"); }
function evalManifest(filename, options) { throw new Error("Runtime filesystem evaluation"); }
`,
		});
		const load = runInNewContext(`${source}\nloadManifest`, {
			process: { env: { NEXT_BUILD_ID: "fixture-build-id" } },
		});
		// Normalize the VM realm without supplying filesystem access to the loader.
		const read = (filename) => JSON.parse(JSON.stringify(load(filename)));
		verify(read);
		assert.throws(() => read("/.next/server/private-config.json"), /Unexpected loadManifest/);
		assert.throws(
			() => read("/.next/server/app/nested/preview-props.json"),
			/Unexpected loadManifest/,
		);
		assert.throws(() => read("/.next/server/preview-props.json.extra"), /Unexpected loadManifest/);
	} finally {
		assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
		assert.ok(path.basename(directory).startsWith("ezpic-load-manifest-"));
		await rm(directory, { recursive: true, force: true });
	}
}

await test("installed manifest patch embeds the exact Next 16.4 server preview properties", async () => {
	const preview = {
		previewModeId: "current-preview-id",
		previewModeSigningKey: "current-signing-key",
		previewModeEncryptionKey: "current-encryption-key",
	};
	await withManifestLoader(preview, (read) => {
		assert.deepEqual(read("/.next/server/preview-props.json"), preview);
		assert.deepEqual(read("/.next/prerender-manifest.json"), prerender);
	});
});

await test("installed manifest patch retains older manifests without inventing preview properties", async () => {
	await withManifestLoader(undefined, (read) => {
		assert.deepEqual(read("/.next/prerender-manifest.json"), prerender);
		assert.deepEqual(read("/.next/react-loadable-manifest.json"), {});
		assert.equal(read("/.next/BUILD_ID"), "fixture-build-id");
		assert.throws(() => read("/.next/server/preview-props.json"), /Unexpected loadManifest/);
	});
});
