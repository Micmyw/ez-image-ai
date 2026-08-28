import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { scanPublicUiRoots } from "./verify-public-ui-originality.mjs";

void test("scans nested deployed Markdown and SVG while excluding binary artifacts", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "ezpic-public-originality-"));
	try {
		await mkdir(path.join(root, "nested"), { recursive: true });
		await Promise.all([
			writeFile(path.join(root, "nested", "leak.md"), "Competitor: Raphael", "utf8"),
			writeFile(
				path.join(root, "nested", "leak.svg"),
				'<svg><image href="https://foreign.example/borrowed.png"/></svg>',
				"utf8",
			),
			writeFile(path.join(root, "original.txt"), "EzPic original public note", "utf8"),
			writeFile(path.join(root, "ignored.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47])),
		]);

		const findings = await scanPublicUiRoots([root]);

		assert.ok(findings.some((finding) => finding.kind === "competitor-name"));
		assert.ok(findings.some((finding) => finding.kind === "foreign-hotlink"));
		assert.ok(findings.every((finding) => !finding.file.endsWith("ignored.png")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
