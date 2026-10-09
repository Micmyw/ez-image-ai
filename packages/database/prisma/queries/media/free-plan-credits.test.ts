import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "../../generated/client";
import { hasMatchingFreeMonthlyCreditGrant } from "./free-plan-credits";
import {
	createCreditLedgerMetadata,
	type CreditCommand,
	type LedgerReplayRow,
} from "./idempotency";
import type { MediaTransactionClient } from "./types";

const input = { ownerId: "owner-1", amount: 25n, now: new Date("2026-08-25T06:00:00Z") };
const command: CreditCommand = {
	kind: "GRANT",
	accountId: "account-1",
	amount: "25",
	expiresAt: "2026-09-01T00:00:00.000Z",
	metadata: {
		planId: "free",
		periodStart: "2026-08-01T00:00:00.000Z",
		periodEnd: "2026-09-01T00:00:00.000Z",
	},
};
function ledgerMetadata(input: CreditCommand): Prisma.JsonValue {
	return createCreditLedgerMetadata(input, { ledgerAmount: 0n }, {}) as Prisma.JsonValue;
}
function row(
	overrides: Partial<LedgerReplayRow & { account: { ownerType: string; ownerId: string } }> = {},
) {
	return {
		id: "grant-1",
		accountId: "account-1",
		referenceKey: "free-plan:user:owner-1:2026-08",
		type: "GRANT",
		reservationId: null,
		lotId: null,
		amount: 0n,
		account: { ownerType: "USER", ownerId: "owner-1" },
		metadata: ledgerMetadata(command),
		...overrides,
	};
}

describe("generation free grant immutable identity", () => {
	it("matches the requested command even when the entire grant repaid debt", async () => {
		const findUnique = vi.fn().mockResolvedValue(row());
		await expect(
			hasMatchingFreeMonthlyCreditGrant(input, {
				creditLedgerEntry: { findUnique },
			} as unknown as MediaTransactionClient),
		).resolves.toBe(true);
		expect(findUnique).toHaveBeenCalledTimes(1);
	});

	it.each([
		["missing", null],
		["other owner", row({ account: { ownerType: "USER", ownerId: "other" } })],
		["other owner type", row({ account: { ownerType: "ORGANIZATION", ownerId: "owner-1" } })],
		["other reference", row({ referenceKey: "other-reference" })],
		["other command kind", row({ type: "REFUND" })],
		["missing command", row({ metadata: {} })],
		["uncertain metadata", row({ metadata: null })],
		[
			"requested amount changed",
			row({
				metadata: ledgerMetadata({ ...command, amount: "20" }),
			}),
		],
		[
			"expiry changed",
			row({
				metadata: ledgerMetadata({ ...command, expiresAt: "2026-09-02T00:00:00.000Z" }),
			}),
		],
		[
			"command identity changed",
			row({
				metadata: ledgerMetadata({ ...command, metadata: { planId: "paid" } }),
			}),
		],
	])("returns to the authoritative transaction for %s", async (_label, entry) => {
		const findUnique = vi.fn().mockResolvedValue(entry);
		await expect(
			hasMatchingFreeMonthlyCreditGrant(input, {
				creditLedgerEntry: { findUnique },
			} as unknown as MediaTransactionClient),
		).resolves.toBe(false);
	});
});
