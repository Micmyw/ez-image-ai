import type { CreditLedgerEntryType, Prisma } from "../../generated/client";
import type { MediaTransactionClient } from "./types";
import { isDatabaseUniqueConflict } from "./types";

export class IdempotencyConflictError extends Error {
	readonly code = "IDEMPOTENCY_CONFLICT";

	constructor(message: string) {
		super(`IDEMPOTENCY_CONFLICT: ${message}`);
		this.name = "IdempotencyConflictError";
	}
}

export interface CreditCommand {
	kind: "GRANT" | "REFUND" | "RESERVE" | "SETTLE" | "RELEASE";
	amount: string;
	accountId: string;
	reservationId?: string;
	jobId?: string;
	grantReferenceKey?: string;
	expiresAt?: string | null;
	metadata?: Prisma.InputJsonValue;
}

export interface CreditDeltas {
	spendable: string;
	reserved: string;
	debt: string;
}

export function readCreditDeltas(metadata: Prisma.JsonValue): {
	spendable: bigint;
	reserved: bigint;
	debt: bigint;
} {
	const deltas = (metadata as { deltas?: Partial<CreditDeltas> }).deltas;
	if (!deltas?.spendable || !deltas.reserved || !deltas.debt) {
		throw new Error("Credit ledger entry is missing auditable aggregate deltas");
	}
	return {
		spendable: BigInt(deltas.spendable),
		reserved: BigInt(deltas.reserved),
		debt: BigInt(deltas.debt),
	};
}

function normalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeJson);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, normalizeJson(item)]),
		);
	}
	return value;
}

function stableJson(value: unknown): string {
	return JSON.stringify(normalizeJson(value));
}

export function createCreditLedgerMetadata(
	command: CreditCommand,
	result: { ledgerAmount: bigint; lotId?: string | null },
	deltas: { spendable?: bigint; reserved?: bigint; debt?: bigint },
	extra: Record<string, Prisma.InputJsonValue> = {},
): Prisma.InputJsonObject {
	return {
		command: command as unknown as Prisma.InputJsonObject,
		result: {
			ledgerAmount: result.ledgerAmount.toString(),
			lotId: result.lotId ?? null,
		},
		deltas: {
			spendable: (deltas.spendable ?? 0n).toString(),
			reserved: (deltas.reserved ?? 0n).toString(),
			debt: (deltas.debt ?? 0n).toString(),
		},
		...extra,
	};
}

export interface LedgerReplayRow {
	id: string;
	referenceKey: string;
	type: CreditLedgerEntryType;
	accountId: string;
	reservationId: string | null;
	lotId: string | null;
	amount: bigint;
	metadata: Prisma.JsonValue;
}

export function assertCreditLedgerReplay(
	entry: LedgerReplayRow,
	expected: {
		type: CreditLedgerEntryType;
		accountId: string;
		reservationId?: string | null;
		referenceKey?: string;
		command: CreditCommand;
	},
): void {
	const metadata = entry.metadata as {
		command?: unknown;
		result?: { ledgerAmount?: string; lotId?: string | null };
	};
	const isSame =
		entry.type === expected.type &&
		entry.accountId === expected.accountId &&
		entry.reservationId === (expected.reservationId ?? null) &&
		(expected.referenceKey === undefined || entry.referenceKey === expected.referenceKey) &&
		stableJson(metadata.command) === stableJson(expected.command) &&
		metadata.result?.ledgerAmount === entry.amount.toString() &&
		(metadata.result?.lotId ?? null) === entry.lotId;
	if (!isSame) {
		throw new IdempotencyConflictError("reference key was already used by a different command");
	}
}

export function throwReservationReplayConflict(message: string): never {
	throw new IdempotencyConflictError(message);
}

export async function resolveCreditLedgerUniqueRace<T>(
	error: unknown,
	input: {
		referenceKey: string;
		type: CreditLedgerEntryType;
		accountId: string;
		reservationId?: string | null;
		command: CreditCommand;
		resolveResult: (entry: LedgerReplayRow) => Promise<T> | T;
	},
	client: MediaTransactionClient | Prisma.TransactionClient,
): Promise<T> {
	if (!isDatabaseUniqueConflict(error)) throw error;
	const winner = await client.creditLedgerEntry.findUnique({
		where: { referenceKey: input.referenceKey },
	});
	if (!winner) throw error;
	assertCreditLedgerReplay(winner, input);
	return input.resolveResult(winner);
}
