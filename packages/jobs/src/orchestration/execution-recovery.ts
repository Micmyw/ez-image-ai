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
export function executionFailureEvidence(error: unknown): { errorCode: string; phase: string } {
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
	return { errorCode: "UNKNOWN", phase: "UNKNOWN" };
}
