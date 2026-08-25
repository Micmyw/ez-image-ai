import { z } from "zod";

export const EZPIC_STAGING_SCENARIOS = [
	"registration-draft-recovery",
	"standard-success",
	"quality-success",
	"provider-failure-credit-release",
	"uncertain-submission-recovery",
	"moderation-rejection",
	"cancelable-job-cancellation",
	"before-after-signed-download",
	"edit-again-three-rounds",
	"checkout",
	"monthly-credits",
	"annual-monthly-credits",
	"subscription-cancellation",
	"refund-and-debt",
	"webhook-replay",
	"reconciliation-recovery",
	"asset-deletion-cleanup",
	"global-product-kill-switch",
	"sentry-alert",
	"recovery-rollback-drill",
] as const;

const stagingScenarioSchema = z.enum(EZPIC_STAGING_SCENARIOS);
const evidenceItemSchema = z
	.object({
		id: stagingScenarioSchema,
		status: z.enum(["PASS", "NOT_COMPLETED"]),
		evidence: z.string().trim().min(1).max(2_000),
	})
	.strict();

const launchEvidenceSchema = z
	.object({
		version: z.literal(1),
		deploymentRevision: z.string().trim().min(7).max(160).nullable(),
		scenarios: z.array(evidenceItemSchema).length(EZPIC_STAGING_SCENARIOS.length),
	})
	.strict()
	.superRefine((input, context) => {
		for (const id of EZPIC_STAGING_SCENARIOS) {
			const count = input.scenarios.filter((scenario) => scenario.id === id).length;
			if (count !== 1) {
				context.addIssue({
					code: "custom",
					path: ["scenarios"],
					message: `${id} must appear exactly once`,
				});
			}
		}
		input.scenarios.forEach((scenario, index) => {
			if (
				scenario.status === "PASS" &&
				/NOT[_ -]?COMPLETED|placeholder|not[_ -]?configured/i.test(scenario.evidence)
			) {
				context.addIssue({
					code: "custom",
					path: ["scenarios", index, "evidence"],
					message: `${scenario.id} cannot be PASS while evidence contains NOT_COMPLETED`,
				});
			}
		});
	});

export type EzPicLaunchEvidence = z.infer<typeof launchEvidenceSchema>;

export function parseEzPicLaunchEvidence(input: unknown): EzPicLaunchEvidence {
	return launchEvidenceSchema.parse(input);
}

export function assertEzPicProductionEvidenceComplete(evidence: EzPicLaunchEvidence): void {
	const incomplete = evidence.scenarios.filter((scenario) => scenario.status !== "PASS");
	if (!evidence.deploymentRevision || incomplete.length > 0) {
		throw new Error(
			`EzPic production certification is NOT_COMPLETED: ${
				incomplete.map((scenario) => scenario.id).join(", ") || "deployment revision missing"
			}`,
		);
	}
}
