import { getCatalogEntry, getCatalogImageSpecCell } from "@repo/ai";
import { EZPIC_PRODUCT_KEYS, IMAGE_ASPECT_RATIOS, IMAGE_SKU_KEYS } from "@repo/config";
import {
	type AdminSafeImageProductDefinition,
	getAdminGrowthOperations,
	getAdminMediaDiagnostics,
	listAdminUncertainGenerationAttempts,
} from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { adminProcedure } from "../../../orpc/procedures";

function createAdminSafeImageProductDefinitions(): readonly AdminSafeImageProductDefinition[] {
	return EZPIC_PRODUCT_KEYS.map((productKey) => {
		const entry = getCatalogEntry(productKey);
		if (!entry.imageSpecMatrix) {
			throw new Error(`Missing image specification matrix for ${productKey}`);
		}
		return {
			productKey,
			publicName: entry.label,
			skuCells: entry.imageSpecMatrix.cells.map(({ skuKey, aspectRatios }) => ({
				skuKey,
				aspectRatios: [...aspectRatios],
			})),
		};
	});
}

const ADMIN_SAFE_IMAGE_PRODUCTS = createAdminSafeImageProductDefinitions();

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

const operationsProductKeySchema = z.enum(EZPIC_PRODUCT_KEYS);
const operationsSkuKeySchema = z.enum(IMAGE_SKU_KEYS);
const operationsFilterSchema = z
	.object({
		productKey: operationsProductKeySchema.optional(),
		skuKey: operationsSkuKeySchema.optional(),
		status: jobStatusSchema.optional(),
		from: z.string().datetime().optional(),
		to: z.string().datetime().optional(),
	})
	.strict()
	.superRefine((input, context) => {
		if (
			input.productKey &&
			input.skuKey &&
			!getCatalogImageSpecCell(getCatalogEntry(input.productKey), input.skuKey)
		) {
			context.addIssue({
				code: "custom",
				path: ["skuKey"],
				message: "skuKey is not valid for productKey",
			});
		}
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
	summary: z.object({
		jobs: z.number().int().nonnegative(),
		succeeded: z.number().int().nonnegative(),
		failed: z.number().int().nonnegative(),
		successRate: z.number().min(0).max(1).nullable(),
		latencyMs: z.object({
			p50: z.number().int().nonnegative().nullable(),
			p95: z.number().int().nonnegative().nullable(),
		}),
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
	skuBreakdown: z.array(
		z.object({
			productKey: operationsProductKeySchema,
			skuKey: operationsSkuKeySchema.nullable(),
			status: jobStatusSchema,
			jobs: z.number().int().nonnegative(),
		}),
	),
	controls: z.object({
		generationEnabled: z.boolean(),
		products: z.array(
			z.object({
				productKey: operationsProductKeySchema,
				publicName: z.string().min(1).max(128),
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
		billingEvidencePresent: aggregateCountSchema,
		billingEvidenceMissing: aggregateCountSchema,
		billingMismatch: aggregateCountSchema,
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

const safeOperationalCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const safeEntityTypeSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/);
const paymentEventDiagnosticSchema = z.object({
	id: z.string().min(1),
	status: z.enum(["FAILED", "DEAD_LETTER", "IGNORED"]),
	attemptCount: aggregateCountSchema,
	lastTriggerAttempt: aggregateCountSchema.nullable(),
	lastAttemptAt: z.string().datetime().nullable(),
	lastErrorClass: safeOperationalCodeSchema.nullable(),
});
const paymentEventBucketSchema = z.object({
	count: aggregateCountSchema,
	items: z.array(paymentEventDiagnosticSchema),
});
const adminMediaDiagnosticsOutputSchema = z.object({
	generatedAt: z.string().datetime(),
	queue: z.object({
		depth: aggregateCountSchema,
		oldestAgeSeconds: aggregateCountSchema,
		stalledJobs: aggregateCountSchema,
		needsReconciliation: aggregateCountSchema,
	}),
	outbox: z.object({
		pending: aggregateCountSchema,
		deadLetter: aggregateCountSchema,
		oldestAgeSeconds: aggregateCountSchema,
	}),
	generation: z.object({
		succeeded: aggregateCountSchema,
		failed: aggregateCountSchema,
		running: aggregateCountSchema,
	}),
	storage: z.object({
		readyAssets: aggregateCountSchema,
		readyBytes: aggregateMicrosSchema,
		reservedBytes: aggregateMicrosSchema,
	}),
	credits: z.object({
		spendable: aggregateMicrosSchema,
		reserved: aggregateMicrosSchema,
		debt: aggregateMicrosSchema,
		settled: aggregateMicrosSchema,
	}),
	events: z.object({
		generationFailed: aggregateCountSchema,
		payment: z.object({
			failed: paymentEventBucketSchema,
			deadLetter: paymentEventBucketSchema,
			ignored: paymentEventBucketSchema,
		}),
	}),
	stripeReconciliation: z.object({
		checkpoint: z
			.object({
				id: z.string().min(1),
				status: safeOperationalCodeSchema,
				stage: safeOperationalCodeSchema,
				pages: aggregateCountSchema,
				failures: aggregateCountSchema,
				cutoff: z.string().datetime().nullable(),
				lastAttempt: z.string().datetime().nullable(),
				lastCompleted: z.string().datetime().nullable(),
				lastError: safeOperationalCodeSchema.nullable(),
				hasCursor: z.boolean(),
				leaseActive: z.boolean(),
			})
			.nullable(),
		issues: z.object({
			openCount: aggregateCountSchema,
			items: z.array(
				z.object({
					id: z.string().min(1),
					code: safeOperationalCodeSchema,
					entityType: safeEntityTypeSchema,
					stage: safeOperationalCodeSchema,
					occurrences: aggregateCountSchema,
					firstSeenAt: z.string().datetime(),
					lastSeenAt: z.string().datetime(),
				}),
			),
		}),
		historicalRefunds: z.object({
			needsReviewCount: aggregateCountSchema,
			missingLifecycleCount: aggregateCountSchema,
			items: z.array(
				z.object({
					refundId: z.string().min(1).nullable(),
					reason: z.enum([
						"MISSING_LIFECYCLE",
						"NON_SUCCEEDED_LIFECYCLE",
						"FINALIZATION_MISSING",
						"CREDIT_TOTAL_MISMATCH",
					]),
					lifecycleStatus: safeOperationalCodeSchema.nullable(),
					ledgerEntryCount: aggregateCountSchema,
					ledgerCredits: aggregateMicrosSchema,
					finalizedCredits: aggregateMicrosSchema.nullable(),
					creditsFinalizedAt: z.string().datetime().nullable(),
					firstLedgerAt: z.string().datetime(),
					lastLedgerAt: z.string().datetime(),
				}),
			),
		}),
	}),
	overrides: z.array(
		z
			.object({
				id: z.string().min(1),
				scope: z.enum(["GENERATION", "GUEST", "PRODUCT"]),
				productKey: operationsProductKeySchema.nullable(),
				version: z.number().int().positive(),
				enabled: z.boolean(),
				createdAt: z.string().datetime(),
			})
			.superRefine((override, context) => {
				if ((override.scope === "PRODUCT") !== (override.productKey !== null)) {
					context.addIssue({
						code: "custom",
						path: ["productKey"],
						message: "productKey must identify only PRODUCT overrides",
					});
				}
			}),
	),
	guest: guestDiagnosticsSchema,
});

const uncertainAttemptDiagnosticSchema = z.object({
	ids: z.object({
		attemptId: z.string(),
		jobId: z.string(),
		reservationId: z.string().nullable(),
	}),
	selection: z
		.object({
			productKey: operationsProductKeySchema,
			skuKey: operationsSkuKeySchema,
			aspectRatio: z.enum(IMAGE_ASPECT_RATIOS),
		})
		.nullable(),
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
	.output(adminMediaDiagnosticsOutputSchema)
	.handler(async () => {
		const diagnostics = await getAdminMediaDiagnostics(db, {
			guestEnvironmentEnabled: process.env.GUEST_MEDIA_ENABLED === "true",
			guestPromotionPeriod: process.env.GUEST_PROMOTION_PERIOD ?? "",
			guestRiskBudgetMicros: guestRiskBudgetMicros(process.env.GUEST_RISK_BUDGET_MICROS),
		});
		return adminMediaDiagnosticsOutputSchema.parse(diagnostics);
	});

export const adminGrowthOperations = adminProcedure
	.route({
		method: "GET",
		path: "/admin/media/growth-operations",
		tags: ["Admin", "Media"],
		summary: "Read EzPic growth and generation operations aggregates",
		description:
			"Returns aggregate editing metrics, legal SKU breakdowns, and effective controls without Provider routes, costs, prompts, private media, URLs, or raw job identifiers.",
	})
	.input(operationsFilterSchema)
	.output(operationsOutputSchema)
	.handler(async ({ input }) => {
		const to = input.to ? new Date(input.to) : new Date();
		const from = input.from ? new Date(input.from) : new Date(to.getTime() - 30 * 24 * 60 * 60_000);
		return getAdminGrowthOperations(
			{
				...(input.productKey ? { productKey: input.productKey } : {}),
				...(input.skuKey ? { skuKey: input.skuKey } : {}),
				...(input.status ? { status: input.status } : {}),
				from,
				to,
				generationEnabled: process.env.MEDIA_GENERATION_ENABLED === "true",
			},
			db,
			ADMIN_SAFE_IMAGE_PRODUCTS,
		);
	});

export const listUncertainGenerationAttempts = adminProcedure
	.route({
		method: "GET",
		path: "/admin/media/attempts/uncertain",
		tags: ["Admin", "Media"],
		summary: "List uncertain generation attempts for recovery",
		description:
			"Returns only recovery metadata and validated public product selections; Provider routes, task IDs, costs, endpoints, and snapshots are excluded.",
	})
	.input(z.object({ limit: z.number().int().min(1).max(100).default(20) }))
	.output(z.object({ items: z.array(uncertainAttemptDiagnosticSchema) }))
	.handler(async ({ input }) => ({
		items: await listAdminUncertainGenerationAttempts(
			{ limit: input.limit },
			db,
			ADMIN_SAFE_IMAGE_PRODUCTS,
		),
	}));

function guestRiskBudgetMicros(value: string | undefined): bigint {
	if (!value || !/^[1-9][0-9]*$/.test(value)) return 0n;
	return BigInt(value);
}
