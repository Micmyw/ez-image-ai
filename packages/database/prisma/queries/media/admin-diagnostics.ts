import type {
	CreditReservationStatus,
	GenerationAttemptStatus,
	GenerationJobStatus,
} from "../../generated/client";
import type { MediaTransactionClient } from "./types";

interface AggregateCountAge {
	count: bigint;
	oldestAgeSeconds: number | null;
}

const GUEST_RUNTIME_CONFIG_KEY = "media.guestGeneration.enabled";
const GUEST_SAFETY_ACTOR = "system:guest-safety-monitor";

function bigintRatio(numerator: bigint, denominator: bigint): number | null {
	if (denominator === 0n) return null;
	return Number((numerator * 1_000_000n) / denominator) / 1_000_000;
}

export interface GuestOperationalSafetyInput {
	heldRiskMicros: bigint;
	committedRiskMicros: bigint;
	riskBudgetMicros: bigint;
	queueDepth: number;
	oldestQueueAgeSeconds: number;
	uncertainOlderThanTenMinutes: number;
	moderationErrorRate: number | null;
	watermarkFailures: number;
	billedSpendMismatch: number;
	overdueCleanupAssets: number;
}

export function evaluateGuestOperationalSafety(input: GuestOperationalSafetyInput) {
	const usedRiskMicros = input.heldRiskMicros + input.committedRiskMicros;
	const budgetConfigured = input.riskBudgetMicros > 0n;
	const utilizationPercent = budgetConfigured
		? Number((usedRiskMicros * 10_000n) / input.riskBudgetMicros) / 100
		: 100;
	const riskState =
		utilizationPercent >= 100
			? ("EXHAUSTED" as const)
			: utilizationPercent >= 90
				? ("CLOSED" as const)
				: utilizationPercent >= 75
					? ("SLOW" as const)
					: utilizationPercent >= 50
						? ("WARN" as const)
						: ("OK" as const);
	const warnings: string[] = [];
	const closureReasons: string[] = [];
	if (!budgetConfigured) closureReasons.push("RISK_BUDGET_CONFIGURATION");
	else if (utilizationPercent >= 90) closureReasons.push("RISK_BUDGET");
	else if (utilizationPercent >= 50) warnings.push("RISK_BUDGET");
	if (input.queueDepth >= 25) closureReasons.push("QUEUE_DEPTH");
	else if (input.queueDepth > 20) warnings.push("QUEUE_DEPTH");
	if (input.oldestQueueAgeSeconds >= 600) closureReasons.push("QUEUE_AGE");
	else if (input.oldestQueueAgeSeconds > 300) warnings.push("QUEUE_AGE");
	if (input.uncertainOlderThanTenMinutes > 0) warnings.push("UNCERTAIN_ATTEMPT_AGE");
	if ((input.moderationErrorRate ?? 0) > 0.01) closureReasons.push("MODERATION_ERRORS");
	if (input.watermarkFailures > 0) closureReasons.push("WATERMARK_FAILURE");
	if (input.billedSpendMismatch > 0) closureReasons.push("BILLED_SPEND_MISMATCH");
	if (input.overdueCleanupAssets > 0) closureReasons.push("CLEANUP_OVERDUE");

	const admissionAction =
		utilizationPercent >= 100
			? ("REJECT" as const)
			: closureReasons.length > 0
				? ("CLOSE" as const)
				: utilizationPercent >= 75
					? ("SLOW" as const)
					: warnings.length > 0
						? ("WARN" as const)
						: ("OPEN" as const);
	return {
		usedRiskMicros,
		utilizationPercent,
		riskState,
		admissionAction,
		warnings,
		closureReasons,
		...(admissionAction === "CLOSE" || admissionAction === "REJECT"
			? { automaticOverride: { configKey: GUEST_RUNTIME_CONFIG_KEY, value: false as const } }
			: {}),
	};
}

export interface AdminMediaDiagnosticsOptions {
	guestEnvironmentEnabled?: boolean;
	guestPromotionPeriod?: string;
	guestRiskBudgetMicros?: bigint;
}

export interface MonitorGuestOperationalSafetyOptions extends AdminMediaDiagnosticsOptions {
	now?: Date;
}

const PAYMENT_EVENT_DIAGNOSTIC_LIMIT = 25;
const STRIPE_RECONCILIATION_DIAGNOSTIC_LIMIT = 25;

interface PaymentEventDiagnosticRow {
	id: string;
	providerEventId: string;
	status: string;
	attemptCount: number;
	lastTriggerAttempt: number | null;
	lastAttemptAt: Date | null;
	lastTriggerRunId: string | null;
	lastErrorClass: string | null;
}

const safeUncertainReasonCodes = new Set([
	"SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
	"TERMINAL_SUCCESS_WITHOUT_MEDIA",
	"PROVIDER_RECOVERY_UNAVAILABLE",
	"PROVIDER_ADAPTER_UNAVAILABLE",
	"PROVIDER_CANCELLATION_UNCONFIRMED",
	"PROVIDER_CANCELLATION_UNSUPPORTED",
	"QUOTED_ROUTE_UNAVAILABLE",
	"LEGACY_QUOTE_ROUTE_UNAVAILABLE",
]);
const explicitNoSubmitRecoveryCodes = [
	"PROVIDER_ADAPTER_UNAVAILABLE",
	"QUOTED_ROUTE_UNAVAILABLE",
	"LEGACY_QUOTE_ROUTE_UNAVAILABLE",
] as const;

export interface ListAdminUncertainGenerationAttemptsInput {
	limit?: number;
}

export interface AdminUncertainGenerationAttemptDiagnostic {
	ids: {
		attemptId: string;
		jobId: string;
		reservationId: string | null;
	};
	route: {
		provider: string;
		providerModelId: string;
	};
	status: {
		attempt: GenerationAttemptStatus;
		job: GenerationJobStatus;
	};
	timestamps: {
		createdAt: string;
		updatedAt: string;
		submittedAt: string | null;
		completedAt: string | null;
		lastProviderEventAt: string | null;
		nextReconcileAt: string | null;
	};
	retryCount: number;
	reservationStatus: CreditReservationStatus | null;
	reasonCode:
		| "SUBMISSION_UNCERTAIN"
		| "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION"
		| "TERMINAL_SUCCESS_WITHOUT_MEDIA"
		| "PROVIDER_RECOVERY_UNAVAILABLE"
		| "PROVIDER_ADAPTER_UNAVAILABLE"
		| "PROVIDER_CANCELLATION_UNCONFIRMED"
		| "PROVIDER_CANCELLATION_UNSUPPORTED"
		| "QUOTED_ROUTE_UNAVAILABLE"
		| "LEGACY_QUOTE_ROUTE_UNAVAILABLE";
}

function boundedLimit(value: number | undefined): number {
	if (value === undefined) return 20;
	if (!Number.isInteger(value)) throw new Error("Invalid uncertain attempt diagnostics limit");
	return Math.min(Math.max(value, 1), 100);
}

function safeUncertainReasonCode(
	value: string | null,
): AdminUncertainGenerationAttemptDiagnostic["reasonCode"] {
	return value && safeUncertainReasonCodes.has(value)
		? (value as Exclude<
				AdminUncertainGenerationAttemptDiagnostic["reasonCode"],
				"SUBMISSION_UNCERTAIN"
			>)
		: "SUBMISSION_UNCERTAIN";
}

/**
 * Returns only the administrator-facing recovery metadata needed to triage uncertain attempts.
 * Provider task identifiers, endpoints, and snapshots deliberately never enter
 * the select projection.
 */
export async function listAdminUncertainGenerationAttempts(
	input: ListAdminUncertainGenerationAttemptsInput,
	client: MediaTransactionClient,
): Promise<AdminUncertainGenerationAttemptDiagnostic[]> {
	const attempts = await client.generationAttempt.findMany({
		where: {
			OR: [
				{ uncertainSubmission: true },
				{
					status: "NEEDS_RECONCILIATION",
					job: { failureCode: { in: [...explicitNoSubmitRecoveryCodes] } },
				},
			],
		},
		select: {
			id: true,
			provider: true,
			providerModelId: true,
			status: true,
			reconciliationCount: true,
			createdAt: true,
			updatedAt: true,
			submittedAt: true,
			completedAt: true,
			lastProviderEventAt: true,
			nextReconcileAt: true,
			job: {
				select: {
					id: true,
					status: true,
					failureCode: true,
					reservation: { select: { id: true, status: true } },
				},
			},
		},
		orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
		take: boundedLimit(input.limit),
	});

	return attempts.map((attempt) => ({
		ids: {
			attemptId: attempt.id,
			jobId: attempt.job.id,
			reservationId: attempt.job.reservation?.id ?? null,
		},
		route: { provider: attempt.provider, providerModelId: attempt.providerModelId },
		status: { attempt: attempt.status, job: attempt.job.status },
		timestamps: {
			createdAt: attempt.createdAt.toISOString(),
			updatedAt: attempt.updatedAt.toISOString(),
			submittedAt: attempt.submittedAt?.toISOString() ?? null,
			completedAt: attempt.completedAt?.toISOString() ?? null,
			lastProviderEventAt: attempt.lastProviderEventAt?.toISOString() ?? null,
			nextReconcileAt: attempt.nextReconcileAt?.toISOString() ?? null,
		},
		retryCount: attempt.reconciliationCount,
		reservationStatus: attempt.job.reservation?.status ?? null,
		reasonCode: safeUncertainReasonCode(attempt.job.failureCode),
	}));
}

interface StripeReconciliationCheckpointDiagnosticRow {
	provider: string;
	status: string;
	stage: string;
	pages: number;
	failures: number;
	cutoff: Date | null;
	lastAttempt: Date | null;
	lastCompleted: Date | null;
	lastError: string | null;
	hasCursor: boolean;
	leaseActive: boolean;
}

interface HistoricalStripeRefundDiagnosticRow {
	providerRefundId: string;
	reason:
		| "MISSING_LIFECYCLE"
		| "NON_SUCCEEDED_LIFECYCLE"
		| "FINALIZATION_MISSING"
		| "CREDIT_TOTAL_MISMATCH";
	lifecycleStatus: string | null;
	ledgerEntryCount: bigint;
	ledgerCredits: bigint;
	finalizedCredits: bigint | null;
	creditsFinalizedAt: Date | null;
	firstLedgerAt: Date;
	lastLedgerAt: Date;
}

interface HistoricalStripeRefundCountRow {
	needsReviewCount: bigint;
	missingLifecycleCount: bigint;
}

export async function getAdminMediaDiagnostics(
	client: MediaTransactionClient,
	options: AdminMediaDiagnosticsOptions = {},
) {
	const now = new Date();
	const stalledBefore = new Date(now.getTime() - 15 * 60_000);
	const dayStart = new Date(now);
	dayStart.setUTCHours(0, 0, 0, 0);
	const [
		queueRows,
		stalledJobs,
		needsReconciliation,
		outboxRows,
		providers,
		storageRows,
		reservedStorage,
		creditRows,
		settledRows,
		financeRows,
		eventRows,
		failedPaymentEvents,
		deadLetterPaymentEvents,
		ignoredPaymentEvents,
		stripeReconciliationCheckpoints,
		openStripeReconciliationIssueCount,
		openStripeReconciliationIssues,
		historicalStripeRefundCountRows,
		historicalStripeRefundRows,
		overrides,
	] = await Promise.all([
		client.$queryRaw<Array<AggregateCountAge>>`
			SELECT COUNT(*)::bigint AS count,
			       EXTRACT(EPOCH FROM (now() - MIN("createdAt")))::double precision AS "oldestAgeSeconds"
			FROM "generation_job" WHERE "status" IN ('RESERVED', 'DISPATCH_QUEUED')`,
		client.generationJob.count({
			where: {
				status: { notIn: ["NEEDS_RECONCILIATION", "SUCCEEDED", "FAILED", "CANCELED"] },
				updatedAt: { lt: stalledBefore },
			},
		}),
		client.generationJob.count({ where: { status: "NEEDS_RECONCILIATION" } }),
		client.$queryRaw<Array<{ status: string; count: bigint; oldestAgeSeconds: number | null }>>`
			SELECT "status"::text AS status, COUNT(*)::bigint AS count,
			       EXTRACT(EPOCH FROM (now() - MIN("createdAt")))::double precision AS "oldestAgeSeconds"
			FROM "outbox_event" WHERE "status" IN ('PENDING', 'LEASED', 'DEAD_LETTER') GROUP BY "status"`,
		client.$queryRaw<
			Array<{
				provider: string;
				succeeded: bigint;
				failed: bigint;
				running: bigint;
				costMicros: bigint;
			}>
		>`
			SELECT "provider",
			 COUNT(*) FILTER (WHERE "status" = 'SUCCEEDED')::bigint AS succeeded,
			 COUNT(*) FILTER (WHERE "status" = 'FAILED')::bigint AS failed,
			 COUNT(*) FILTER (WHERE "status" IN ('CREATED','SUBMISSION_UNCERTAIN','SUBMITTED','RUNNING'))::bigint AS running,
			 COALESCE(SUM("providerCostMicros"), 0)::bigint AS "costMicros"
			FROM "generation_attempt" WHERE "createdAt" >= ${dayStart} GROUP BY "provider" ORDER BY "provider"`,
		client.$queryRaw<Array<{ readyAssets: bigint; readyBytes: bigint }>>`
			SELECT COUNT(*)::bigint AS "readyAssets", COALESCE(SUM("byteSize"),0)::bigint AS "readyBytes"
			FROM "media_asset" WHERE "status" = 'READY'`,
		client.storageUsageReservation.aggregate({
			where: { status: "ACTIVE" },
			_sum: { bytes: true },
		}),
		client.$queryRaw<Array<{ spendable: bigint; reserved: bigint; debt: bigint }>>`
			SELECT COALESCE(SUM("spendableCredits"),0)::bigint AS spendable,
			 COALESCE(SUM("reservedCredits"),0)::bigint AS reserved,
			 COALESCE(SUM("creditDebt"),0)::bigint AS debt FROM "credit_account"`,
		client.creditLedgerEntry.aggregate({ where: { type: "SETTLE" }, _sum: { amount: true } }),
		client.$queryRaw<
			Array<{ revenueMicros: bigint; refundedMicros: bigint; providerCostMicros: bigint }>
		>`
			SELECT
			 COALESCE((SELECT SUM(invoice."paidAmount") * 10000
				FROM (
					SELECT "providerInvoiceId", MAX("paidAmount") AS "paidAmount"
					FROM "billing_period"
					WHERE "createdAt" >= ${dayStart} AND "providerInvoiceId" IS NOT NULL
					GROUP BY "providerInvoiceId"
				) invoice),0)::bigint AS "revenueMicros",
			 COALESCE((SELECT SUM(refund."amount") * 10000
				FROM "stripe_refund" refund
				WHERE refund."status" = 'SUCCEEDED'
				  AND refund."creditsFinalizedAt" >= ${dayStart}),0)::bigint AS "refundedMicros",
			 COALESCE((SELECT SUM("providerCostMicros") FROM "generation_attempt"
				WHERE "completedAt" >= ${dayStart}),0)::bigint AS "providerCostMicros"`,
		client.$queryRaw<
			Array<{
				providerFailed: bigint;
				paymentFailed: bigint;
				paymentDeadLetter: bigint;
				paymentIgnored: bigint;
			}>
		>`
			SELECT
			 (SELECT COUNT(*) FROM "provider_webhook_event" WHERE "status" = 'FAILED')::bigint AS "providerFailed",
			 (SELECT COUNT(*) FROM "payment_event" WHERE "status" = 'FAILED')::bigint AS "paymentFailed",
			 (SELECT COUNT(*) FROM "payment_event" WHERE "status" = 'DEAD_LETTER')::bigint AS "paymentDeadLetter",
			 (SELECT COUNT(*) FROM "payment_event" WHERE "status" = 'IGNORED')::bigint AS "paymentIgnored"`,
		client.paymentEvent.findMany({
			where: { status: "FAILED" },
			select: paymentEventDiagnosticSelect,
			orderBy: [{ lastAttemptAt: { sort: "desc", nulls: "last" } }, { receivedAt: "desc" }],
			take: PAYMENT_EVENT_DIAGNOSTIC_LIMIT,
		}),
		client.paymentEvent.findMany({
			where: { status: "DEAD_LETTER" },
			select: paymentEventDiagnosticSelect,
			orderBy: [{ lastAttemptAt: { sort: "desc", nulls: "last" } }, { receivedAt: "desc" }],
			take: PAYMENT_EVENT_DIAGNOSTIC_LIMIT,
		}),
		client.paymentEvent.findMany({
			where: { status: "IGNORED" },
			select: paymentEventDiagnosticSelect,
			orderBy: [{ lastAttemptAt: { sort: "desc", nulls: "last" } }, { receivedAt: "desc" }],
			take: PAYMENT_EVENT_DIAGNOSTIC_LIMIT,
		}),
		client.$queryRaw<Array<StripeReconciliationCheckpointDiagnosticRow>>`
			SELECT "provider",
			       "status"::text AS status,
			       "stage"::text AS stage,
			       "pagesProcessed" AS pages,
			       "failureCount" AS failures,
			       "sweepCutoff" AS cutoff,
			       "lastAttemptAt" AS "lastAttempt",
			       "lastCompletedAt" AS "lastCompleted",
			       "lastErrorCode" AS "lastError",
			       ("cursor" IS NOT NULL) AS "hasCursor",
			       COALESCE(("status" = 'RUNNING'
			        AND "leaseToken" IS NOT NULL
			        AND "leasedUntil" > now()), false) AS "leaseActive"
			FROM "stripe_reconciliation_checkpoint"
			WHERE "provider" = 'stripe'
			LIMIT 1`,
		client.stripeReconciliationIssue.count({
			where: { provider: "stripe", status: "OPEN" },
		}),
		client.stripeReconciliationIssue.findMany({
			where: { provider: "stripe", status: "OPEN" },
			select: {
				code: true,
				entityType: true,
				providerObjectId: true,
				stage: true,
				occurrences: true,
				firstSeenAt: true,
				lastSeenAt: true,
			},
			orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
			take: STRIPE_RECONCILIATION_DIAGNOSTIC_LIMIT,
		}),
		client.$queryRaw<Array<HistoricalStripeRefundCountRow>>`
			WITH legacy_refund AS (
				SELECT split_part(entry."referenceKey", ':', 2) AS "providerRefundId",
				       SUM(entry."amount")::bigint AS "ledgerCredits"
				FROM "credit_ledger_entry" entry
				WHERE entry."type" = 'REFUND'
				  AND entry."referenceKey" LIKE 'stripe-refund:%'
				  AND entry."referenceKey" ~ '^stripe-refund:re_[A-Za-z0-9_-]+:[^:]+$'
				GROUP BY split_part(entry."referenceKey", ':', 2)
			), compensated_repair AS (
				SELECT refund."providerRefundId", authority."approvedCredits"
				FROM "stripe_refund_repair_authority" authority
				JOIN "stripe_refund_repair_receipt" receipt
				  ON receipt."authorityId" = authority."id"
				 AND receipt."compensatedCredits" = authority."approvedCredits"
				JOIN "stripe_refund" refund ON refund."id" = authority."refundId"
				JOIN "stripe_reconciliation_issue" issue
				  ON issue."id" = authority."issueId"
				 AND issue."provider" = 'stripe'
				 AND issue."entityType" = 'REFUND'
				 AND issue."providerObjectId" = refund."providerRefundId"
				 AND issue."code" = 'STRIPE_LEGACY_REFUND_REPAIR_REQUIRED'
				 AND issue."issueKey" =
				     'stripe:REFUND:' || refund."providerRefundId" || ':STRIPE_LEGACY_REFUND_REPAIR_REQUIRED'
				 AND issue."status" = 'RESOLVED'
				JOIN "credit_ledger_entry" compensation
				  ON compensation."type" IN ('GRANT', 'DEBT_REPAYMENT')
				 AND compensation."metadata" #>> '{command,metadata,authorityId}' = authority."id"
				 AND compensation."metadata" #>> '{command,metadata,providerRefundId}' =
				     refund."providerRefundId"
				WHERE authority."action" = 'COMPENSATE_FAILED_OR_CANCELED'
				GROUP BY refund."providerRefundId", authority."id", authority."approvedCredits"
				HAVING SUM(compensation."amount") = authority."approvedCredits"
			)
			SELECT COUNT(*) FILTER (
			         WHERE (
			                 refund."id" IS NULL
			                 OR refund."status" <> 'SUCCEEDED'
			                 OR refund."creditsFinalizedAt" IS NULL
			                 OR refund."finalizedCredits" < legacy."ledgerCredits"
			               )
			           AND NOT EXISTS (
			                 SELECT 1 FROM compensated_repair repair
			                 WHERE repair."providerRefundId" = legacy."providerRefundId"
			                   AND repair."approvedCredits" = legacy."ledgerCredits"
			               )
			       )::bigint AS "needsReviewCount",
			       COUNT(*) FILTER (WHERE refund."id" IS NULL)::bigint AS "missingLifecycleCount"
			FROM legacy_refund legacy
			LEFT JOIN "stripe_refund" refund
			  ON refund."provider" = 'stripe'
			 AND refund."providerRefundId" = legacy."providerRefundId"`,
		client.$queryRaw<Array<HistoricalStripeRefundDiagnosticRow>>`
			WITH legacy_refund AS (
				SELECT split_part(entry."referenceKey", ':', 2) AS "providerRefundId",
				       COUNT(*)::bigint AS "ledgerEntryCount",
				       SUM(entry."amount")::bigint AS "ledgerCredits",
				       MIN(entry."createdAt") AS "firstLedgerAt",
				       MAX(entry."createdAt") AS "lastLedgerAt"
				FROM "credit_ledger_entry" entry
				WHERE entry."type" = 'REFUND'
				  AND entry."referenceKey" LIKE 'stripe-refund:%'
				  AND entry."referenceKey" ~ '^stripe-refund:re_[A-Za-z0-9_-]+:[^:]+$'
				GROUP BY split_part(entry."referenceKey", ':', 2)
			), compensated_repair AS (
				SELECT refund."providerRefundId", authority."approvedCredits"
				FROM "stripe_refund_repair_authority" authority
				JOIN "stripe_refund_repair_receipt" receipt
				  ON receipt."authorityId" = authority."id"
				 AND receipt."compensatedCredits" = authority."approvedCredits"
				JOIN "stripe_refund" refund ON refund."id" = authority."refundId"
				JOIN "stripe_reconciliation_issue" issue
				  ON issue."id" = authority."issueId"
				 AND issue."provider" = 'stripe'
				 AND issue."entityType" = 'REFUND'
				 AND issue."providerObjectId" = refund."providerRefundId"
				 AND issue."code" = 'STRIPE_LEGACY_REFUND_REPAIR_REQUIRED'
				 AND issue."issueKey" =
				     'stripe:REFUND:' || refund."providerRefundId" || ':STRIPE_LEGACY_REFUND_REPAIR_REQUIRED'
				 AND issue."status" = 'RESOLVED'
				JOIN "credit_ledger_entry" compensation
				  ON compensation."type" IN ('GRANT', 'DEBT_REPAYMENT')
				 AND compensation."metadata" #>> '{command,metadata,authorityId}' = authority."id"
				 AND compensation."metadata" #>> '{command,metadata,providerRefundId}' =
				     refund."providerRefundId"
				WHERE authority."action" = 'COMPENSATE_FAILED_OR_CANCELED'
				GROUP BY refund."providerRefundId", authority."id", authority."approvedCredits"
				HAVING SUM(compensation."amount") = authority."approvedCredits"
			)
			SELECT legacy."providerRefundId",
			       CASE
			         WHEN refund."id" IS NULL THEN 'MISSING_LIFECYCLE'
			         WHEN refund."status" <> 'SUCCEEDED' THEN 'NON_SUCCEEDED_LIFECYCLE'
			         WHEN refund."creditsFinalizedAt" IS NULL THEN 'FINALIZATION_MISSING'
			         ELSE 'CREDIT_TOTAL_MISMATCH'
			       END AS reason,
			       refund."status"::text AS "lifecycleStatus",
			       legacy."ledgerEntryCount",
			       legacy."ledgerCredits",
			       refund."finalizedCredits",
			       refund."creditsFinalizedAt",
			       legacy."firstLedgerAt",
			       legacy."lastLedgerAt"
			FROM legacy_refund legacy
			LEFT JOIN "stripe_refund" refund
			  ON refund."provider" = 'stripe'
			 AND refund."providerRefundId" = legacy."providerRefundId"
			WHERE (
				refund."id" IS NULL
				OR refund."status" <> 'SUCCEEDED'
				OR refund."creditsFinalizedAt" IS NULL
				OR refund."finalizedCredits" < legacy."ledgerCredits"
			)
			  AND NOT EXISTS (
				SELECT 1 FROM compensated_repair repair
				WHERE repair."providerRefundId" = legacy."providerRefundId"
				  AND repair."approvedCredits" = legacy."ledgerCredits"
			  )
			ORDER BY legacy."lastLedgerAt" DESC, legacy."providerRefundId" DESC
			LIMIT ${STRIPE_RECONCILIATION_DIAGNOSTIC_LIMIT}`,
		client.runtimeConfigOverride.findMany({
			where: { active: true },
			select: {
				id: true,
				configKey: true,
				version: true,
				value: true,
				reason: true,
				createdAt: true,
			},
			orderBy: { version: "desc" },
		}),
	]);
	const queue = queueRows[0] ?? { count: 0n, oldestAgeSeconds: null };
	const pendingOutbox = outboxRows.find((row) => row.status === "PENDING");
	const leasedOutbox = outboxRows.find((row) => row.status === "LEASED");
	const deadOutbox = outboxRows.find((row) => row.status === "DEAD_LETTER");
	const oldestOutbox = Math.max(0, ...outboxRows.map((row) => row.oldestAgeSeconds ?? 0));
	const storage = storageRows[0] ?? { readyAssets: 0n, readyBytes: 0n };
	const credits = creditRows[0] ?? { spendable: 0n, reserved: 0n, debt: 0n };
	const finance = financeRows[0] ?? {
		revenueMicros: 0n,
		refundedMicros: 0n,
		providerCostMicros: 0n,
	};
	const events = eventRows[0] ?? {
		providerFailed: 0n,
		paymentFailed: 0n,
		paymentDeadLetter: 0n,
		paymentIgnored: 0n,
	};
	const stripeReconciliationCheckpoint = stripeReconciliationCheckpoints[0];
	const historicalStripeRefundCounts = historicalStripeRefundCountRows[0] ?? {
		needsReviewCount: 0n,
		missingLifecycleCount: 0n,
	};
	const netRevenue = finance.revenueMicros - finance.refundedMicros;
	const guest = await getAdminGuestDiagnostics(client, now, options);
	return {
		generatedAt: now.toISOString(),
		queue: {
			depth: Number(queue.count),
			oldestAgeSeconds: Math.round(queue.oldestAgeSeconds ?? 0),
			stalledJobs,
			needsReconciliation,
		},
		outbox: {
			pending: Number((pendingOutbox?.count ?? 0n) + (leasedOutbox?.count ?? 0n)),
			deadLetter: Number(deadOutbox?.count ?? 0n),
			oldestAgeSeconds: Math.round(oldestOutbox),
		},
		providers: providers.map((row) => ({
			provider: row.provider,
			succeeded: Number(row.succeeded),
			failed: Number(row.failed),
			running: Number(row.running),
			costMicros: row.costMicros.toString(),
		})),
		storage: {
			readyAssets: Number(storage.readyAssets),
			readyBytes: storage.readyBytes.toString(),
			reservedBytes: (reservedStorage._sum.bytes ?? 0n).toString(),
		},
		credits: {
			spendable: credits.spendable.toString(),
			reserved: credits.reserved.toString(),
			debt: credits.debt.toString(),
			settled: (settledRows._sum.amount ?? 0n).toString(),
		},
		finance: {
			revenueMicros: finance.revenueMicros.toString(),
			refundedMicros: finance.refundedMicros.toString(),
			providerCostMicros: finance.providerCostMicros.toString(),
			marginMicros: (netRevenue - finance.providerCostMicros).toString(),
		},
		events: {
			providerFailed: Number(events.providerFailed),
			payment: {
				failed: paymentEventDiagnosticBucket(events.paymentFailed, failedPaymentEvents),
				deadLetter: paymentEventDiagnosticBucket(events.paymentDeadLetter, deadLetterPaymentEvents),
				ignored: paymentEventDiagnosticBucket(events.paymentIgnored, ignoredPaymentEvents),
			},
		},
		stripeReconciliation: {
			checkpoint: stripeReconciliationCheckpoint
				? {
						provider: stripeReconciliationCheckpoint.provider,
						status: stripeReconciliationCheckpoint.status,
						stage: stripeReconciliationCheckpoint.stage,
						pages: stripeReconciliationCheckpoint.pages,
						failures: stripeReconciliationCheckpoint.failures,
						cutoff: stripeReconciliationCheckpoint.cutoff?.toISOString() ?? null,
						lastAttempt: stripeReconciliationCheckpoint.lastAttempt?.toISOString() ?? null,
						lastCompleted: stripeReconciliationCheckpoint.lastCompleted?.toISOString() ?? null,
						lastError: safeStripeDiagnosticCode(stripeReconciliationCheckpoint.lastError),
						hasCursor: stripeReconciliationCheckpoint.hasCursor,
						leaseActive: stripeReconciliationCheckpoint.leaseActive,
					}
				: null,
			issues: {
				openCount: openStripeReconciliationIssueCount,
				items: openStripeReconciliationIssues.map((issue) => ({
					code: safeStripeDiagnosticCode(issue.code) ?? "STRIPE_RECONCILIATION_ERROR_REDACTED",
					entityType: issue.entityType,
					providerObjectId: issue.providerObjectId,
					stage: issue.stage,
					occurrences: issue.occurrences,
					firstSeenAt: issue.firstSeenAt.toISOString(),
					lastSeenAt: issue.lastSeenAt.toISOString(),
				})),
			},
			historicalRefunds: {
				needsReviewCount: Number(historicalStripeRefundCounts.needsReviewCount),
				missingLifecycleCount: Number(historicalStripeRefundCounts.missingLifecycleCount),
				items: historicalStripeRefundRows.map((refund) => ({
					providerRefundId: refund.providerRefundId,
					reason: refund.reason,
					lifecycleStatus: refund.lifecycleStatus,
					ledgerEntryCount: Number(refund.ledgerEntryCount),
					ledgerCredits: refund.ledgerCredits.toString(),
					finalizedCredits: refund.finalizedCredits?.toString() ?? null,
					creditsFinalizedAt: refund.creditsFinalizedAt?.toISOString() ?? null,
					firstLedgerAt: refund.firstLedgerAt.toISOString(),
					lastLedgerAt: refund.lastLedgerAt.toISOString(),
				})),
			},
		},
		overrides: overrides.map((item) => ({
			id: item.id,
			configKey: item.configKey,
			version: item.version,
			enabled: item.value === true,
			reason: item.reason,
			createdAt: item.createdAt.toISOString(),
		})),
		guest,
	};
}

interface GuestDiagnosticRow {
	accepted: bigint;
	queueDepth: bigint;
	oldestQueueAgeSeconds: number | null;
	waitP50Ms: bigint | null;
	waitP95Ms: bigint | null;
	expiredBeforeDispatch: bigint;
	heldRiskMicros: bigint;
	committedRiskMicros: bigint;
	releasedRiskMicros: bigint;
	sponsorGranted: bigint;
	sponsorReserved: bigint;
	sponsorSettled: bigint;
	sponsorReleased: bigint;
	attemptAccepted: bigint;
	attemptRejected: bigint;
	attemptUncertain: bigint;
	uncertainOlderThanTenMinutes: bigint;
	reportedCostCovered: bigint;
	reportedCostMissing: bigint;
	billedSpendMismatch: bigint;
	moderationApproved: bigint;
	moderationRejected: bigint;
	moderationErrors: bigint;
	moderationTotal: bigint;
	watermarkSucceeded: bigint;
	watermarkFailed: bigint;
	readyResults: bigint;
	grantsCompleted: bigint;
	expiredGrants: bigint;
	expiredAssets: bigint;
	overdueAssets: bigint;
	cleanupDeadLetterEvents: bigint;
	oldestOverdueSeconds: number | null;
}

interface GuestDenialRow {
	reason: string;
	count: bigint;
}

async function getAdminGuestDiagnostics(
	client: MediaTransactionClient,
	now: Date,
	options: AdminMediaDiagnosticsOptions,
	applyAutomaticGuestClosure = false,
) {
	const uncertainBefore = new Date(now.getTime() - 10 * 60_000);
	const cleanupOverdueBefore = new Date(now.getTime() - 30 * 60_000);
	const promotionPeriod = options.guestPromotionPeriod ?? "";
	const denialScopePrefix = `guest-denial:${promotionPeriod}:`;
	const [rows, denialRows, runtimeOverride] = await Promise.all([
		client.$queryRaw<Array<GuestDiagnosticRow>>`
			WITH guest_trial AS (
				SELECT * FROM "guest_media_trial" WHERE "promotionPeriod" = ${promotionPeriod}
			), guest_job AS (
				SELECT job.*, trial."frozenQuotedRiskMicros", trial."riskState"::text AS "trialRiskState"
				FROM "generation_job" job
				JOIN guest_trial trial ON trial."id" = job."guestTrialId"
				WHERE job."serviceClass" = 'GUEST_SLOW'::"GenerationServiceClass"
			), guest_attempt AS (
				SELECT attempt.*, job."frozenQuotedRiskMicros"
				FROM "generation_attempt" attempt
				JOIN guest_job job ON job."id" = attempt."jobId"
			), guest_asset AS (
				SELECT DISTINCT asset.*
				FROM "media_asset" asset
				JOIN "generation_job_asset" binding ON binding."assetId" = asset."id"
				JOIN guest_job job ON job."id" = binding."jobId"
				WHERE asset."retentionClass" = 'GUEST_TRIAL'::"MediaRetentionClass"
			), latest_moderation AS (
				SELECT DISTINCT ON (result."assetId") result."assetId", result."status"::text AS status
				FROM "asset_moderation_result" result
				JOIN guest_asset asset ON asset."id" = result."assetId"
				ORDER BY result."assetId", result."verificationGeneration" DESC,
				         result."attemptNumber" DESC, result."createdAt" DESC, result."id" DESC
			)
			SELECT
			 (SELECT COUNT(*) FROM guest_trial)::bigint AS accepted,
			 COUNT(*) FILTER (WHERE job."status" IN ('RESERVED','DISPATCH_QUEUED'))::bigint AS "queueDepth",
			 EXTRACT(EPOCH FROM (${now} - MIN(job."createdAt") FILTER
			   (WHERE job."status" IN ('RESERVED','DISPATCH_QUEUED'))))::double precision AS "oldestQueueAgeSeconds",
			 ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY
			   EXTRACT(EPOCH FROM (job."dispatchEligibleAt" - job."createdAt")) * 1000)
			   FILTER (WHERE job."dispatchEligibleAt" IS NOT NULL))::numeric)::bigint AS "waitP50Ms",
			 ROUND((percentile_cont(0.95) WITHIN GROUP (ORDER BY
			   EXTRACT(EPOCH FROM (job."dispatchEligibleAt" - job."createdAt")) * 1000)
			   FILTER (WHERE job."dispatchEligibleAt" IS NOT NULL))::numeric)::bigint AS "waitP95Ms",
			 COUNT(*) FILTER (WHERE job."failureCode" = 'GUEST_QUEUE_EXPIRED')::bigint AS "expiredBeforeDispatch",
			 COALESCE((SELECT SUM(trial."frozenQuotedRiskMicros") FROM guest_trial trial
			   WHERE trial."riskState" = 'HELD'::"GuestRiskState"), 0)::bigint AS "heldRiskMicros",
			 COALESCE((SELECT SUM(trial."frozenQuotedRiskMicros") FROM guest_trial trial
			   WHERE trial."riskState" = 'COMMITTED'::"GuestRiskState"), 0)::bigint AS "committedRiskMicros",
			 COALESCE((SELECT SUM(trial."frozenQuotedRiskMicros") FROM guest_trial trial
			   WHERE trial."riskState" = 'RELEASED'::"GuestRiskState"), 0)::bigint AS "releasedRiskMicros",
			 COALESCE((SELECT SUM(entry."amount") FROM "credit_ledger_entry" entry
			   JOIN guest_trial trial
			     ON entry."referenceKey" = 'guest-trial:' || trial."id" || ':grant'
			   WHERE entry."type" = 'GRANT'::"CreditLedgerEntryType"), 0)::bigint AS "sponsorGranted",
			 COALESCE(SUM(reservation."amount"), 0)::bigint AS "sponsorReserved",
			 COALESCE(SUM(reservation."settledAmount"), 0)::bigint AS "sponsorSettled",
			 COALESCE(SUM(reservation."releasedAmount"), 0)::bigint AS "sponsorReleased",
			 (SELECT COUNT(*) FROM guest_attempt attempt
			   WHERE attempt."status" IN ('SUBMITTED','RUNNING','SUCCEEDED'))::bigint AS "attemptAccepted",
			 (SELECT COUNT(*) FROM guest_attempt attempt
			   WHERE attempt."status" IN ('FAILED','CANCELED'))::bigint AS "attemptRejected",
			 (SELECT COUNT(*) FROM guest_attempt attempt
			   WHERE attempt."uncertainSubmission" = true OR attempt."status" = 'SUBMISSION_UNCERTAIN')::bigint AS "attemptUncertain",
			 (SELECT COUNT(*) FROM guest_attempt attempt
			   WHERE (attempt."uncertainSubmission" = true OR attempt."status" = 'SUBMISSION_UNCERTAIN')
			     AND attempt."createdAt" < ${uncertainBefore})::bigint AS "uncertainOlderThanTenMinutes",
			 (SELECT COUNT(*) FROM guest_attempt attempt WHERE attempt."providerCostMicros" IS NOT NULL)::bigint AS "reportedCostCovered",
			 (SELECT COUNT(*) FROM guest_attempt attempt WHERE attempt."providerCostMicros" IS NULL)::bigint AS "reportedCostMissing",
			 (SELECT COUNT(*) FROM guest_attempt attempt
			   WHERE attempt."providerCostMicros" > attempt."frozenQuotedRiskMicros")::bigint AS "billedSpendMismatch",
			 (SELECT COUNT(*) FROM latest_moderation WHERE status = 'APPROVED')::bigint AS "moderationApproved",
			 (SELECT COUNT(*) FROM latest_moderation WHERE status IN ('REJECTED','REVIEW'))::bigint AS "moderationRejected",
			 (SELECT COUNT(*) FROM latest_moderation WHERE status = 'ERROR')::bigint AS "moderationErrors",
			 (SELECT COUNT(*) FROM latest_moderation)::bigint AS "moderationTotal",
			 (SELECT COUNT(*) FROM guest_asset asset
			   WHERE asset."kind" = 'OUTPUT' AND asset."watermarkVersion" IS NOT NULL
			     AND asset."watermarkedAt" IS NOT NULL AND asset."cleanStagingDeletedAt" IS NOT NULL)::bigint AS "watermarkSucceeded",
			 COUNT(*) FILTER (WHERE job."failureCode" LIKE 'GUEST%WATERMARK%')::bigint AS "watermarkFailed",
			 (SELECT COUNT(*) FROM guest_asset asset
			   WHERE asset."kind" = 'OUTPUT' AND asset."status" = 'READY'
			     AND asset."watermarkVersion" IS NOT NULL)::bigint AS "readyResults",
			 (SELECT COUNT(*) FROM "guest_result_access_grant" grant_row
			   JOIN guest_trial trial ON trial."id" = grant_row."trialId"
			   WHERE grant_row."consumedAt" IS NOT NULL)::bigint AS "grantsCompleted",
			 (SELECT COUNT(*) FROM "guest_result_access_grant" grant_row
			   JOIN guest_trial trial ON trial."id" = grant_row."trialId"
			   WHERE grant_row."expiresAt" <= ${now})::bigint AS "expiredGrants",
			 (SELECT COUNT(*) FROM guest_asset asset
			   WHERE asset."deleteAfter" <= ${now} AND asset."deletedAt" IS NULL)::bigint AS "expiredAssets",
			 (SELECT COUNT(*) FROM guest_asset asset
			   WHERE asset."deleteAfter" <= ${cleanupOverdueBefore} AND asset."deletedAt" IS NULL)::bigint AS "overdueAssets",
			 (SELECT COUNT(*) FROM "outbox_event" outbox
			   JOIN guest_asset asset ON asset."id" = outbox."aggregateId"
			   WHERE outbox."status" = 'DEAD_LETTER' AND outbox."eventType" IN
			     ('MEDIA_OBJECT_DELETE','MEDIA_UPLOAD_CLEANUP','MEDIA_MULTIPART_ABORT'))::bigint AS "cleanupDeadLetterEvents",
			 EXTRACT(EPOCH FROM (${now} - (SELECT MIN(asset."deleteAfter") FROM guest_asset asset
			   WHERE asset."deleteAfter" <= ${cleanupOverdueBefore} AND asset."deletedAt" IS NULL)))::double precision AS "oldestOverdueSeconds"
			FROM guest_job job
			LEFT JOIN "credit_reservation" reservation ON reservation."jobId" = job."id"`,
		client.$queryRaw<Array<GuestDenialRow>>`
			SELECT substr("scope", char_length(${denialScopePrefix}) + 1) AS reason,
			       SUM("rejectionCount")::bigint AS count
			FROM "guest_abuse_bucket"
			WHERE left("scope", char_length(${denialScopePrefix})) = ${denialScopePrefix}
			  AND "rejectionCount" > 0
			GROUP BY reason
			ORDER BY reason`,
		client.runtimeConfigOverride.findFirst({
			where: { configKey: GUEST_RUNTIME_CONFIG_KEY, active: true },
			select: { value: true },
			orderBy: { version: "desc" },
		}),
	]);
	const row = rows[0] ?? emptyGuestDiagnosticRow();
	const moderationErrorRate = bigintRatio(row.moderationErrors, row.moderationTotal);
	const safety = evaluateGuestOperationalSafety({
		heldRiskMicros: row.heldRiskMicros,
		committedRiskMicros: row.committedRiskMicros,
		riskBudgetMicros: options.guestRiskBudgetMicros ?? 0n,
		queueDepth: Number(row.queueDepth),
		oldestQueueAgeSeconds: Math.round(row.oldestQueueAgeSeconds ?? 0),
		uncertainOlderThanTenMinutes: Number(row.uncertainOlderThanTenMinutes),
		moderationErrorRate,
		watermarkFailures: Number(row.watermarkFailed),
		billedSpendMismatch: Number(row.billedSpendMismatch),
		overdueCleanupAssets: Number(row.overdueAssets),
	});
	let runtimeEnabled = runtimeOverride?.value === true;
	if (
		options.guestEnvironmentEnabled === true &&
		applyAutomaticGuestClosure &&
		safety.automaticOverride &&
		runtimeEnabled
	) {
		await closeGuestAdmissionForSafety(safety.closureReasons, client);
		runtimeEnabled = false;
	}
	return {
		admission: {
			accepted: Number(row.accepted),
			deniedByReason: denialRows.map((denial) => ({
				reason: denial.reason,
				count: Number(denial.count),
			})),
		},
		queue: {
			depth: Number(row.queueDepth),
			oldestAgeSeconds: Math.round(row.oldestQueueAgeSeconds ?? 0),
			waitMs: {
				p50: row.waitP50Ms === null ? null : Number(row.waitP50Ms),
				p95: row.waitP95Ms === null ? null : Number(row.waitP95Ms),
			},
			expiredBeforeDispatch: Number(row.expiredBeforeDispatch),
		},
		risk: {
			budgetMicros: (options.guestRiskBudgetMicros ?? 0n).toString(),
			heldMicros: row.heldRiskMicros.toString(),
			committedMicros: row.committedRiskMicros.toString(),
			releasedMicros: row.releasedRiskMicros.toString(),
			utilizationPercent: safety.utilizationPercent,
			state: safety.riskState,
		},
		sponsorCredits: {
			granted: row.sponsorGranted.toString(),
			reserved: row.sponsorReserved.toString(),
			settled: row.sponsorSettled.toString(),
			released: row.sponsorReleased.toString(),
		},
		attempts: {
			accepted: Number(row.attemptAccepted),
			rejected: Number(row.attemptRejected),
			uncertain: Number(row.attemptUncertain),
			uncertainOlderThanTenMinutes: Number(row.uncertainOlderThanTenMinutes),
			reportedCostCovered: Number(row.reportedCostCovered),
			reportedCostMissing: Number(row.reportedCostMissing),
			billedSpendMismatch: Number(row.billedSpendMismatch),
		},
		moderation: {
			approved: Number(row.moderationApproved),
			rejected: Number(row.moderationRejected),
			errors: Number(row.moderationErrors),
			errorRate: moderationErrorRate,
		},
		watermark: {
			succeeded: Number(row.watermarkSucceeded),
			failed: Number(row.watermarkFailed),
		},
		resultAccess: {
			ready: Number(row.readyResults),
			grantsCompleted: Number(row.grantsCompleted),
			expiredGrants: Number(row.expiredGrants),
		},
		cleanup: {
			expiredAssets: Number(row.expiredAssets),
			overdueAssets: Number(row.overdueAssets),
			deadLetterEvents: Number(row.cleanupDeadLetterEvents),
			oldestOverdueSeconds: Math.round(row.oldestOverdueSeconds ?? 0),
		},
		controls: {
			environmentEnabled: options.guestEnvironmentEnabled === true,
			runtimeEnabled,
			admissionOpen:
				options.guestEnvironmentEnabled === true && runtimeEnabled && !safety.automaticOverride,
			automaticClosureReasons: safety.closureReasons,
		},
	};
}

export async function monitorGuestOperationalSafety(
	client: MediaTransactionClient,
	options: MonitorGuestOperationalSafetyOptions,
) {
	return getAdminGuestDiagnostics(client, options.now ?? new Date(), options, true);
}

async function closeGuestAdmissionForSafety(
	reasons: string[],
	client: MediaTransactionClient,
): Promise<void> {
	await client.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('runtime_config_override_version'))`;
		const active = await tx.runtimeConfigOverride.findFirst({
			where: { configKey: GUEST_RUNTIME_CONFIG_KEY, active: true },
			orderBy: { version: "desc" },
		});
		if (!active || active.value !== true) return;
		await tx.runtimeConfigOverride.updateMany({
			where: { configKey: GUEST_RUNTIME_CONFIG_KEY, active: true },
			data: { active: false, revertedAt: new Date(), revertedByUserId: GUEST_SAFETY_ACTOR },
		});
		const [next] = await tx.$queryRaw<Array<{ version: number }>>`
			SELECT COALESCE(MAX("version"), 0)::int + 1 AS "version" FROM "runtime_config_override"`;
		const created = await tx.runtimeConfigOverride.create({
			data: {
				configKey: GUEST_RUNTIME_CONFIG_KEY,
				version: next!.version,
				value: false,
				reason: `Automatic guest safety closure: ${reasons.join(",")}`,
				createdByUserId: GUEST_SAFETY_ACTOR,
			},
		});
		await tx.auditLog.create({
			data: {
				actorUserId: null,
				action: "MEDIA_GUEST_ADMISSION_AUTOMATICALLY_DISABLED",
				targetType: "RUNTIME_CONFIG_OVERRIDE",
				targetId: created.id,
				after: { configKey: GUEST_RUNTIME_CONFIG_KEY, enabled: false, version: created.version },
				metadata: { reasons },
			},
		});
	});
}

function emptyGuestDiagnosticRow(): GuestDiagnosticRow {
	return {
		accepted: 0n,
		queueDepth: 0n,
		oldestQueueAgeSeconds: null,
		waitP50Ms: null,
		waitP95Ms: null,
		expiredBeforeDispatch: 0n,
		heldRiskMicros: 0n,
		committedRiskMicros: 0n,
		releasedRiskMicros: 0n,
		sponsorGranted: 0n,
		sponsorReserved: 0n,
		sponsorSettled: 0n,
		sponsorReleased: 0n,
		attemptAccepted: 0n,
		attemptRejected: 0n,
		attemptUncertain: 0n,
		uncertainOlderThanTenMinutes: 0n,
		reportedCostCovered: 0n,
		reportedCostMissing: 0n,
		billedSpendMismatch: 0n,
		moderationApproved: 0n,
		moderationRejected: 0n,
		moderationErrors: 0n,
		moderationTotal: 0n,
		watermarkSucceeded: 0n,
		watermarkFailed: 0n,
		readyResults: 0n,
		grantsCompleted: 0n,
		expiredGrants: 0n,
		expiredAssets: 0n,
		overdueAssets: 0n,
		cleanupDeadLetterEvents: 0n,
		oldestOverdueSeconds: null,
	};
}

function safeStripeDiagnosticCode(code: string | null): string | null {
	return code === null || (code.length <= 128 && /^STRIPE_[A-Z0-9_]+$/.test(code))
		? code
		: "STRIPE_RECONCILIATION_ERROR_REDACTED";
}

const paymentEventDiagnosticSelect = {
	id: true,
	providerEventId: true,
	status: true,
	attemptCount: true,
	lastTriggerAttempt: true,
	lastAttemptAt: true,
	lastTriggerRunId: true,
	lastErrorClass: true,
} as const;

function paymentEventDiagnosticBucket(count: bigint, items: PaymentEventDiagnosticRow[]) {
	return {
		count: Number(count),
		items: items.map((item) => ({
			id: item.id,
			providerEventId: item.providerEventId,
			status: item.status,
			attemptCount: item.attemptCount,
			lastTriggerAttempt: item.lastTriggerAttempt,
			lastAttemptAt: item.lastAttemptAt?.toISOString() ?? null,
			lastTriggerRunId: item.lastTriggerRunId,
			lastErrorClass: item.lastErrorClass,
		})),
	};
}
