import { parseEzPicLaunchEvidence, type EzPicLaunchEvidence } from "./launch-evidence";
import {
	assertEzPicEnvironmentMatrixConfigured,
	validateEzPicEnvironmentMatrix,
	validateEzPicLaunchEnvironment,
	type EzPicLaunchEnvironment,
} from "./production-launch";

export type EzPicCertificationStatus = "PASS" | "NOT_COMPLETED";
export type EzPicCertificationCheckId =
	| "launch-environment"
	| "environment-isolation"
	| "staging-scenarios"
	| "deployment-revision";

export interface EzPicCertificationCheck {
	id: EzPicCertificationCheckId;
	status: EzPicCertificationStatus;
	evidence: string;
}

export interface EzPicProductionCertification {
	version: 1;
	status: EzPicCertificationStatus;
	checks: EzPicCertificationCheck[];
}

export function buildEzPicProductionCertification(input: {
	environment: Record<string, unknown>;
	matrix: unknown;
	evidence: unknown;
}): EzPicProductionCertification {
	let launchEnvironment: EzPicLaunchEnvironment | undefined;
	let launchEvidence: EzPicLaunchEvidence | undefined;
	const checks: EzPicCertificationCheck[] = [];

	try {
		launchEnvironment = validateEzPicLaunchEnvironment(input.environment);
		checks.push({
			id: "launch-environment",
			status: "PASS",
			evidence: `${launchEnvironment.environment}:${launchEnvironment.environmentId}:${launchEnvironment.deploymentVersion}`,
		});
	} catch (error) {
		checks.push(notCompleted("launch-environment", error));
	}

	try {
		const matrix = validateEzPicEnvironmentMatrix(input.matrix);
		assertEzPicEnvironmentMatrixConfigured(matrix);
		checks.push({
			id: "environment-isolation",
			status: "PASS",
			evidence: "development, test, staging, and production resource identifiers are distinct",
		});
	} catch (error) {
		checks.push(notCompleted("environment-isolation", error));
	}

	try {
		launchEvidence = parseEzPicLaunchEvidence(input.evidence);
		const incomplete = launchEvidence.scenarios
			.filter((scenario) => scenario.status !== "PASS")
			.map((scenario) => scenario.id);
		if (!launchEvidence.deploymentRevision || incomplete.length > 0) {
			throw new Error(
				`NOT_COMPLETED staging scenarios: ${incomplete.join(", ") || "deployment revision missing"}`,
			);
		}
		checks.push({
			id: "staging-scenarios",
			status: "PASS",
			evidence: `20 staging scenarios recorded for ${launchEvidence.deploymentRevision}`,
		});
	} catch (error) {
		checks.push(notCompleted("staging-scenarios", error));
	}

	if (
		launchEnvironment &&
		launchEvidence?.deploymentRevision &&
		launchEnvironment.deploymentVersion === launchEvidence.deploymentRevision
	) {
		checks.push({
			id: "deployment-revision",
			status: "PASS",
			evidence: launchEnvironment.deploymentVersion,
		});
	} else {
		checks.push({
			id: "deployment-revision",
			status: "NOT_COMPLETED",
			evidence:
				"Launch environment and staging evidence do not contain the same deployment revision.",
		});
	}

	return {
		version: 1,
		status: checks.every((check) => check.status === "PASS") ? "PASS" : "NOT_COMPLETED",
		checks,
	};
}

export function assertEzPicProductionCertificationComplete(
	report: EzPicProductionCertification,
): void {
	const incomplete = report.checks.filter((check) => check.status !== "PASS");
	if (report.status !== "PASS" || incomplete.length > 0) {
		throw new Error(
			`EzPic production certification is NOT_COMPLETED: ${incomplete
				.map((check) => check.id)
				.join(", ")}`,
		);
	}
}

function notCompleted(id: EzPicCertificationCheckId, error: unknown): EzPicCertificationCheck {
	return { id, status: "NOT_COMPLETED", evidence: safeCertificationError(error) };
}

function safeCertificationError(error: unknown): string {
	const message = error instanceof Error ? error.message : "Validation did not complete";
	return message
		.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s"']+/gi, "[redacted-url]")
		.replace(/\b(?:sk|rk|whsec|phc)_[A-Za-z0-9_-]+\b/g, "[redacted-value]")
		.slice(0, 2_000);
}
