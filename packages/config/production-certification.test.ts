import { describe, expect, it } from "vitest";

import { EZPIC_STAGING_SCENARIOS } from "./launch-evidence";
import {
	assertEzPicProductionCertificationComplete,
	buildEzPicProductionCertification,
	type EzPicProductionCertification,
} from "./production-certification";

function incompleteEvidence() {
	return {
		version: 1,
		deploymentRevision: null,
		scenarios: EZPIC_STAGING_SCENARIOS.map((id) => ({
			id,
			status: "NOT_COMPLETED",
			evidence: "Requires a protected staging evidence artifact.",
		})),
	};
}

function placeholderMatrix() {
	return {
		version: 1,
		environments: (["development", "test", "staging", "production"] as const).map(
			(environment) => ({
				environment,
				environmentId: `not-completed/${environment}/environment`,
				resources: {
					database: `not-completed/${environment}/database`,
					mediaBucket: `not-completed/${environment}/bucket`,
					stripeWebhookScope: `not-completed/${environment}/stripe-webhook`,
					triggerEnvironment: `not-completed/${environment}/trigger`,
					posthogProject: `not-completed/${environment}/posthog`,
					sentryEnvironment: `not-completed/${environment}/sentry`,
					mailProvider: `not-completed/${environment}/mail`,
				},
			}),
		),
	};
}

describe("EzPic production certification", () => {
	it("keeps guest launch incomplete until every production guest boundary has recorded evidence", () => {
		const report = buildEzPicProductionCertification({
			environment: {},
			matrix: placeholderMatrix(),
			evidence: incompleteEvidence(),
		});

		expect(report.status).toBe("NOT_COMPLETED");
		expect(
			report.checks
				.filter((check) => check.id.startsWith("guest-"))
				.map(({ id, status }) => ({ id, status })),
		).toEqual([
			{ id: "guest-billed-standard-cost", status: "NOT_COMPLETED" },
			{ id: "guest-provider-hard-budget", status: "NOT_COMPLETED" },
			{ id: "guest-privacy-cleanup", status: "NOT_COMPLETED" },
			{ id: "guest-production-configuration", status: "NOT_COMPLETED" },
		]);
	});

	it("reports every unavailable external boundary as NOT_COMPLETED without echoing secrets", () => {
		const report = buildEzPicProductionCertification({
			environment: {
				NODE_ENV: "production",
				DATABASE_URL: "postgresql://operator:do-not-leak@private.invalid/production",
				BETTER_AUTH_SECRET: "do-not-leak",
			},
			matrix: placeholderMatrix(),
			evidence: incompleteEvidence(),
		});

		expect(report.status).toBe("NOT_COMPLETED");
		expect(report.checks.map((check) => check.id)).toEqual([
			"launch-environment",
			"environment-isolation",
			"staging-scenarios",
			"deployment-revision",
			"guest-billed-standard-cost",
			"guest-provider-hard-budget",
			"guest-privacy-cleanup",
			"guest-production-configuration",
		]);
		expect(report.checks.every((check) => check.status === "NOT_COMPLETED")).toBe(true);
		expect(JSON.stringify(report)).not.toContain("do-not-leak");
		expect(() => assertEzPicProductionCertificationComplete(report)).toThrow(/NOT_COMPLETED/);
	});

	it("accepts only a report whose checks all passed", () => {
		const report: EzPicProductionCertification = {
			version: 1,
			status: "PASS",
			checks: [
				{ id: "launch-environment", status: "PASS", evidence: "validated" },
				{ id: "environment-isolation", status: "PASS", evidence: "validated" },
				{ id: "staging-scenarios", status: "PASS", evidence: "validated" },
				{ id: "deployment-revision", status: "PASS", evidence: "validated" },
				{ id: "guest-billed-standard-cost", status: "PASS", evidence: "validated" },
				{ id: "guest-provider-hard-budget", status: "PASS", evidence: "validated" },
				{ id: "guest-privacy-cleanup", status: "PASS", evidence: "validated" },
				{ id: "guest-production-configuration", status: "PASS", evidence: "validated" },
			],
		};
		expect(() => assertEzPicProductionCertificationComplete(report)).not.toThrow();
	});

	it("rejects a forged PASS report that omits a required guest boundary", () => {
		const report: EzPicProductionCertification = {
			version: 1,
			status: "PASS",
			checks: [
				{ id: "launch-environment", status: "PASS", evidence: "validated" },
				{ id: "environment-isolation", status: "PASS", evidence: "validated" },
				{ id: "staging-scenarios", status: "PASS", evidence: "validated" },
				{ id: "deployment-revision", status: "PASS", evidence: "validated" },
				{ id: "guest-billed-standard-cost", status: "PASS", evidence: "validated" },
				{ id: "guest-provider-hard-budget", status: "PASS", evidence: "validated" },
				{ id: "guest-privacy-cleanup", status: "PASS", evidence: "validated" },
			],
		};

		expect(() => assertEzPicProductionCertificationComplete(report)).toThrow(
			/guest-production-configuration/,
		);
	});
});
