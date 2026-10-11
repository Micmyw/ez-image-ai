import { z } from "zod";

export const KIE_ZERO_COST_REJECTION_CODE = "PROVIDER_POLICY_REJECTED_NO_CHARGE";
export const KIE_SENSITIVE_REJECTION_MESSAGE =
	"The input or output was flagged as sensitive. Please try again with different inputs.";

// This is deliberately narrower than a generic 400/FAILED or providerCharged=false.
// Dashboard evidence is an audited administrator attestation, never a webhook assertion.
export const kieZeroCostRejectionEvidenceSchema = z
	.strictObject({
		version: z.literal(1),
		provider: z.literal("kie"),
		source: z.enum(["record-info", "dashboard-log"]),
		taskId: z.string().trim().min(1).max(512),
		model: z.string().trim().min(1).max(256).optional(),
		state: z.literal("fail"),
		failCode: z.literal("400"),
		failMsg: z.literal(KIE_SENSITIVE_REJECTION_MESSAGE),
		consumptionField: z.enum(["creditsConsumed", "consumeCredits"]),
		consumedCredits: z.literal(0),
		outputCount: z.literal(0),
		observedAt: z.iso.datetime(),
	})
	.superRefine((value, context) => {
		if (
			(value.source === "record-info" && value.consumptionField !== "creditsConsumed") ||
			(value.source === "dashboard-log" &&
				(value.consumptionField !== "consumeCredits" || !value.model))
		)
			context.addIssue({
				code: "custom",
				message: "Evidence source and consumption field must agree",
			});
	});

export type KieZeroCostRejectionEvidence = z.infer<typeof kieZeroCostRejectionEvidenceSchema>;

/** Historical snapshots may contain outputs rather than outputCount. Unknown shapes stay held. */
export function hasKieChargeOrOutputEvidence(snapshot: unknown): boolean {
	if (snapshot === null || snapshot === undefined) return false;
	if (typeof snapshot !== "object" || Array.isArray(snapshot)) return true;
	const value = snapshot as Record<string, unknown>;
	return (
		value.zeroCostRejectionConflict === true ||
		(value.providerCharged !== undefined && value.providerCharged !== false) ||
		(value.outputCount !== undefined && value.outputCount !== 0) ||
		(value.outputs !== undefined && (!Array.isArray(value.outputs) || value.outputs.length > 0))
	);
}

/** Reject unknown result shapes instead of treating an unrecognized output key as no output. */
export function isKieRejectionWithoutOutput(resultJson: unknown, taskId: string): boolean {
	if (resultJson === null || resultJson === undefined || resultJson === "") return true;
	if (typeof resultJson !== "string") return false;
	try {
		const parsed = z
			.strictObject({
				code: z.literal(400).optional(),
				task_id: z.literal(taskId).optional(),
				message: z.literal(KIE_SENSITIVE_REJECTION_MESSAGE).optional(),
				resultUrls: z.array(z.never()).optional(),
			})
			.safeParse(JSON.parse(resultJson));
		return parsed.success;
	} catch {
		return false;
	}
}
