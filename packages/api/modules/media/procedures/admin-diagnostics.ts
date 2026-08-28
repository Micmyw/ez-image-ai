import {
	getAdminGrowthOperations,
	getAdminMediaDiagnostics,
	listAdminUncertainGenerationAttempts,
} from "@repo/database";
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

const operationsProductKeySchema = z.enum(["image-fast", "image-quality"]);
const operationsFilterSchema = z
	.object({
		productKey: operationsProductKeySchema.optional(),
		provider: z
			.string()
			.trim()
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
			.optional(),
		model: z
			.string()
			.trim()
			.regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/)
			.optional(),
		status: jobStatusSchema.optional(),
		from: z.string().datetime().optional(),
		to: z.string().datetime().optional(),
	})
	.strict()
	.superRefine((input, context) => {
		const to = input.to ? new Date(input.to) : new Date();
		const from = input.from ? new Date(input.from) : new Date(to.getTime() - 30 * 24 * 60 * 60_000);
		if (from >= to) {
			context.addIssue({ code: "custom", path: ["to"], message: "to must be after from" });
		}
		if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1_000) {
			context.addIssue({
				code: "custom",
				path: ["from"],
				message: "operations range cannot exceed 366 days",
			});
		}
	});

const operationsOutputSchema = z.object({
	generatedAt: z.string().datetime(),
	summary: z.object({
		jobs: z.number().int().nonnegative(),
		succeeded: z.number().int().nonnegative(),
		failed: z.number().int().nonnegative(),
		successRate: z.number().min(0).max(1).nullable(),
		latencyMs: z.object({
			p50: z.number().int().nonnegative().nullable(),
			p95: z.number().int().nonnegative().nullable(),
		}),
		averageProviderCostMicros: z.string().regex(/^\d+$/).nullable(),
		moderationRejectionRate: z.number().min(0).max(1).nullable(),
		repeatEditRate: z.number().min(0).max(1).nullable(),
	}),
	credits: z.object({
		reserved: z.string().regex(/^\d+$/),
		charged: z.string().regex(/^\d+$/),
		released: z.string().regex(/^\d+$/),
	}),
	failureCodes: z.array(
		z.object({
			code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
			count: z.number().int().nonnegative(),
		}),
	),
	routes: z.array(
		z.object({
			productKey: operationsProductKeySchema,
			provider: z.string().min(1).max(128),
			model: z.string().min(1).max(256),
			status: jobStatusSchema,
			jobs: z.number().int().nonnegative(),
		}),
	),
	controls: z.object({
		generationEnabled: z.boolean(),
		products: z.array(
			z.object({
				productKey: operationsProductKeySchema,
				publicName: z.enum(["Standard Edit", "Quality Edit"]),
				enabled: z.boolean(),
			}),
		),
	}),
});

const aggregateCountSchema = z.number().int().nonnegative();
const aggregateMicrosSchema = z.string().regex(/^\d+$/);
const guestDiagnosticsSchema = z.object({
	admission: z.object({
		accepted: aggregateCountSchema,
		deniedByReason: z.array(
			z.object({
				reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
				count: aggregateCountSchema,
			}),
		),
	}),
	queue: z.object({
		depth: aggregateCountSchema,
		oldestAgeSeconds: aggregateCountSchema,
		waitMs: z.object({
			p50: aggregateCountSchema.nullable(),
			p95: aggregateCountSchema.nullable(),
		}),
		expiredBeforeDispatch: aggregateCountSchema,
	}),
	risk: z.object({
		budgetMicros: aggregateMicrosSchema,
		heldMicros: aggregateMicrosSchema,
		committedMicros: aggregateMicrosSchema,
		releasedMicros: aggregateMicrosSchema,
		utilizationPercent: z.number().min(0),
		state: z.enum(["OK", "WARN", "SLOW", "CLOSED", "EXHAUSTED"]),
	}),
	sponsorCredits: z.object({
		granted: aggregateMicrosSchema,
		reserved: aggregateMicrosSchema,
		settled: aggregateMicrosSchema,
		released: aggregateMicrosSchema,
	}),
	attempts: z.object({
		accepted: aggregateCountSchema,
		rejected: aggregateCountSchema,
		uncertain: aggregateCountSchema,
		uncertainOlderThanTenMinutes: aggregateCountSchema,
		reportedCostCovered: aggregateCountSchema,
		reportedCostMissing: aggregateCountSchema,
		billedSpendMismatch: aggregateCountSchema,
	}),
	moderation: z.object({
		approved: aggregateCountSchema,
		rejected: aggregateCountSchema,
		errors: aggregateCountSchema,
		errorRate: z.number().min(0).max(1).nullable(),
	}),
	watermark: z.object({ succeeded: aggregateCountSchema, failed: aggregateCountSchema }),
	resultAccess: z.object({
		ready: aggregateCountSchema,
		grantsCompleted: aggregateCountSchema,
		expiredGrants: aggregateCountSchema,
	}),
	cleanup: z.object({
		expiredAssets: aggregateCountSchema,
		overdueAssets: aggregateCountSchema,
		deadLetterEvents: aggregateCountSchema,
		oldestOverdueSeconds: aggregateCountSchema,
	}),
	controls: z.object({
		environmentEnabled: z.boolean(),
		runtimeEnabled: z.boolean(),
		admissionOpen: z.boolean(),
		automaticClosureReasons: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)),
	}),
});

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
	.handler(async () => {
		const diagnostics = await getAdminMediaDiagnostics(db, {
			guestEnvironmentEnabled: process.env.GUEST_MEDIA_ENABLED === "true",
			guestPromotionPeriod: process.env.GUEST_PROMOTION_PERIOD ?? "",
			guestRiskBudgetMicros: guestRiskBudgetMicros(process.env.GUEST_RISK_BUDGET_MICROS),
		});
		return { ...diagnostics, guest: guestDiagnosticsSchema.parse(diagnostics.guest) };
	});

export const adminGrowthOperations = adminProcedure
	.route({
		method: "GET",
		path: "/admin/media/growth-operations",
		tags: ["Admin", "Media"],
		summary: "Read EzPic growth and generation operations aggregates",
		description:
			"Returns aggregate editing metrics and effective controls without prompts, private media, URLs, or raw job identifiers.",
	})
	.input(operationsFilterSchema)
	.output(operationsOutputSchema)
	.handler(async ({ input }) => {
		const to = input.to ? new Date(input.to) : new Date();
		const from = input.from ? new Date(input.from) : new Date(to.getTime() - 30 * 24 * 60 * 60_000);
		return getAdminGrowthOperations(
			{
				...(input.productKey ? { productKey: input.productKey } : {}),
				...(input.provider ? { provider: input.provider } : {}),
				...(input.model ? { model: input.model } : {}),
				...(input.status ? { status: input.status } : {}),
				from,
				to,
				generationEnabled: process.env.MEDIA_GENERATION_ENABLED === "true",
			},
			db,
		);
	});

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

function guestRiskBudgetMicros(value: string | undefined): bigint {
	if (!value || !/^[1-9][0-9]*$/.test(value)) return 0n;
	return BigInt(value);
}
