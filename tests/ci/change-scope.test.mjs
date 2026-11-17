import assert from "node:assert/strict";
import { test } from "node:test";

import { changedFiles, classifyChanges, readWorkspaces } from "./change-scope.mjs";

const workspaces = readWorkspaces(process.cwd());
const scope = (...files) => classifyChanges(files, workspaces);

void test("internal documentation has no build, database, runtime or browser work", () => {
	assert.deepEqual(scope("docs/operations/release.md", "agents.md"), {
		code: false,
		builds: false,
		postgres: false,
		admin: false,
		media: false,
		runtime: false,
		full: false,
		units: [],
	});
});
void test("public copy, artwork and styles select only site checks", () => {
	for (const file of [
		"apps/saas/content/blog/post.mdx",
		"apps/saas/public/images/example.webp",
		"apps/saas/app/globals.css",
		"apps/saas/modules/marketing/components/Footer.tsx",
	]) {
		const result = scope(file);
		assert.equal(result.builds, true);
		assert.deepEqual(result.units, ["saas"]);
		for (const gate of ["postgres", "runtime", "admin", "media"])
			assert.equal(result[gate], false, `${file}: ${gate}`);
	}
});
void test("GTA and the shared composer retain media browser coverage without database tests", () => {
	for (const file of [
		"apps/saas/modules/gta/components/GtaWorkbench.tsx",
		"apps/saas/modules/media/components/GenerationForm.tsx",
	]) {
		const result = scope(file);
		assert.equal(result.media, true);
		assert.equal(result.postgres, false);
		assert.equal(result.runtime, false);
		assert.equal(result.admin, false);
	}
});
void test("payment, entitlement, auth, storage and database changes retain financial and browser gates", () => {
	for (const file of [
		"packages/payments/provider/stripe.ts",
		"packages/config/image-pass.ts",
		"packages/auth/config.ts",
		"packages/storage/provider/s3.ts",
		"packages/database/prisma/migrations/new/migration.sql",
		"packages/api/modules/media/router.ts",
	]) {
		const result = scope(file);
		assert.equal(result.postgres, true, file);
		assert.equal(result.media, true, file);
		assert.equal(result.admin, true, file);
		assert.ok(result.units.includes("saas"), `${file} includes reverse dependencies`);
	}
});
void test("runtime code and the site bundler retain workerd artifact validation", () => {
	for (const file of [
		"apps/workflows/src/index.ts",
		"packages/jobs/src/handlers/dispatch.ts",
		"apps/saas/cloudflare/build.mjs",
		"apps/saas/wrangler.jsonc",
	])
		assert.equal(scope(file).runtime, true, file);
});
void test("public route entrypoints and shared layouts retain browser validation", () => {
	for (const file of [
		"apps/saas/app/(public)/create/page.tsx",
		"apps/saas/app/(public)/layout.tsx",
		"apps/saas/proxy.ts",
	]) {
		assert.equal(scope(file).media, true, file);
	}
});
void test("backend unit-test corrections do not redeploy or rebuild unrelated artifacts", () => {
	assert.deepEqual(scope("packages/config/image-pass.test.ts").units, ["@repo/config"]);
	const result = scope(
		"packages/database/prisma/queries/media/image-passes.sql.integration.test.ts",
	);
	assert.equal(result.postgres, true);
	assert.equal(result.builds, false);
	assert.equal(result.runtime, false);
});
void test("unknown paths, dependency updates, CI edits and manual runs select full validation", () => {
	for (const file of [
		"new-service/index.ts",
		"pnpm-lock.yaml",
		"apps/saas/package.json",
		".github/workflows/validate-prs.yml",
		"tests/ci/change-scope.mjs",
	])
		assert.equal(scope(file).full, true, file);
	assert.equal(classifyChanges([], workspaces, true).full, true);
});
void test("mixed changes retain all requested gates", () => {
	const result = scope(
		"docs/operations/release.md",
		"packages/config/image-pass.ts",
		"apps/saas/public/images/example.webp",
	);
	assert.equal(result.postgres, true);
	assert.equal(result.media, true);
});
void test("push uses the entire pushed range and PR uses the merge base, with rename sides preserved", () => {
	const base = "a".repeat(40),
		head = "b".repeat(40);
	const calls = [];
	const git = (args) => {
		calls.push(args);
		return "packages/config/image-pass.ts\0docs/moved.md\0";
	};
	assert.equal(changedFiles("push", { before: base, after: head }, git).length, 2);
	changedFiles("pull_request", { pull_request: { base: { sha: base }, head: { sha: head } } }, git);
	assert.ok(calls[0].includes(base) && calls[0].includes(head));
	assert.ok(calls[1].includes(`${base}...${head}`));
	assert.ok(calls.every((args) => args.includes("--no-renames") && args.includes("-z")));
});
void test("missing Git history and initial pushes request full validation", () => {
	const fail = () => {
		throw new Error("missing object");
	};
	assert.equal(changedFiles("push", { before: "a".repeat(40), after: "b".repeat(40) }, fail), null);
	assert.equal(changedFiles("push", { before: "0".repeat(40), after: "b".repeat(40) }, fail), null);
	assert.equal(changedFiles("workflow_dispatch", {}, fail), null);
});
