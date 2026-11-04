import { OutputTransferClaimConflictError, SettlementTransactionConflictError } from "../contracts";
import type { TaskRequest } from "./contracts";

export type DatabaseConflictRetry =
	| { status: "retry"; reason: "OUTPUT_TRANSFER_CLAIM_CONFLICT"; phase: "BEFORE_TRANSFER_LEASE" }
	| {
			status: "retry";
			reason: "SETTLEMENT_TRANSACTION_CONFLICT";
			phase: "TRANSACTION_ROLLED_BACK";
	  };

/** Only nominal errors raised after confirmed rollback authorize a fresh task attempt. */
export function databaseConflictRetryFor(
	error: unknown,
	request: TaskRequest,
	supportsDatabaseConflictRetry: boolean,
): DatabaseConflictRetry | undefined {
	if (!supportsDatabaseConflictRetry) return undefined;
	if (error instanceof OutputTransferClaimConflictError)
		return parseDatabaseConflictRetry(request, {
			status: "retry",
			reason: "OUTPUT_TRANSFER_CLAIM_CONFLICT",
			phase: "BEFORE_TRANSFER_LEASE",
		});
	if (error instanceof SettlementTransactionConflictError)
		return parseDatabaseConflictRetry(request, {
			status: "retry",
			reason: "SETTLEMENT_TRANSACTION_CONFLICT",
			phase: "TRANSACTION_ROLLED_BACK",
		});
	return undefined;
}

/** Only this closed, receipt-bound response authorizes the next task attempt. */
export function parseDatabaseConflictRetry(
	request: TaskRequest,
	value: unknown,
): DatabaseConflictRetry | undefined {
	const retry = value as Partial<DatabaseConflictRetry> | null;
	const receipt = request.outboxReceipt;
	if (
		!receipt ||
		![receipt.eventId, receipt.leaseToken].every(
			(id) => typeof id === "string" && /^[a-zA-Z0-9_:-]{1,256}$/.test(id),
		) ||
		typeof receipt.workerId !== "string" ||
		!receipt.workerId.trim() ||
		receipt.workerId.length > 2_048 ||
		receipt.workerId.includes("\0") ||
		!retry ||
		typeof retry !== "object" ||
		Array.isArray(retry) ||
		Object.keys(retry).some((key) => !["status", "reason", "phase"].includes(key)) ||
		retry.status !== "retry"
	)
		return undefined;
	if (
		request.taskId === "media-finalize-generation" &&
		retry.reason === "OUTPUT_TRANSFER_CLAIM_CONFLICT" &&
		retry.phase === "BEFORE_TRANSFER_LEASE"
	)
		return { status: "retry", reason: retry.reason, phase: retry.phase };
	if (
		request.taskId === "media-settle-generation" &&
		retry.reason === "SETTLEMENT_TRANSACTION_CONFLICT" &&
		retry.phase === "TRANSACTION_ROLLED_BACK"
	)
		return { status: "retry", reason: retry.reason, phase: retry.phase };
	return undefined;
}

/** Logs carry closed diagnostic codes only; they are never retry authorization. */
export interface ExecutionFailureEvidence {
	errorCode: string;
	phase: string;
	/** Constructor name such as TypeError or StripeAuthenticationError. */
	errorName?: string;
	/** Explicitly allowlisted internal diagnostic codes, never arbitrary messages. */
	messageCodes?: string[];
}

const SAFE_ERROR_NAMES = new Set([
	"Error",
	"AggregateError",
	"TypeError",
	"RangeError",
	"SyntaxError",
	"AbortError",
	"PrismaClientKnownRequestError",
	"PrismaClientUnknownRequestError",
	"PrismaClientInitializationError",
	"PrismaClientRustPanicError",
	"StripeAuthenticationError",
]);
const SAFE_MESSAGE_CODES = new Set([
	"PAYMENT_RECONCILIATION_FAILED",
	"PAYPAL_EVENTS_UNAVAILABLE",
	"STRIPE_LEGACY_LIFECYCLE_INCOMPLETE",
	"MAINTENANCE_FAILED",
	"PROVIDER_RECOVERY_UNAVAILABLE",
	"OUTBOX_RECOVERY_REQUIRED",
]);

/**
 * Logs only identifiers that cannot carry prompts, URLs, tokens or customer data,
 * so an UNKNOWN failure (for example the hourly media-reconcile-subscriptions
 * MAINTENANCE_FAILED) can still be attributed from the job_execution_failed line.
 */
function safeFailureIdentifiers(
	error: unknown,
): Pick<ExecutionFailureEvidence, "errorName" | "messageCodes"> {
	const codes = new Set<string>();
	let errorName: string | undefined;
	const visit = (value: unknown, depth: number) => {
		if (!value || typeof value !== "object" || depth > 3 || codes.size >= 8) return;
		const candidate = value as {
			name?: unknown;
			message?: unknown;
			code?: unknown;
			cause?: unknown;
			errors?: unknown;
		};
		if (
			errorName === undefined &&
			typeof candidate.name === "string" &&
			SAFE_ERROR_NAMES.has(candidate.name)
		)
			errorName = candidate.name;
		for (const text of [candidate.message, candidate.code])
			if (typeof text === "string" && SAFE_MESSAGE_CODES.has(text)) codes.add(text);
		if (Array.isArray(candidate.errors))
			for (const inner of candidate.errors.slice(0, 8)) visit(inner, depth + 1);
		visit(candidate.cause, depth + 1);
	};
	try {
		visit(error, 0);
	} catch {
		// Untrusted getters never replace the original failure.
	}
	return {
		...(errorName ? { errorName } : {}),
		...(codes.size ? { messageCodes: [...codes] } : {}),
	};
}

export function executionFailureEvidence(error: unknown): ExecutionFailureEvidence {
	const original = error;
	if (error instanceof OutputTransferClaimConflictError)
		return { errorCode: "OUTPUT_TRANSFER_CLAIM_CONFLICT", phase: "BEFORE_TRANSFER_LEASE" };
	if (error instanceof SettlementTransactionConflictError)
		return { errorCode: "SETTLEMENT_TRANSACTION_CONFLICT", phase: "TRANSACTION_ROLLED_BACK" };
	const allowed = new Set([
		"P1001",
		"P1002",
		"P1017",
		"P2028",
		"P2034",
		"40001",
		"40P01",
		"53300",
		"55P03",
		"57014",
		"ECONNRESET",
		"ECONNREFUSED",
		"ETIMEDOUT",
		"TransactionWriteConflict",
		"OUTBOX_RECOVERY_REQUIRED",
	]);
	const allowedOriginalCodes = new Set(["40001", "40P01", "53300", "55P03", "57014"]);
	try {
		for (let depth = 0; depth < 4 && error && typeof error === "object"; depth++) {
			const value = error as {
				code?: unknown;
				originalCode?: unknown;
				cause?: unknown;
				meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
			};
			if (typeof value.code === "string" && allowed.has(value.code))
				return { errorCode: value.code, phase: "UNKNOWN" };
			// Prisma adapter errors retain PostgreSQL SQLSTATE here, including connection
			// rejection. Reading it improves diagnostics, never proves a safe rollback.
			for (const originalCode of [
				value.originalCode,
				value.meta?.driverAdapterError?.cause?.originalCode,
			])
				if (typeof originalCode === "string" && allowedOriginalCodes.has(originalCode))
					return { errorCode: originalCode, phase: "UNKNOWN" };
			error = value.cause;
		}
	} catch {
		// Untrusted error properties cannot replace the original failure.
	}
	return { errorCode: "UNKNOWN", phase: "UNKNOWN", ...safeFailureIdentifiers(original) };
}
