import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-prs.yml"), "utf8");
const mockE2e = jobBlock(workflow, "mock-e2e", "supply-chain");

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
assertIncludes(mockE2e, "name: Run immutable upload MinIO regression");
assertIncludes(mockE2e, "run: pnpm --filter @repo/storage test:minio");

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
		throw new Error(`mock-e2e workflow contract is missing: ${expected}`);
	}
}

function assertMatch(value, expected) {
	if (!expected.test(value)) {
		throw new Error(`mock-e2e workflow contract is missing: ${expected.source}`);
	}
}

function assertNotMatch(value, unexpected) {
	if (unexpected.test(value)) {
		throw new Error(`mock-e2e workflow contract must not include: ${unexpected.source}`);
	}
}
