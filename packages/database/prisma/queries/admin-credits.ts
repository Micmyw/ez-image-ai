import { adminScopeAllowsOwner, type AdminScope } from "../../shared/admin-scope";
import { db } from "../client";
import type { Prisma } from "../generated/client";
import { AdminAccessError } from "./admin-access";
import { ensureCreditAccountInTransaction } from "./media/credit-accounts";
import { createCreditGrant, expireCreditLotsInTransaction } from "./media/credits";
import {
	assertCreditLedgerReplay,
	createCreditLedgerMetadata,
	type CreditCommand,
	IdempotencyConflictError,
} from "./media/idempotency";
import { runSerializable, type MediaTransactionClient } from "./media/types";

export interface AdjustAdminCreditsInput {
	scope: AdminScope;
	actorId: string;
	idempotencyKey: string;
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
	action: "grant" | "deduct";
	credits: number;
	reason: string;
}

export function planAdminCreditDeduction(
	amount: bigint,
	lots: ReadonlyArray<{ id: string; remainingAmount: bigint }>,
) {
	if (amount <= 0n) throw new AdminAccessError("ADMIN_CREDITS_AMOUNT_INVALID");
	let remaining = amount;
	const deductions: Array<{ id: string; amount: bigint }> = [];
	for (const lot of lots) {
		if (lot.remainingAmount < 0n) throw new AdminAccessError("ADMIN_CREDITS_LOT_INVALID", 409);
		const debit = lot.remainingAmount < remaining ? lot.remainingAmount : remaining;
		if (debit > 0n) deductions.push({ id: lot.id, amount: debit });
		remaining -= debit;
		if (remaining === 0n) break;
	}
	if (remaining !== 0n) throw new AdminAccessError("ADMIN_CREDITS_INSUFFICIENT_BALANCE", 409);
	return deductions;
}

/** Independent gift/debit. Gifts retain existing debt repayment; debits spend only available lots. */
export async function adjustAdminCredits(
	input: AdjustAdminCreditsInput,
	client: MediaTransactionClient = db,
) {
	if (!adminScopeAllowsOwner(input.scope, input))
		throw new AdminAccessError("ADMIN_SCOPE_FORBIDDEN", 403);
	if (
		!Number.isSafeInteger(input.credits) ||
		input.credits <= 0 ||
		input.credits > 1_000_000_000 ||
		!input.reason.trim() ||
		input.reason.length > 500 ||
		!input.actorId ||
		!/^[A-Za-z0-9_.:-]{8,128}$/.test(input.idempotencyKey) ||
		!["grant", "deduct"].includes(input.action)
	)
		throw new AdminAccessError("ADMIN_CREDITS_INPUT_INVALID");
	const amount = BigInt(input.credits);
	const referenceKey = `admin-credit:${input.actorId}:${input.idempotencyKey}`;
	return runSerializable(client, async (tx) => {
		const owner =
			input.ownerType === "USER"
				? await tx.user.findUnique({ where: { id: input.ownerId }, select: { id: true } })
				: await tx.organization.findUnique({ where: { id: input.ownerId }, select: { id: true } });
		if (!owner) throw new AdminAccessError("ADMIN_CREDITS_OWNER_NOT_FOUND", 404);
		const account = await ensureCreditAccountInTransaction(
			{ ownerType: input.ownerType, ownerId: input.ownerId },
			tx,
		);
		await tx.$queryRaw`SELECT "id" FROM "credit_account" WHERE "id" = ${account.id} FOR UPDATE`;
		const metadata = {
			source: "ADMIN_ADJUSTMENT",
			actorId: input.actorId,
			reason: input.reason.trim(),
		};
		const before = await tx.creditLedgerEntry.findUnique({ where: { referenceKey } });
		let entry: { id: string };
		if (input.action === "grant") {
			entry = await createCreditGrant(
				{ accountId: account.id, amount, referenceKey, metadata },
				tx,
			);
		} else {
			const command: CreditCommand = {
				kind: "ADMIN_DEDUCT",
				accountId: account.id,
				amount: amount.toString(),
				metadata,
			};
			if (before) {
				assertCreditLedgerReplay(before, {
					type: "ADMIN_DEDUCT",
					accountId: account.id,
					referenceKey,
					command,
				});
				entry = before;
			} else {
				await expireCreditLotsInTransaction({ accountId: account.id }, tx);
				const lots = await tx.$queryRaw<Array<{ id: string; remainingAmount: bigint }>>`
					SELECT "id", "remainingAmount" FROM "credit_lot"
					WHERE "accountId" = ${account.id} AND "remainingAmount" > 0
					ORDER BY "expiresAt" ASC NULLS LAST, "createdAt", "id" FOR UPDATE`;
				const deductions = planAdminCreditDeduction(amount, lots);
				for (const deduction of deductions) {
					await tx.creditLot.update({
						where: { id: deduction.id },
						data: { remainingAmount: { decrement: deduction.amount } },
					});
				}
				const changed = await tx.creditAccount.updateMany({
					where: { id: account.id, spendableCredits: { gte: amount } },
					data: { spendableCredits: { decrement: amount }, version: { increment: 1 } },
				});
				if (changed.count !== 1) throw new AdminAccessError("ADMIN_CREDITS_ACCOUNT_CONFLICT", 409);
				entry = await tx.creditLedgerEntry.create({
					data: {
						accountId: account.id,
						type: "ADMIN_DEDUCT",
						amount,
						referenceKey,
						metadata: createCreditLedgerMetadata(
							command,
							{ ledgerAmount: amount },
							{ spendable: -amount },
							{
								lots: deductions.map((deduction) => ({
									lotId: deduction.id,
									amount: deduction.amount.toString(),
								})),
							},
						),
					},
				});
			}
		}
		const current = await tx.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
		const result = {
			accountId: account.id,
			entryId: entry.id,
			action: input.action,
			amount: amount.toString(),
			spendableCredits: current.spendableCredits.toString(),
			creditDebt: current.creditDebt.toString(),
		};
		if (!before)
			await tx.auditLog.create({
				data: {
					action: input.action === "grant" ? "ADMIN_CREDITS_GRANTED" : "ADMIN_CREDITS_DEDUCTED",
					targetType: "CREDIT_ACCOUNT",
					targetId: account.id,
					after: result,
					metadata: {
						actorId: input.actorId,
						ownerType: input.ownerType,
						ownerId: input.ownerId,
						reason: input.reason.trim(),
						referenceKey,
					} satisfies Prisma.InputJsonObject,
				},
			});
		return result;
	}).catch((error) => {
		// This exception is produced by immutable-command comparison while the
		// surrounding transaction is rolled back, never by an uncertain commit.
		if (error instanceof IdempotencyConflictError)
			throw new AdminAccessError("ADMIN_CREDITS_IDEMPOTENCY_CONFLICT", 409);
		throw error;
	});
}
