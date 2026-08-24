import { ORPCError } from "@orpc/server";
import {
	applyApprovedLegacyStripeRefundRepair,
	approveLegacyStripeRefundRepair,
} from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { adminProcedure } from "../../../orpc/procedures";

const reasonSchema = z.string().trim().min(10).max(500);
const operationKeySchema = z.string().trim().min(8).max(128);
const creditSnapshotSchema = z
	.string()
	.trim()
	.regex(/^[1-9]\d{0,18}$/)
	.refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n)
	.transform((value) => BigInt(value));
const repairActionSchema = z.enum(["CONFIRM_SUCCEEDED", "COMPENSATE_FAILED_OR_CANCELED"]);

const approvalOutputSchema = z.object({
	authorityId: z.string(),
	approvalKey: z.string(),
	replayed: z.boolean(),
});

const applicationOutputSchema = approvalOutputSchema.extend({
	action: repairActionSchema,
	receiptId: z.string(),
	compensatedCredits: z.string().regex(/^\d+$/),
});

const NOT_FOUND_ERRORS = new Set([
	"STRIPE_REFUND_REPAIR_LIFECYCLE_NOT_FOUND",
	"STRIPE_REFUND_REPAIR_APPROVAL_NOT_FOUND",
]);

const CONFLICT_ERRORS = new Set([
	"IDEMPOTENCY_CONFLICT",
	"STRIPE_REFUND_REPAIR_ACTION_INVALID",
	"STRIPE_REFUND_REPAIR_ACCOUNT_BINDING_INVALID",
	"STRIPE_REFUND_REPAIR_ALREADY_APPROVED",
	"STRIPE_REFUND_REPAIR_APPROVAL_STALE",
	"STRIPE_REFUND_REPAIR_CHARGE_BINDING_INVALID",
	"STRIPE_REFUND_REPAIR_CREDIT_SNAPSHOT_MISMATCH",
	"STRIPE_REFUND_REPAIR_GRANT_BINDING_INVALID",
	"STRIPE_REFUND_REPAIR_ISSUE_INVALID",
	"STRIPE_REFUND_REPAIR_ISSUE_STALE",
	"STRIPE_REFUND_REPAIR_LEDGER_NOT_FOUND",
	"STRIPE_REFUND_REPAIR_LEDGER_SNAPSHOT_STALE",
	"STRIPE_REFUND_REPAIR_PERIOD_SNAPSHOT_INVALID",
	"STRIPE_REFUND_REPAIR_PERIOD_SNAPSHOT_STALE",
	"STRIPE_REFUND_REPAIR_RESERVATION_ACTIVE",
	"STRIPE_REFUND_REPAIR_SECOND_APPROVER_REQUIRED",
	"STRIPE_REFUND_REPAIR_STATUS_NOT_TERMINAL",
]);

export const approveStripeRefundRepair = adminProcedure
	.route({
		method: "POST",
		path: "/admin/payments/stripe-refund-repairs/approve",
		tags: ["Admin", "Payments"],
		summary: "Approve a legacy Stripe refund repair",
		description:
			"Records immutable approval evidence for one exact Stripe refund lifecycle and reconciliation issue.",
	})
	.input(
		z.object({
			providerRefundId: z
				.string()
				.regex(/^re_[A-Za-z0-9_-]+$/)
				.max(255),
			issueKey: z.string().trim().min(1).max(512),
			action: repairActionSchema,
			expectedLastProviderChangeId: z.string().trim().min(1).max(255),
			expectedCredits: creditSnapshotSchema,
			approvalKey: operationKeySchema,
			reason: reasonSchema,
		}),
	)
	.output(approvalOutputSchema)
	.handler(async ({ context: { user }, input }) => {
		try {
			return await approveLegacyStripeRefundRepair({ ...input, actorUserId: user.id }, db);
		} catch (error) {
			throw toStripeRefundRepairOrpcError(error);
		}
	});

export const applyStripeRefundRepair = adminProcedure
	.route({
		method: "POST",
		path: "/admin/payments/stripe-refund-repairs/apply",
		tags: ["Admin", "Payments"],
		summary: "Apply an approved legacy Stripe refund repair",
		description:
			"Executes an immutable approval with a different administrator and records an idempotent receipt.",
	})
	.input(
		z.object({
			approvalKey: operationKeySchema,
			idempotencyKey: operationKeySchema,
			reason: reasonSchema,
		}),
	)
	.output(applicationOutputSchema)
	.handler(async ({ context: { user }, input }) => {
		try {
			const result = await applyApprovedLegacyStripeRefundRepair(
				{ ...input, actorUserId: user.id },
				db,
			);
			return { ...result, compensatedCredits: result.compensatedCredits.toString() };
		} catch (error) {
			throw toStripeRefundRepairOrpcError(error);
		}
	});

function toStripeRefundRepairOrpcError(error: unknown): ORPCError<string, unknown> {
	const message = error instanceof Error ? error.message : "";
	if (NOT_FOUND_ERRORS.has(message)) {
		return new ORPCError("NOT_FOUND", { message, data: { code: message } });
	}
	if (CONFLICT_ERRORS.has(message)) {
		return new ORPCError("CONFLICT", { message, data: { code: message } });
	}
	return new ORPCError("INTERNAL_SERVER_ERROR", {
		message: "STRIPE_REFUND_REPAIR_FAILED",
		data: { code: "STRIPE_REFUND_REPAIR_FAILED" },
	});
}
