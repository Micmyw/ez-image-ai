import { getAdminMediaDiagnostics, listAdminUncertainGenerationAttempts } from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { adminProcedure } from "../../../orpc/procedures";

const attemptStatusSchema = z.enum([
	"CREATED",
	"SUBMISSION_UNCERTAIN",
	"SUBMITTED",
	"RUNNING",
	"NEEDS_RECONCILIATION",
	"SUCCEEDED",
	"FAILED",
	"CANCELED",
]);

const jobStatusSchema = z.enum([
	"RESERVED",
	"DISPATCH_QUEUED",
	"SUBMITTING",
	"PROVIDER_PENDING",
	"PROVIDER_RUNNING",
	"NEEDS_RECONCILIATION",
	"FINALIZING",
	"SUCCEEDED",
	"FAILED",
	"CANCELED",
]);

const uncertainAttemptDiagnosticSchema = z.object({
	ids: z.object({
		attemptId: z.string(),
		jobId: z.string(),
		reservationId: z.string().nullable(),
	}),
	route: z.object({ provider: z.string(), providerModelId: z.string() }),
	status: z.object({ attempt: attemptStatusSchema, job: jobStatusSchema }),
	timestamps: z.object({
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
		submittedAt: z.string().datetime().nullable(),
		completedAt: z.string().datetime().nullable(),
		lastProviderEventAt: z.string().datetime().nullable(),
		nextReconcileAt: z.string().datetime().nullable(),
	}),
	retryCount: z.number().int().nonnegative(),
	reservationStatus: z.enum(["ACTIVE", "SETTLED", "RELEASED"]).nullable(),
	reasonCode: z.enum([
		"SUBMISSION_UNCERTAIN",
		"SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
		"TERMINAL_SUCCESS_WITHOUT_MEDIA",
		"PROVIDER_RECOVERY_UNAVAILABLE",
		"PROVIDER_ADAPTER_UNAVAILABLE",
		"PROVIDER_CANCELLATION_UNCONFIRMED",
		"PROVIDER_CANCELLATION_UNSUPPORTED",
		"QUOTED_ROUTE_UNAVAILABLE",
		"LEGACY_QUOTE_ROUTE_UNAVAILABLE",
	]),
});

export const adminMediaDiagnostics = adminProcedure
	.route({ method: "GET", path: "/admin/media/diagnostics", tags: ["Admin", "Media"] })
	.handler(async () => getAdminMediaDiagnostics(db));

export const listUncertainGenerationAttempts = adminProcedure
	.route({
		method: "GET",
		path: "/admin/media/attempts/uncertain",
		tags: ["Admin", "Media"],
		summary: "List uncertain generation attempts for recovery",
		description:
			"Returns only recovery metadata; provider task IDs, endpoints, and snapshots are excluded.",
	})
	.input(z.object({ limit: z.number().int().min(1).max(100).default(20) }))
	.output(z.object({ items: z.array(uncertainAttemptDiagnosticSchema) }))
	.handler(async ({ input }) => ({
		items: await listAdminUncertainGenerationAttempts({ limit: input.limit }, db),
	}));
