import { ORPCError } from "@orpc/server";
import { kieZeroCostRejectionEvidenceSchema } from "@repo/config";
import { resolveAdminKieZeroCostRejection } from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { adminProcedure } from "../../../orpc/procedures";

const conflicts = new Set([
	"IDEMPOTENCY_CONFLICT",
	"EXECUTION_ENGINE_NOT_OWNED",
	"ATTEMPT_NOT_AWAITING_TERMINAL_RECONCILIATION",
	"KIE_REJECTION_EVIDENCE_CONFLICT",
	"KIE_REJECTION_SETTLEMENT_EVENT_CONFLICT",
]);

export const resolveKieZeroCostRejection = adminProcedure
	.route({
		method: "POST",
		path: "/admin/media/attempts/resolve-kie-zero-cost-rejection",
		tags: ["Admin", "Media"],
		summary: "Resolve a confirmed zero-cost Kie policy rejection",
		description:
			"Audit a fresh administrator-verified dashboard record and enqueue settlement of the existing reservation. Never submits generation or accepts a credit amount.",
	})
	.input(
		z.strictObject({
			attemptId: z.string().trim().min(1).max(128),
			idempotencyKey: z.string().trim().min(8).max(128),
			reason: z.string().trim().min(10).max(500),
			providerEvidenceReference: z.string().trim().min(10).max(1_000),
			evidence: kieZeroCostRejectionEvidenceSchema.refine(
				(value) => value.source === "dashboard-log",
				"Administrator recovery requires dashboard evidence",
			),
		}),
	)
	.output(
		z.object({
			jobId: z.string(),
			attemptId: z.string(),
			reservedCredits: z.string(),
			settlementEventId: z.string(),
			replayed: z.boolean(),
		}),
	)
	.handler(async ({ context: { user }, input }) => {
		try {
			return await resolveAdminKieZeroCostRejection({ ...input, actorUserId: user.id }, db);
		} catch (error) {
			const code = error instanceof Error ? error.message : "";
			if (conflicts.has(code)) throw new ORPCError("CONFLICT", { message: code });
			if (code === "ATTEMPT_NOT_FOUND") throw new ORPCError("NOT_FOUND");
			if (
				code === "KIE_REJECTION_EVIDENCE_STALE" ||
				code === "KIE_REJECTION_ADMIN_EVIDENCE_REQUIRED"
			)
				throw new ORPCError("BAD_REQUEST", { message: code });
			throw error;
		}
	});
