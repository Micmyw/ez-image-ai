import { describe, expect, it } from "vitest";

import { OutputTransferClaimConflictError, SettlementTransactionConflictError } from "../contracts";
import {
	executionFailureEvidence,
	databaseConflictRetryFor,
	parseDatabaseConflictRetry,
} from "./execution-recovery";

const request = {
	taskId: "media-finalize-generation",
	payload: { jobId: "job", version: 0 },
	outboxReceipt: { eventId: "event", workerId: "workflow:run", leaseToken: "token" },
};

describe("closed execution failure evidence", () => {
	it("allows settlement only after a nominal whole-transaction rollback with a valid receipt", () => {
		const settlement = { ...request, taskId: "media-settle-generation" };
		const retry = {
			status: "retry",
			reason: "SETTLEMENT_TRANSACTION_CONFLICT",
			phase: "TRANSACTION_ROLLED_BACK",
		};
		const conflict = new SettlementTransactionConflictError({ code: "55P03" });
		expect(databaseConflictRetryFor(conflict, settlement, true)).toEqual(retry);
		expect(parseDatabaseConflictRetry(settlement, retry)).toEqual(retry);
		expect(executionFailureEvidence(conflict)).toEqual({
			errorCode: retry.reason,
			phase: retry.phase,
		});
		for (const error of [
			Object.assign(new Error("SettlementTransactionConflictError"), {
				code: retry.reason,
				phase: retry.phase,
			}),
			{ code: "P2034" },
			{ code: "40001" },
			{ code: "55P03" },
			new Error("COMMIT response lost", { cause: { code: "ECONNRESET" } }),
			new OutputTransferClaimConflictError({ code: "40001" }),
		])
			expect(databaseConflictRetryFor(error, settlement, true)).toBeUndefined();
		for (const unsafeRequest of [
			request,
			{ ...settlement, taskId: "media-process-payment-event" },
			{ ...settlement, outboxReceipt: undefined },
			{ ...settlement, outboxReceipt: { ...settlement.outboxReceipt, leaseToken: "" } },
		])
			expect(databaseConflictRetryFor(conflict, unsafeRequest, true)).toBeUndefined();
		expect(databaseConflictRetryFor(conflict, settlement, false)).toBeUndefined();
		for (const response of [
			{ ...retry, phase: "BEFORE_TRANSFER_LEASE" },
			{ ...retry, reason: "OUTPUT_TRANSFER_CLAIM_CONFLICT" },
			{ ...retry, unknown: "private" },
			{ ...retry, status: "failed" },
		])
			expect(parseDatabaseConflictRetry(settlement, response)).toBeUndefined();
	});
	it("requires the nominal rollback error, never a matching name/code/message", () => {
		const forged = Object.assign(new Error("OUTPUT_TRANSFER_CLAIM_CONFLICT"), {
			name: "OutputTransferClaimConflictError",
			code: "OUTPUT_TRANSFER_CLAIM_CONFLICT",
			phase: "BEFORE_TRANSFER_LEASE",
		});
		expect(databaseConflictRetryFor(forged, request, true)).toBeUndefined();
		expect(
			databaseConflictRetryFor(new OutputTransferClaimConflictError(forged), request, true),
		).toEqual({
			status: "retry",
			reason: "OUTPUT_TRANSFER_CLAIM_CONFLICT",
			phase: "BEFORE_TRANSFER_LEASE",
		});
	});
	it("projects only whitelisted codes without messages, URLs, payloads, causes or stacks", () => {
		const cause = { code: "40001", message: "secret", stack: "private URL", payload: "prompt" };
		expect(executionFailureEvidence(new Error("private", { cause }))).toEqual({
			errorCode: "40001",
			phase: "UNKNOWN",
		});
		expect(
			executionFailureEvidence({
				code: "https://private?token=secret",
				phase: "BEFORE_TRANSFER_LEASE",
			}),
		).toEqual({ errorCode: "UNKNOWN", phase: "UNKNOWN" });
		expect(executionFailureEvidence(new OutputTransferClaimConflictError(cause))).toEqual({
			errorCode: "OUTPUT_TRANSFER_CLAIM_CONFLICT",
			phase: "BEFORE_TRANSFER_LEASE",
		});
	});
	it.each([
		{ cause: { originalCode: "53300", kind: "TooManyConnections" } },
		{ code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "53300" } } } },
		{ cause: { meta: { driverAdapterError: { cause: { originalCode: "53300" } } } } },
	])("projects nested Prisma driver codes without authorizing a retry: %j", (error) => {
		expect(executionFailureEvidence(error)).toEqual({ errorCode: "53300", phase: "UNKNOWN" });
		for (const taskId of [
			"media-finalize-generation",
			"media-settle-generation",
			"media-dispatch-image-kie-nano-banana-2",
		])
			expect(databaseConflictRetryFor(error, { ...request, taskId }, true)).toBeUndefined();
	});
	it("projects only known PostgreSQL original codes and never reads diagnostic text", () => {
		for (const originalCode of ["40001", "40P01", "53300", "55P03", "57014"]) {
			const cause = {
				originalCode,
				get originalMessage() {
					throw new Error("private database error");
				},
				get message() {
					throw new Error("private URL");
				},
			};
			expect(executionFailureEvidence({ meta: { driverAdapterError: { cause } } })).toEqual({
				errorCode: originalCode,
				phase: "UNKNOWN",
			});
		}
		for (const originalCode of [
			"https://private?token=secret",
			"53300\nsecret",
			"OUTBOX_RECOVERY_REQUIRED",
			"TooManyConnections",
			53300,
			{ code: "53300" },
		])
			expect(executionFailureEvidence({ cause: { originalCode } })).toEqual({
				errorCode: "UNKNOWN",
				phase: "UNKNOWN",
			});
	});
	it("preserves existing code precedence and bounds nested driver evidence", () => {
		expect(
			executionFailureEvidence({
				code: "P2034",
				meta: { driverAdapterError: { cause: { originalCode: "40001" } } },
			}),
		).toEqual({ errorCode: "P2034", phase: "UNKNOWN" });
		const tooDeep = { cause: { cause: { cause: { cause: { originalCode: "53300" } } } } };
		expect(executionFailureEvidence(tooDeep)).toEqual({ errorCode: "UNKNOWN", phase: "UNKNOWN" });
	});
	it("contains throwing original-code and metadata properties", () => {
		for (const error of [
			{
				cause: {
					get originalCode() {
						throw new Error("secret");
					},
				},
			},
			{
				get meta() {
					throw new Error("secret");
				},
			},
			{
				meta: {
					driverAdapterError: {
						get cause() {
							throw new Error("secret");
						},
					},
				},
			},
		])
			expect(executionFailureEvidence(error)).toEqual({ errorCode: "UNKNOWN", phase: "UNKNOWN" });
	});
	it("bounds recursive causes and survives throwing error properties", () => {
		const recursive: { cause?: unknown } = {};
		recursive.cause = recursive;
		expect(executionFailureEvidence(recursive)).toEqual({ errorCode: "UNKNOWN", phase: "UNKNOWN" });
		expect(
			executionFailureEvidence({
				get code() {
					throw new Error("secret");
				},
			}),
		).toEqual({ errorCode: "UNKNOWN", phase: "UNKNOWN" });
	});
});
