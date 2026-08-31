import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertEzPicProductionEvidenceComplete, parseEzPicLaunchEvidence } from "./launch-evidence";
import {
	assertEzPicEnvironmentMatrixConfigured,
	validateEzPicEnvironmentMatrix,
} from "./production-launch";

const repositoryRoot = resolve(import.meta.dirname, "../..");

describe("EzPic PR 8 launch artifacts", () => {
	it.each([
		[
			"docs/operations/ezpic-production-runbook.md",
			["fail closed", "PostgreSQL", "Trigger.dev", "24–72"],
		],
		[
			"docs/operations/ezpic-launch-checklist.md",
			["PASS", "NOT_COMPLETED", "20 staging scenarios"],
		],
		["docs/operations/ezpic-rollback.md", ["Standard Edit", "Quality Edit", "Outbox", "rollback"]],
		[
			"docs/product/ezpic-final-cost-model.md",
			["providerCostMicros", "Creator", "Studio", "NOT_COMPLETED"],
		],
	] as const)("keeps %s as an executable launch contract", (relativePath, requiredText) => {
		const content = readFileSync(resolve(repositoryRoot, relativePath), "utf8");
		for (const text of requiredText) expect(content).toContain(text);
		expect(content).not.toMatch(/free forever|uncensored|no usage limits|income guarantee/i);
	});

	it("ships guarded certification, evidence, and six-surface k6 entrypoints", () => {
		const k6 = readFileSync(resolve(repositoryRoot, "tests/load/ezpic-production.js"), "utf8");
		for (const scenario of [
			"marketing",
			"upload-concurrency",
			"quote-create",
			"polling",
			"signed-url",
			"admin-aggregate",
		]) {
			expect(k6).toContain(scenario);
		}
		for (const gate of [
			"ALLOW_REMOTE_LOAD_TARGET",
			"LOAD_REMOTE_TARGET_ALLOWLIST",
			"LOAD_TARGET_CONFIRMATION",
			"LOAD_MAX_REQUESTS",
			"LOAD_MAX_EXPECTED_PROVIDER_COST_MICROS",
		]) {
			expect(k6).toContain(gate);
		}

		const launcher = readFileSync(
			resolve(repositoryRoot, "tests/load/ezpic-load-launcher.ts"),
			"utf8",
		);
		expect(launcher).toContain("resolveEzPicProductionLoadPlan");
		expect(launcher).toContain("LOAD_EXECUTION_CONFIRMATION");

		const certification = readFileSync(
			resolve(repositoryRoot, "tests/load/ezpic-production-certification.ts"),
			"utf8",
		);
		expect(certification).toContain("buildEzPicProductionCertification");
		expect(certification).toContain("assertEzPicProductionCertificationComplete");

		const packageJson = JSON.parse(
			readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
		) as { scripts: Record<string, string> };
		expect(packageJson.scripts).toMatchObject({
			"launch:evidence:validate": expect.any(String),
			"launch:certify": expect.any(String),
			"load:ezpic": expect.any(String),
		});
	});

	it("keeps committed launch evidence structurally valid and honestly NOT_COMPLETED", () => {
		const matrix = validateEzPicEnvironmentMatrix(
			JSON.parse(
				readFileSync(
					resolve(
						repositoryRoot,
						"docs/operations/evidence/ezpic-environment-matrix.template.json",
					),
					"utf8",
				),
			),
		);
		expect(() => assertEzPicEnvironmentMatrixConfigured(matrix)).toThrow(/NOT_COMPLETED/);

		const evidence = parseEzPicLaunchEvidence(
			JSON.parse(
				readFileSync(
					resolve(repositoryRoot, "docs/operations/evidence/ezpic-staging-evidence.json"),
					"utf8",
				),
			),
		);
		expect(evidence.scenarios).toHaveLength(20);
		expect(evidence.scenarios.every((scenario) => scenario.status === "NOT_COMPLETED")).toBe(true);
		expect(() => assertEzPicProductionEvidenceComplete(evidence)).toThrow(/NOT_COMPLETED/);
	});

	it("documents every non-secret launch and load contract key", () => {
		const example = readFileSync(resolve(repositoryRoot, ".env.local.example"), "utf8");
		for (const key of [
			"EZPIC_DEPLOYMENT_ENVIRONMENT",
			"EZPIC_ENVIRONMENT_ID",
			"EZPIC_DATABASE_RESOURCE_ID",
			"EZPIC_MEDIA_BUCKET_RESOURCE_ID",
			"EZPIC_STRIPE_WEBHOOK_SCOPE_ID",
			"EZPIC_TRIGGER_ENVIRONMENT_ID",
			"EZPIC_POSTHOG_PROJECT_ID",
			"EZPIC_SENTRY_ENVIRONMENT",
			"EZPIC_MAIL_PROVIDER_ID",
			"EZPIC_GSC_PROPERTY",
			"MEDIA_STANDARD_EDIT_ENABLED",
			"MEDIA_QUALITY_EDIT_ENABLED",
			"MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS",
			"MEDIA_ALERT_ERROR_RATE_BPS",
			"MEDIA_ALERT_P95_LATENCY_MS",
			"MEDIA_ALERT_MODERATION_REJECTION_RATE_BPS",
			"MEDIA_ALERT_CHANNEL_ID",
			"LOAD_REMOTE_TARGET_ALLOWLIST",
			"LOAD_MAX_REQUESTS",
			"LOAD_MAX_ERROR_RATE_BPS",
			"LOAD_MAX_EXPECTED_PROVIDER_COST_MICROS",
			"LOAD_MARKETING_PATH",
			"LOAD_UPLOAD_PATH",
			"LOAD_UPLOAD_ABORT_PATH_TEMPLATE",
			"LOAD_UPLOAD_BODY",
			"LOAD_LOCAL_QUOTE_CREATE_PATH",
			"LOAD_QUOTE_PATH",
			"LOAD_QUOTE_BODY",
			"LOAD_CREATE_PATH",
			"LOAD_CREATE_BODY",
			"LOAD_POLL_PATH_TEMPLATE",
			"LOAD_POLL_JOB_ID",
			"LOAD_SIGNED_URL_PATH_TEMPLATE",
			"LOAD_SIGNED_URL_ASSET_ID",
			"LOAD_ADMIN_AGGREGATE_PATH",
		]) {
			expect(example).toContain(`${key}=`);
		}
	});

	it("keeps the canonical CI database in the exact CI-only integration allowlists", () => {
		for (const relativePath of [
			"packages/database/prisma/queries/media/admin-growth-operations.integration.test.ts",
			"packages/database/prisma/queries/media/free-plan-credits.integration.test.ts",
			"packages/database/prisma/queries/media/effective-subscription.integration.test.ts",
		]) {
			const content = readFileSync(resolve(repositoryRoot, relativePath), "utf8");
			expect(content).toContain("ai_media_foundation_test");
			expect(content).toContain('process.env.CI === "true"');
		}
	});
});
