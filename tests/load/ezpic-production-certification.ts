import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseEzPicLaunchEvidence } from "../../packages/config/launch-evidence";
import {
	assertEzPicProductionCertificationComplete,
	buildEzPicProductionCertification,
} from "../../packages/config/production-certification";
import { validateEzPicEnvironmentMatrix } from "../../packages/config/production-launch";

const matrixPath = resolve(
	process.env.EZPIC_ENVIRONMENT_MATRIX_PATH ??
		"docs/operations/evidence/ezpic-environment-matrix.template.json",
);
const evidencePath = resolve(
	process.env.EZPIC_LAUNCH_EVIDENCE_PATH ?? "docs/operations/evidence/ezpic-staging-evidence.json",
);

const matrix: unknown = JSON.parse(readFileSync(matrixPath, "utf8"));
const evidence: unknown = JSON.parse(readFileSync(evidencePath, "utf8"));

// A NOT_COMPLETED template is valid input, but malformed or incomplete scenario structure is not.
validateEzPicEnvironmentMatrix(matrix);
parseEzPicLaunchEvidence(evidence);

const report = buildEzPicProductionCertification({
	environment: process.env,
	matrix,
	evidence,
});
console.log(JSON.stringify(report, null, 2));

if (process.argv.includes("--assert-complete")) {
	assertEzPicProductionCertificationComplete(report);
}
