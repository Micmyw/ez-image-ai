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

const PAYMENT_EVENT_DIAGNOSTIC_LIMIT = 25;

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

export async function getAdminMediaDiagnostics(client: MediaTransactionClient) {
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
			 COALESCE((SELECT SUM((event."envelope" #>> '{data,object,amount_paid}')::bigint) * 10000
				FROM "payment_event" event
				WHERE event."status" = 'PROCESSED' AND event."processedAt" >= ${dayStart}
				  AND event."envelope" ->> 'type' = 'invoice.paid'),0)::bigint AS "revenueMicros",
			 COALESCE((SELECT SUM(CASE event."envelope" ->> 'type'
				WHEN 'refund.created' THEN (event."envelope" #>> '{data,object,amount}')::bigint
				WHEN 'charge.refund.updated' THEN (event."envelope" #>> '{data,object,amount}')::bigint
				ELSE 0 END) * 10000
				FROM "payment_event" event
				WHERE event."status" = 'PROCESSED' AND event."processedAt" >= ${dayStart}
				  AND event."envelope" ->> 'type' IN ('refund.created', 'charge.refund.updated')),0)::bigint AS "refundedMicros",
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
	const netRevenue = finance.revenueMicros - finance.refundedMicros;
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
		overrides: overrides.map((item) => ({
			id: item.id,
			configKey: item.configKey,
			version: item.version,
			enabled: item.value === true,
			reason: item.reason,
			createdAt: item.createdAt.toISOString(),
		})),
	};
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
