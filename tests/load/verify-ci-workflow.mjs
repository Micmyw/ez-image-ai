import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-prs.yml"), "utf8");
const providerSmokeWorkflow = readFileSync(
	resolve(process.cwd(), ".github/workflows/provider-smoke.yml"),
	"utf8",
);
const rootPackage = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
const unitContracts = readFileSync(
	resolve(process.cwd(), "tests/load/run-unit-contracts.ts"),
	"utf8",
);
const integrationRunner = readFileSync(
	resolve(process.cwd(), "tests/load/run-integration.ts"),
	"utf8",
);
const jobsPackage = JSON.parse(
	readFileSync(resolve(process.cwd(), "packages/jobs/package.json"), "utf8"),
);
const storagePackage = JSON.parse(
	readFileSync(resolve(process.cwd(), "packages/storage/package.json"), "utf8"),
);
const jobsDatabaseIntegrationTests = ["handlers", "video-v1"]
	.flatMap((directory) =>
		readdirSync(resolve(process.cwd(), "packages/jobs/src", directory))
			.filter((name) => name.endsWith(".database.integration.test.ts"))
			.map((name) => `src/${directory}/${name}`),
	)
	.sort();
const gitleaksIgnorePath = resolve(process.cwd(), ".gitleaksignore");
if (!existsSync(gitleaksIgnorePath))
	throw new Error("exact Gitleaks fixture fingerprints are missing");
const gitleaksIgnore = readFileSync(gitleaksIgnorePath, "utf8");
const quality = jobBlock(workflow, "quality", "postgres");
const postgres = jobBlock(workflow, "postgres", "builds");
const builds = jobBlock(workflow, "builds", "mock-e2e");
const mockE2e = jobBlock(workflow, "mock-e2e", "supply-chain");

for (const workflowFile of readdirSync(resolve(process.cwd(), ".github/workflows"))) {
	if (!/\.ya?ml$/.test(workflowFile)) continue;
	const workflowText = readFileSync(
		resolve(process.cwd(), ".github/workflows", workflowFile),
		"utf8",
	);
	assertNotMatch(
		workflowText,
		/^\s*(?:MEDIA_SAFETY_ADAPTER|VIDEO_V1_(?:TEXT|IMAGE|VIDEO)_SAFETY_ADAPTER):\s*["']?sightengine\b/im,
	);
}
assertIncludes(quality, "          MEDIA_SAFETY_ADAPTER: configured");
assertIncludes(quality, '          MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "false"');
assertIncludes(builds, "      MEDIA_SAFETY_ADAPTER: configured");
assertIncludes(builds, '      MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "false"');

assertNarrowGitleaksFixtureIgnores(gitleaksIgnore);
assertJobsDatabaseIntegrationCoverage(
	jobsDatabaseIntegrationTests,
	jobsPackage.scripts?.["test:integration"],
	integrationRunner,
);
assertSaasOnlyRepository(rootPackage.scripts, workflow, unitContracts);
for (const command of ["workflows:type-check", "workflows:build:ci"]) {
	if (typeof rootPackage.scripts?.[command] !== "string") {
		throw new Error(`Cloudflare orchestration command is missing: ${command}`);
	}
	assertUnconditionalStep(quality, `pnpm ${command}`);
}
assertNotMatch(quality, /TRIGGER_|pnpm trigger:/);
for (const workspace of ["@repo/workflows", "@repo/jobs-runtime", "@repo/auth"]) {
	assertIncludes(unitContracts, `"--filter", "${workspace}", "test"`);
}
assertNotMatch(builds, /^ {6}DATABASE_URL:\s*\$\{\{\s*env\./m);
assertPnpmSetupPrecedesNodeCache(workflow);
assertPnpmSetupPrecedesNodeCache(providerSmokeWorkflow);
assertIncludes(workflow, "  push:\n    branches: [main]");
assertStepPrecedes(
	quality,
	"run: pnpm --filter @repo/database generate",
	"run: pnpm lint --deny-warnings",
);
assertStepPrecedes(
	postgres,
	"run: pnpm --filter @repo/database generate",
	"run: pnpm test:integration",
);
assertIncludes(postgres, "      video-postgres:");
assertIncludes(postgres, "      guest-postgres:");
assertIncludes(postgres, "          POSTGRES_DB: ai_media_guest_test");
assertIncludes(postgres, "          - 55440:5432");
assertIncludes(
	postgres,
	"GUEST_TEST_DATABASE_URL: postgresql://ai_media_test:ai_media_test_only@127.0.0.1:55440/ai_media_guest_test",
);
assertIncludes(postgres, "DATABASE_URL: ${{ env.GUEST_TEST_DATABASE_URL }}");
assertStepPrecedes(
	postgres,
	"name: Apply migrations to the isolated guest database",
	"run: pnpm test:integration",
);
assertUnconditionalStep(quality, "pnpm exec tsx --test tests/load/run-integration.test.ts");
assertUnconditionalStep(quality, "node --test tests/video-v1/local-command.test.mjs");
assertIncludes(
	integrationRunner,
	"isExplicitGuestVerificationTarget(new URL(guestTestDatabaseUrl))",
);
assertIncludes(
	integrationRunner,
	"assertDistinctDatabaseTargets([...databaseTargets, new URL(videoTestDatabaseUrl)])",
);
assertNotMatch(integrationRunner, /GUEST_TEST_DATABASE_URL\s*\?\?/);
assertIncludes(
	integrationRunner,
	'"prisma/queries/media/admin-growth-operations.integration.test.ts"',
);
assertIncludes(integrationRunner, "runtimeDatabaseAlias(guestTestDatabaseUrl)");
assertIncludes(postgres, "name: Verify data invariants\n        run: pnpm verify:invariants");
assertIncludes(
	postgres,
	"name: Verify isolated guest data invariants\n        env:\n          TEST_DATABASE_URL: ${{ env.GUEST_TEST_DATABASE_URL }}\n        run: pnpm verify:invariants",
);
assertStepPrecedes(postgres, "run: pnpm test:integration", "name: Verify data invariants");
assertStepPrecedes(
	postgres,
	"run: pnpm test:integration",
	"name: Verify isolated guest data invariants",
);
assertIncludes(postgres, "          POSTGRES_DB: ezpic_video_v1_final_test");
assertIncludes(postgres, "          - 55439:5432");
assertIncludes(
	postgres,
	"VIDEO_VERIFICATION_DATABASE_URL: postgresql://ai_media_test:ai_media_test_only@127.0.0.1:55439/ezpic_video_v1_final_test",
);
assertIncludes(postgres, "DATABASE_URL: ${{ env.VIDEO_VERIFICATION_DATABASE_URL }}");
assertStepPrecedes(
	postgres,
	"name: Apply migrations to the isolated video invariant database",
	"run: pnpm test:integration",
);
assertIncludes(
	integrationRunner,
	'"prisma/queries/media/video-v1-seeapi-handoff-invariant.integration.test.ts"',
);
assertIncludes(integrationRunner, "...isolatedVideoDatabaseTests,");
assertIncludes(
	integrationRunner,
	"isExplicitVideoVerificationTarget(new URL(videoTestDatabaseUrl))",
);
assertStepPrecedes(
	builds,
	"run: pnpm --filter @repo/database generate",
	"run: pnpm --filter saas build",
);
assertStepPrecedes(mockE2e, "run: pnpm --filter @repo/database generate", "run: pnpm e2e:media:ci");
const videoUiCommand = "pnpm --filter @repo/e2e-media run e2e --video-ui";
assertUnconditionalStep(mockE2e, videoUiCommand);
assertStepPrecedes(mockE2e, "run: pnpm e2e:media:ci", `run: ${videoUiCommand}`);
assertStepPrecedes(mockE2e, `run: ${videoUiCommand}`, "name: Stop task-owned MinIO service");
assertIncludes(mockE2e, 'VIDEO_V1_ENABLED: "false"');
assertIncludes(mockE2e, 'VIDEO_TEST_ALLOW_FONT_DOWNLOADS: "true"');
assertIncludes(
	mockE2e,
	'NODE_OPTIONS: "--import=${{ github.workspace }}/tests/video-v1/no-paid-network.mjs"',
);
assertIncludes(mockE2e, "name: Upload video V1 Playwright evidence");
assertIncludes(mockE2e, "name: playwright-video-v1");
assertIncludes(mockE2e, ".cache/video-v1/browser-report.json");
assertIncludes(mockE2e, ".cache/video-v1/browser-results/**");
assertIncludes(mockE2e, "include-hidden-files: true");

assertIncludes(mockE2e, "name: Start pinned MinIO service");
assertMatch(
	mockE2e,
	/https:\/\/github.com\/minio\/minio\/releases\/download\/RELEASE\.[0-9T:-]+Z\/minio\.linux-amd64\.RELEASE\.[0-9T:-]+Z/,
);
assertNotMatch(mockE2e, /(?:minio|mc):latest|releases\/latest/);
assertIncludes(mockE2e, "53e2a2cb16c5366ea6fbbc479c19ddb4c6a0948273e752f740fb1fbf27bb817c  minio");
assertIncludes(mockE2e, "ac90da87a35641be5a0ac75d49de5161ddb47d629b5ba01261b0ae9e00aea15f  mc");
assertIncludes(mockE2e, "sha256sum --check --strict");
assertStepPrecedes(mockE2e, "sha256sum --check --strict", "chmod +x minio mc");
assertStepPrecedes(
	mockE2e,
	"name: Download verified MinIO release binaries",
	"name: Start pinned MinIO service",
);
assertIncludes(mockE2e, "--address 127.0.0.1:9000 --console-address 127.0.0.1:9001");
assertIncludes(mockE2e, "http://127.0.0.1:9000/minio/health/ready");
assertMatch(
	mockE2e,
	/https:\/\/github.com\/minio\/mc\/releases\/download\/RELEASE\.[0-9T:-]+Z\/mc\.linux-amd64\.RELEASE\.[0-9T:-]+Z/,
);
assertIncludes(mockE2e, "name: Stop task-owned MinIO service");
assertIncludes(mockE2e, "mc mb --ignore-existing local/media-private");
assertIncludes(mockE2e, "mc anonymous set none local/media-private");
assertIncludes(mockE2e, "mc mb --ignore-existing local/video-v1-test");
assertIncludes(mockE2e, "mc anonymous set none local/video-v1-test");
assertIncludes(mockE2e, "MEDIA_BUCKET_NAME: video-v1-test");
assertIncludes(
	storagePackage.scripts?.["test:minio:video"] ?? "",
	"vitest run provider/s3/video-input.minio.integration.test.ts",
);
assertUnconditionalStep(mockE2e, "pnpm --filter @repo/storage test:minio:video");
assertStepPrecedes(
	mockE2e,
	"mc anonymous set none local/video-v1-test",
	"run: pnpm --filter @repo/storage test:minio:video",
);
assertStepPrecedes(
	mockE2e,
	"run: pnpm --filter @repo/storage test:minio:video",
	"name: Stop task-owned MinIO service",
);
assertIncludes(mockE2e, "mc mb --ignore-existing local/avatars");
assertIncludes(mockE2e, "mc anonymous set download local/avatars");
assertIncludes(mockE2e, "S3_ENDPOINT: http://127.0.0.1:9000");
assertIncludes(mockE2e, "S3_REGION: auto");
assertIncludes(mockE2e, "S3_ACCESS_KEY_ID: minioadmin");
assertIncludes(mockE2e, "S3_SECRET_ACCESS_KEY: minioadmin");
assertIncludes(mockE2e, 'E2E_USE_PRODUCTION_BUILD: "true"');
assertIncludes(mockE2e, "name: Run immutable upload MinIO regression");
assertIncludes(mockE2e, "run: pnpm --filter @repo/storage test:minio");
assertIncludes(mockE2e, "run: pnpm --filter saas exec playwright install --with-deps chromium");
assertNotMatch(mockE2e, /run: pnpm --filter @repo\/e2e-media exec playwright install/);
assertNotMatch(mockE2e, /playwright-(?:docs|marketing)|apps\/(?:docs|marketing)\//);

function assertSaasOnlyRepository(scripts, workflowText, unitContractSource) {
	for (const task of ["dev", "build", "start"]) {
		assertIncludes(scripts?.[task] ?? "", `turbo ${task} --filter=saas...`);
	}
	for (const segments of [
		["NEXT", "PUBLIC", "MARKETING", "URL"],
		["NEXT", "PUBLIC", "DOCS", "URL"],
	]) {
		assertNotMatch(workflowText, new RegExp(segments.join("_")));
	}
	for (const legacyApp of ["marketing", "docs"]) {
		if (existsSync(resolve(process.cwd(), "apps", legacyApp))) {
			throw new Error(`retired application directory remains: ${legacyApp}`);
		}
		assertNotMatch(unitContractSource, new RegExp(`--filter["',\\s]+${legacyApp}`));
	}
}

function jobBlock(workflowText, jobName, nextJobName) {
	const start = workflowText.indexOf(`  ${jobName}:\n`);
	const end = workflowText.indexOf(`\n  ${nextJobName}:\n`, start);
	if (start === -1 || end === -1) {
		throw new Error(`Unable to locate ${jobName} workflow job`);
	}
	return workflowText.slice(start, end);
}

function assertIncludes(value, expected) {
	if (!value.includes(expected)) {
		throw new Error(`repository validation contract is missing: ${expected}`);
	}
}

function assertUnconditionalStep(job, command) {
	const commandIndex = job.indexOf(`run: ${command}`);
	if (commandIndex === -1) throw new Error(`workflow build gate is missing: ${command}`);
	const start = job.lastIndexOf("\n      - ", commandIndex);
	const end = job.indexOf("\n      - ", commandIndex);
	const step = job.slice(start, end === -1 ? undefined : end);
	assertNotMatch(step, /^\s+(?:if|continue-on-error):/m);
}

function assertJobsDatabaseIntegrationCoverage(testFiles, packageCommand, rootRunner) {
	if (typeof packageCommand !== "string") {
		throw new Error("@repo/jobs test:integration command is missing");
	}
	for (const testFile of testFiles) {
		assertIncludes(packageCommand, testFile);
		assertIncludes(rootRunner, `"${testFile}"`);
	}
}

function assertMatch(value, expected) {
	if (!expected.test(value)) {
		throw new Error(`mock-e2e workflow contract is missing: ${expected.source}`);
	}
}

function assertNotMatch(value, unexpected) {
	if (unexpected.test(value)) {
		throw new Error(`workflow contract must not include: ${unexpected.source}`);
	}
}

function assertPnpmSetupPrecedesNodeCache(workflowText) {
	const lines = workflowText.split("\n");
	let setupNodeCount = 0;
	for (const [index, line] of lines.entries()) {
		if (line !== "      - uses: actions/setup-node@v4") continue;
		setupNodeCount += 1;
		const previousStep = lines
			.slice(0, index)
			.findLast((candidate) => candidate.startsWith("      - "));
		if (previousStep !== "      - uses: pnpm/action-setup@v4") {
			throw new Error("pnpm/action-setup must run before setup-node enables the pnpm cache");
		}
	}
	if (setupNodeCount === 0) throw new Error("workflow contract is missing setup-node");
}

function assertNarrowGitleaksFixtureIgnores(value) {
	// Public browser placement matches from one exact historical Blog commit.
	const historicalPublicPlacements = new Set([
		"db5ad9d42df21c023adf289a2d5083309b91401f:docs/operations/evidence/blog-ads/sandbox-fixture.html:generic-api-key:53",
		"db5ad9d42df21c023adf289a2d5083309b91401f:apps/saas/modules/public-content/lib/blog-ads.ts:generic-api-key:39",
		"db5ad9d42df21c023adf289a2d5083309b91401f:docs/operations/evidence/blog-ads/csp-390.json:generic-api-key:63",
		"db5ad9d42df21c023adf289a2d5083309b91401f:docs/operations/evidence/blog-ads/csp-390.json:generic-api-key:101",
		"db5ad9d42df21c023adf289a2d5083309b91401f:docs/operations/evidence/blog-ads/csp-390.json:generic-api-key:126",
		"db5ad9d42df21c023adf289a2d5083309b91401f:docs/operations/evidence/blog-ads/sandbox-1280.json:generic-api-key:49",
		"db5ad9d42df21c023adf289a2d5083309b91401f:docs/operations/evidence/blog-ads/sandbox-1280.json:generic-api-key:87",
		"db5ad9d42df21c023adf289a2d5083309b91401f:docs/operations/evidence/blog-ads/sandbox-1280.json:generic-api-key:105",
		"db5ad9d42df21c023adf289a2d5083309b91401f:docs/operations/evidence/blog-ads/csp-1280.json:generic-api-key:67",
		"db5ad9d42df21c023adf289a2d5083309b91401f:docs/operations/evidence/blog-ads/csp-1280.json:generic-api-key:105",
		"db5ad9d42df21c023adf289a2d5083309b91401f:docs/operations/evidence/blog-ads/csp-1280.json:generic-api-key:130",
		"db5ad9d42df21c023adf289a2d5083309b91401f:docs/operations/evidence/blog-ads/sandbox-390.json:generic-api-key:49",
		"db5ad9d42df21c023adf289a2d5083309b91401f:docs/operations/evidence/blog-ads/sandbox-390.json:generic-api-key:87",
		"db5ad9d42df21c023adf289a2d5083309b91401f:docs/operations/evidence/blog-ads/sandbox-390.json:generic-api-key:105",
		"db5ad9d42df21c023adf289a2d5083309b91401f:scripts/blog-ad-observation.mjs:generic-api-key:18",
	]);
	const fingerprints = value
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"));
	const expectedCount = 30 + historicalPublicPlacements.size;
	if (fingerprints.length !== expectedCount || new Set(fingerprints).size !== expectedCount) {
		throw new Error(
			`Gitleaks fixture allowlist must contain exactly ${expectedCount} unique known fingerprints`,
		);
	}
	assertIncludes(
		value,
		"20eb0eac01807f476072dc1bdb5baf6a707ff60d:tooling/e2e/src/scanless-image-callback.test.ts:generic-api-key:23",
	);
	for (const fingerprint of historicalPublicPlacements) {
		if (!fingerprints.includes(fingerprint)) {
			throw new Error(
				"Gitleaks public placement fingerprints must match the exact reviewed history",
			);
		}
	}
	const historicalPlaceholders = new Set([
		"bc30528a157976085b92c6cf322a9cc3009fb42f:packages/payments/provider/registry.test.ts:private-key:77",
		"3f2afe8997748b2c59412e07534324260075573d:docs/operations/anonymous-standard-trial.md:generic-api-key:45",
	]);
	for (const fingerprint of fingerprints) {
		if (
			!historicalPlaceholders.has(fingerprint) &&
			!historicalPublicPlacements.has(fingerprint) &&
			!/^[0-9a-f]{40}:[^:]+\.test\.ts:(?:generic-api-key|stripe-access-token):[0-9]+$/.test(
				fingerprint,
			)
		) {
			throw new Error("Gitleaks fixture allowlist contains a broad or non-test entry");
		}
	}
}

function assertStepPrecedes(job, requiredStep, dependentStep) {
	const requiredIndex = job.indexOf(requiredStep);
	const dependentIndex = job.indexOf(dependentStep);
	if (requiredIndex === -1 || dependentIndex === -1 || requiredIndex >= dependentIndex) {
		throw new Error(`workflow step must precede dependent step: ${requiredStep}`);
	}
}
