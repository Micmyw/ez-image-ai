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
	| "deployment-revision"
	| "guest-billed-standard-cost"
	| "guest-provider-hard-budget"
	| "guest-privacy-cleanup"
	| "guest-production-configuration";

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

const REQUIRED_CERTIFICATION_CHECK_IDS = [
	"launch-environment",
	"environment-isolation",
	"staging-scenarios",
	"deployment-revision",
	"guest-billed-standard-cost",
	"guest-provider-hard-budget",
	"guest-privacy-cleanup",
	"guest-production-configuration",
] as const satisfies readonly EzPicCertificationCheckId[];

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

	checks.push(
		guestEvidenceCheck(
			"guest-billed-standard-cost",
			input.environment,
			["GUEST_BILLED_STANDARD_COST_EVIDENCE_ID", "GUEST_BILLED_STANDARD_COST_MICROS"],
			"Real billed Standard cost evidence is not recorded.",
		),
		guestEvidenceCheck(
			"guest-provider-hard-budget",
			input.environment,
			["GUEST_PROVIDER_HARD_BUDGET_EVIDENCE_ID", "GUEST_HARD_BUDGET_MICROS"],
			"Provider hard-budget evidence is not recorded.",
		),
		guestEvidenceCheck(
			"guest-privacy-cleanup",
			input.environment,
			["GUEST_PRIVACY_DISCLOSURE_EVIDENCE_ID", "GUEST_CLEANUP_READINESS_EVIDENCE_ID"],
			"Guest privacy disclosure and cleanup readiness evidence are not both recorded.",
		),
		guestProductionConfigurationCheck(input.environment),
	);

	return {
		version: 1,
		status: checks.every((check) => check.status === "PASS") ? "PASS" : "NOT_COMPLETED",
		checks,
	};
}

function guestEvidenceCheck(
	id: EzPicCertificationCheckId,
	environment: Record<string, unknown>,
	keys: readonly [string, string],
	incompleteEvidence: string,
): EzPicCertificationCheck {
	const [evidenceKey, valueKey] = keys;
	const evidenceId = certificationEvidenceId(environment[evidenceKey]);
	const value = environment[valueKey];
	const valueRecorded = valueKey.endsWith("_MICROS")
		? positiveIntegerString(value) !== null
		: certificationEvidenceId(value) !== null;
	return evidenceId && valueRecorded
		? { id, status: "PASS", evidence: evidenceId }
		: { id, status: "NOT_COMPLETED", evidence: incompleteEvidence };
}

function guestProductionConfigurationCheck(
	environment: Record<string, unknown>,
): EzPicCertificationCheck {
	const evidenceId = certificationEvidenceId(
		environment.GUEST_PRODUCTION_CONFIGURATION_EVIDENCE_ID,
	);
	const runtimeEvidenceId = certificationEvidenceId(environment.GUEST_RUNTIME_OVERRIDE_EVIDENCE_ID);
	const complete =
		environment.NODE_ENV === "production" &&
		environment.GUEST_MEDIA_ENABLED === "true" &&
		Boolean(certificationEvidenceId(environment.GUEST_PROMOTION_PERIOD)) &&
		Boolean(certificationEvidenceId(environment.GUEST_ABUSE_HMAC_VERSION)) &&
		typeof environment.GUEST_ABUSE_HMAC_SECRET === "string" &&
		environment.GUEST_ABUSE_HMAC_SECRET.length >= 32 &&
		Boolean(certificationEvidenceId(environment.NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY)) &&
		typeof environment.GUEST_TURNSTILE_SECRET_KEY === "string" &&
		environment.GUEST_TURNSTILE_SECRET_KEY.length >= 16 &&
		["cloudflare", "vercel"].includes(String(environment.MEDIA_TRUSTED_PROXY_PROVIDER)) &&
		positiveIntegerString(environment.GUEST_RISK_BUDGET_MICROS) !== null &&
		Boolean(evidenceId) &&
		Boolean(runtimeEvidenceId);
	return complete
		? {
				id: "guest-production-configuration",
				status: "PASS",
				evidence: `${evidenceId}:${runtimeEvidenceId}`,
			}
		: {
				id: "guest-production-configuration",
				status: "NOT_COMPLETED",
				evidence:
					"Explicit production guest configuration and database runtime-override evidence are not recorded.",
			};
}

function certificationEvidenceId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const candidate = value.trim();
	if (
		candidate.length < 3 ||
		candidate.length > 160 ||
		!/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(candidate) ||
		/placeholder|example|not[-_./]?completed|not[-_./]?configured/i.test(candidate)
	) {
		return null;
	}
	return candidate;
}

function positiveIntegerString(value: unknown): string | null {
	return typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? value : null;
}

export function assertEzPicProductionCertificationComplete(
	report: EzPicProductionCertification,
): void {
	const incomplete = report.checks.filter((check) => check.status !== "PASS");
	const present = new Set(report.checks.map((check) => check.id));
	const missing = REQUIRED_CERTIFICATION_CHECK_IDS.filter((id) => !present.has(id));
	if (report.status !== "PASS" || incomplete.length > 0 || missing.length > 0) {
		throw new Error(
			`EzPic production certification is NOT_COMPLETED: ${[
				...incomplete.map((check) => check.id),
				...missing,
			].join(", ")}`,
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
