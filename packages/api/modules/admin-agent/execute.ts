import { createHash, createHmac, randomUUID } from "node:crypto";

import {
	AdminAccessError,
	finishAdminExecution,
	getAdminExecution,
	reserveAdminExecution,
} from "@repo/database/admin-access";
import {
	adminIdempotencyKeySchema,
	type AdminExecutionResult,
} from "@repo/database/admin-agent-contracts";
import { adminScopeKey } from "@repo/database/admin-scope";
import type { Prisma } from "@repo/database/generated-client";

import { requireAdminOperation } from "./auth";
import { AdminGatewayError, type AdminActor, type AdminOperation } from "./types";

const defaultJournal = {
	reserve: reserveAdminExecution,
	get: getAdminExecution,
	finish: finishAdminExecution,
};
export type AdminExecutionJournal = typeof defaultJournal;

/** The hash is keyed: low-entropy settings and secrets are not exposed to offline guessing. */
export function canonicalAdminInput(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalAdminInput).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalAdminInput(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function inputDigest(input: unknown): string {
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret || secret.length < 16)
		throw new AdminGatewayError("ADMIN_JOURNAL_SECRET_UNAVAILABLE", 503);
	return createHmac("sha256", secret)
		.update("ezpic.admin.input.v1\0")
		.update(canonicalAdminInput(input))
		.digest("hex");
}

function executionIdFor(actor: AdminActor, operation: AdminOperation, key?: string): string {
	return operation.readOnly
		? randomUUID()
		: createHash("sha256")
				.update(
					JSON.stringify([
						"admin-execution-v1",
						actor.actorType,
						actor.actorId,
						adminScopeKey(actor.scope),
						operation.name,
						key,
					]),
				)
				.digest("hex");
}

/** Defense in depth in addition to each handler's explicit safe response contract. */
export function redactAdminReplay(value: unknown): Prisma.InputJsonValue {
	if (typeof value === "string") return value.replace(/ez_admin_[A-Za-z0-9_-]{43}/g, "[REDACTED]");
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(redactAdminReplay);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, item]) => item !== undefined)
				.map(([key, item]) => [
					key,
					/^(token|botToken|secret|password|authorization|keyHash|encryptedSecrets)$/i.test(key)
						? item === "" || item === "••••••••"
							? item
							: "[REDACTED]"
						: redactAdminReplay(item),
				]),
		);
	}
	return (value ?? null) as Prisma.InputJsonValue;
}

function targetId(input: unknown): string | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return null;
	const record = input as Record<string, unknown>;
	for (const name of ["id", "orderNo", "requestId", "ticketId", "ownerId", "serviceAccountId"]) {
		const value = record[name];
		if (typeof value === "string" && value.length <= 191 && !value.includes("ez_admin_"))
			return value;
	}
	return null;
}

function knownFailure(error: unknown): { code: string; status: number } | null {
	if (error instanceof AdminAccessError) return { code: error.code, status: error.status };
	// These analytics failures occur before any effect and expose no private details.
	const code = error instanceof Error ? error.message : "";
	if (["ADMIN_ANALYTICS_INVALID_PERIOD", "ADMIN_ANALYTICS_PERIOD_TOO_LONG"].includes(code))
		return { code, status: 400 };
	if (code === "ADMIN_ANALYTICS_DATASET_LIMIT") return { code, status: 412 };
	return null;
}

export function createAdminExecutor(journal: AdminExecutionJournal = defaultJournal) {
	return async function execute(
		operation: AdminOperation,
		rawInput: unknown,
		actor: AdminActor,
		idempotencyKey?: string,
	): Promise<AdminExecutionResult> {
		requireAdminOperation(actor, operation);
		const input = operation.inputSchema.parse(rawInput);
		if (!operation.readOnly && !idempotencyKey)
			throw new AdminGatewayError("ADMIN_IDEMPOTENCY_KEY_REQUIRED", 400);
		if (idempotencyKey) adminIdempotencyKeySchema.parse(idempotencyKey);
		const inputHash = inputDigest(input);
		const executionId = executionIdFor(actor, operation, idempotencyKey);
		const claim = await journal.reserve({
			id: executionId,
			actor,
			operation: operation.name,
			inputHash,
			targetId: targetId(input),
		});
		if (!claim.reserved) {
			const previous = await journal.get(executionId);
			if (!previous) throw new AdminGatewayError("ADMIN_EXECUTION_UNAVAILABLE", 503);
			if (previous.inputHash !== inputHash)
				throw new AdminGatewayError(
					"ADMIN_IDEMPOTENCY_CONFLICT",
					409,
					"The key was already used with different input.",
					executionId,
				);
			if (previous.status === "pending" || previous.status === "unknown") {
				throw new AdminGatewayError(
					"ADMIN_OUTCOME_PENDING_OR_UNKNOWN",
					409,
					"Inspect this execution and its target before another write. Do not use a new key.",
					executionId,
				);
			}
			if (previous.status === "failed") {
				const failure = previous.response as { code?: string; status?: number } | null;
				throw new AdminGatewayError(
					failure?.code ?? previous.errorCode ?? "ADMIN_OPERATION_FAILED",
					failure?.status ?? 400,
					undefined,
					executionId,
				);
			}
			if (operation.omitReplay)
				throw new AdminGatewayError(
					"KEY_ALREADY_ISSUED",
					409,
					"The key was issued once. Its token cannot be recovered. Revoke it if it was not received.",
					executionId,
				);
			return { executionId, replayed: true, result: previous.response };
		}

		try {
			const result = await operation.handler(
				input,
				{
					scope: actor.scope,
					actorId: actor.actorId,
					actorKind: actor.actorType,
					executionId,
					idempotencyKey: executionId,
				},
				actor,
			);
			const safe = redactAdminReplay(result);
			await journal.finish(executionId, {
				status: "completed",
				...(!operation.readOnly && !operation.omitReplay ? { response: safe } : {}),
			});
			return { executionId, replayed: false, result: operation.omitReplay ? result : safe };
		} catch (error) {
			const known = knownFailure(error);
			const status = known || operation.readOnly ? "failed" : "unknown";
			const code =
				known?.code ?? (operation.readOnly ? "ADMIN_READ_FAILED" : "ADMIN_OUTCOME_UNKNOWN");
			await journal
				.finish(executionId, {
					status,
					errorCode: code,
					...(known && !operation.readOnly ? { response: known } : {}),
				})
				.catch(() => undefined);
			throw new AdminGatewayError(
				code,
				known?.status ?? 503,
				known
					? code
					: operation.readOnly
						? "The operation could not be read."
						: "The write may have taken effect. Inspect its execution and target; never retry with a new key.",
				executionId,
			);
		}
	};
}

export const executeAdminOperation = createAdminExecutor();
