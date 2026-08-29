import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-prs.yml"), "utf8");
const integrationRunner = readFileSync(
	resolve(process.cwd(), "tests/load/run-integration.ts"),
	"utf8",
);
const jobsPackage = JSON.parse(
	readFileSync(resolve(process.cwd(), "packages/jobs/package.json"), "utf8"),
);
const jobsDatabaseIntegrationTests = readdirSync(
	resolve(process.cwd(), "packages/jobs/src/handlers"),
)
	.filter((name) => name.endsWith(".database.integration.test.ts"))
	.sort()
	.map((name) => `src/handlers/${name}`);
const gitleaksIgnorePath = resolve(process.cwd(), ".gitleaksignore");
if (!existsSync(gitleaksIgnorePath))
	throw new Error("exact Gitleaks fixture fingerprints are missing");
const gitleaksIgnore = readFileSync(gitleaksIgnorePath, "utf8");
const quality = jobBlock(workflow, "quality", "postgres");
const postgres = jobBlock(workflow, "postgres", "builds");
const builds = jobBlock(workflow, "builds", "mock-e2e");
const mockE2e = jobBlock(workflow, "mock-e2e", "supply-chain");

assertNarrowGitleaksFixtureIgnores(gitleaksIgnore);
assertJobsDatabaseIntegrationCoverage(
	jobsDatabaseIntegrationTests,
	jobsPackage.scripts?.["test:integration"],
	integrationRunner,
);
assertNotMatch(builds, /^ {6}DATABASE_URL:\s*\$\{\{\s*env\./m);
assertPnpmSetupPrecedesNodeCache(workflow);
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
assertStepPrecedes(
	builds,
	"run: pnpm --filter @repo/database generate",
	"run: pnpm --filter saas build",
);
assertStepPrecedes(mockE2e, "run: pnpm --filter @repo/database generate", "run: pnpm e2e:media:ci");

assertIncludes(mockE2e, "name: Start pinned MinIO service");
assertMatch(mockE2e, /minio\/minio:RELEASE\.[0-9T:-]+Z/);
assertNotMatch(mockE2e, /minio\/minio:latest/);
assertIncludes(mockE2e, "--name media-e2e-minio");
assertIncludes(mockE2e, "--publish 127.0.0.1:9000:9000");
assertIncludes(mockE2e, "http://127.0.0.1:9000/minio/health/ready");
assertMatch(mockE2e, /minio\/mc:RELEASE\.[0-9T:-]+Z/);
assertNotMatch(mockE2e, /minio\/mc:latest/);
assertIncludes(mockE2e, "mc mb --ignore-existing local/media-private");
assertIncludes(mockE2e, "mc anonymous set none local/media-private");
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
	const fingerprints = value
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"));
	if (fingerprints.length !== 20) {
		throw new Error("Gitleaks fixture allowlist must contain exactly 20 known fingerprints");
	}
	for (const fingerprint of fingerprints) {
		if (
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
