import { createRequire } from "node:module";
import path from "node:path";

import { expect, it } from "vitest";
import type { Vite } from "vitest/node";

// Use the bundler installed with this test runner; no application dependency is needed.
const { build } = createRequire(import.meta.resolve("vitest/node"))("vite") as typeof Vite;

it("keeps upload transport and hashing outside the initial guest capability import graph", async () => {
	const result = await build({
		configFile: false,
		logLevel: "silent",
		build: {
			write: false,
			minify: false,
			rollupOptions: {
				input: path.join(import.meta.dirname, "guest-draft-client.ts"),
				preserveEntrySignatures: "strict",
			},
		},
	});
	if (Array.isArray(result) || !("output" in result)) throw new Error("Expected one bundle");
	const chunks = result.output.filter((entry) => entry.type === "chunk");
	const entry = chunks.find((chunk) => chunk.isEntry);
	if (!entry) throw new Error("Missing guest client entry");
	const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
	const initial = new Set<string>();
	function visit(fileName: string) {
		if (initial.has(fileName)) return;
		initial.add(fileName);
		for (const imported of byName.get(fileName)?.imports ?? []) visit(imported);
	}
	visit(entry.fileName);
	const initialCode = chunks
		.filter((chunk) => initial.has(chunk.fileName))
		.map((chunk) => chunk.code)
		.join("\n");
	const deferredCode = chunks
		.filter((chunk) => !initial.has(chunk.fileName))
		.map((chunk) => chunk.code)
		.join("\n");

	// These are real browser work, independent of source filenames or chosen module boundaries.
	expect(initialCode).toContain("/api/media/guest-capability");
	expect(initialCode).toContain("SOURCE_IMAGE_TOO_LARGE");
	for (const protocol of [
		"/api/media/guest-drafts/upload-intents",
		"/api/media/guest-drafts/upload-completions",
		"SHA-256",
		"XMLHttpRequest",
	]) {
		expect(initialCode.includes(protocol), `${protocol} must wait for an upload action`).toBe(
			false,
		);
		expect(deferredCode.includes(protocol), `${protocol} must remain available after loading`).toBe(
			true,
		);
	}
});
