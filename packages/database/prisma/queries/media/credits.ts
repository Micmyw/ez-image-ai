import { Prisma } from "../../generated/client";
import {
	assertCreditLedgerReplay,
	createCreditLedgerMetadata,
	type CreditCommand,
	IdempotencyConflictError,
	readCreditDeltas,
	resolveCreditLedgerUniqueRace,
	throwReservationReplayConflict,
} from "./idempotency";
import type {
	CreditGrantInput,
	CreditMutationInput,
	CreditRefundInput,
	MediaDatabaseClient,
	MediaTransactionClient,
	ReserveCreditsInput,
	SerializableExecutionOptions,
} from "./types";
import { getMediaDatabaseClient, isDatabaseUniqueConflict, runSerializable } from "./types";

interface LockedLot {
	id: string;
	remainingAmount: bigint;
	reservedAmount: bigint;
	grantReferenceKey: string;
	expiresAt: Date | null;
}

interface LockedAllocation {
	id: string;
	lotId: string;
	amount: bigint;
	settledAmount: bigint;
	releasedAmount: bigint;
	revokedAmount: bigint;
	revokedSettledAmount: bigint;
	revokedReleasedAmount: bigint;
}

async function lockAccount(tx: Prisma.TransactionClient, accountId: string) {
	const rows = await tx.$queryRaw<
		Array<{ id: string; spendableCredits: bigint; reservedCredits: bigint; creditDebt: bigint }>
	>`SELECT "id", "spendableCredits", "reservedCredits", "creditDebt"
	  FROM "credit_account" WHERE "id" = ${accountId} FOR UPDATE`;
	const account = rows[0];
	if (!account) throw new Error("Credit account not found");
	return account;
}

async function lockAllLots(tx: Prisma.TransactionClient, accountId: string) {
	return tx.$queryRaw<LockedLot[]>`
		SELECT "id", "remainingAmount", "reservedAmount", "grantReferenceKey", "expiresAt"
		FROM "credit_lot"
		WHERE "accountId" = ${accountId}
		ORDER BY "expiresAt" ASC NULLS LAST, "createdAt" ASC, "id" ASC
		FOR UPDATE`;
}

async function lockMatchingActiveAllocations(
	tx: Prisma.TransactionClient,
	accountId: string,
	lotIds: string[],
) {
	if (lotIds.length === 0) return [];
	return tx.$queryRaw<LockedAllocation[]>`
		SELECT allocation."id", allocation."lotId", allocation."amount",
		       allocation."settledAmount", allocation."releasedAmount", allocation."revokedAmount",
		       allocation."revokedSettledAmount", allocation."revokedReleasedAmount"
		FROM "credit_reservation" reservation
		JOIN "credit_reservation_allocation" allocation
		  ON allocation."reservationId" = reservation."id"
		JOIN "credit_lot" lot ON lot."id" = allocation."lotId"
		WHERE reservation."accountId" = ${accountId}
		  AND reservation."status" = 'ACTIVE'
		  AND allocation."lotId" IN (${Prisma.join(lotIds)})
		ORDER BY reservation."createdAt" ASC, reservation."id" ASC,
		         lot."expiresAt" ASC NULLS LAST, lot."createdAt" ASC, lot."id" ASC
		FOR UPDATE OF reservation, allocation`;
}

function createGrantCommand(input: CreditGrantInput): CreditCommand {
	return {
		kind: "GRANT",
		accountId: input.accountId,
		amount: input.amount.toString(),
		expiresAt: input.expiresAt?.toISOString() ?? null,
		metadata: input.metadata ?? {},
	};
}

function createRefundCommand(input: CreditRefundInput): CreditCommand {
	return {
		kind: "REFUND",
		accountId: input.accountId,
		amount: input.amount.toString(),
		grantReferenceKey: input.grantReferenceKey,
		metadata: input.metadata ?? {},
	};
}

function createReserveCommand(input: ReserveCreditsInput): CreditCommand {
	return {
		kind: "RESERVE",
		accountId: input.accountId,
		amount: input.amount.toString(),
		jobId: input.jobId,
	};
}

function createExpireCommand(input: { accountId: string; amount: bigint }): CreditCommand {
	return { kind: "EXPIRE", accountId: input.accountId, amount: input.amount.toString() };
}

function createFinalizeCommand(
	kind: "SETTLE" | "RELEASE",
	input: CreditMutationInput,
	accountId: string,
): CreditCommand {
	return {
		kind,
		accountId,
		amount: input.amount.toString(),
		reservationId: input.reservationId,
	};
}

async function materializeExpiredLots(
	tx: Prisma.TransactionClient,
	input: { accountId: string; lots: LockedLot[]; now: Date },
) {
	let expired = 0n;
	for (const lot of input.lots) {
		if (!lot.expiresAt || lot.expiresAt > input.now || lot.remainingAmount === 0n) continue;
		const referenceKey = `credit-lot:${lot.id}:expiry`;
		const command = createExpireCommand({
			accountId: input.accountId,
			amount: lot.remainingAmount,
		});
		const replay = await tx.creditLedgerEntry.findUnique({ where: { referenceKey } });
		if (replay) {
			assertCreditLedgerReplay(replay, {
				type: "EXPIRE",
				accountId: input.accountId,
				referenceKey,
				command,
			});
			throw new IdempotencyConflictError("expired lot retains spendable credits");
		}
		await tx.creditLot.update({ where: { id: lot.id }, data: { remainingAmount: 0n } });
		await tx.creditLedgerEntry.create({
			data: {
				accountId: input.accountId,
				lotId: lot.id,
				type: "EXPIRE",
				amount: lot.remainingAmount,
				referenceKey,
				metadata: createCreditLedgerMetadata(
					command,
					{ ledgerAmount: lot.remainingAmount, lotId: lot.id },
					{ spendable: -lot.remainingAmount },
				),
			},
		});
		expired += lot.remainingAmount;
		lot.remainingAmount = 0n;
	}
	if (expired > 0n) {
		await tx.creditAccount.update({
			where: { id: input.accountId },
			data: { spendableCredits: { decrement: expired }, version: { increment: 1 } },
		});
	}
	return expired;
}

export async function reserveCreditsInTransaction(
	input: ReserveCreditsInput,
	tx: Prisma.TransactionClient,
) {
	if (input.amount <= 0n) throw new Error("Reservation amount must be positive");
	const replay = await tx.creditReservation.findUnique({ where: { jobId: input.jobId } });
	if (replay) {
		const ledger = await tx.creditLedgerEntry.findFirst({
			where: { reservationId: replay.id, type: "RESERVE" },
		});
		if (!ledger) throwReservationReplayConflict("reservation is missing its reserve ledger entry");
		assertCreditLedgerReplay(ledger, {
			type: "RESERVE",
			accountId: input.accountId,
			reservationId: replay.id,
			referenceKey: input.referenceKey,
			command: createReserveCommand(input),
		});
		if (replay.accountId !== input.accountId || replay.amount !== input.amount) {
			throwReservationReplayConflict("job was already reserved with different parameters");
		}
		return replay;
	}
	if (await tx.creditLedgerEntry.findUnique({ where: { referenceKey: input.referenceKey } })) {
		throwReservationReplayConflict("reference key was already used by a different command");
	}

	const account = await lockAccount(tx, input.accountId);
	if (account.creditDebt > 0n) throw new Error("CREDIT_DEBT_OUTSTANDING");
	const lots = await lockAllLots(tx, input.accountId);
	const now = new Date();
	const expired = await materializeExpiredLots(tx, { accountId: input.accountId, lots, now });
	if (account.spendableCredits - expired < input.amount) throw new Error("INSUFFICIENT_CREDITS");

	let unallocated = input.amount;
	const allocations: Array<{ lotId: string; amount: bigint }> = [];
	for (const lot of lots) {
		if (unallocated === 0n) break;
		if (lot.expiresAt && lot.expiresAt <= now) continue;
		const amount = lot.remainingAmount < unallocated ? lot.remainingAmount : unallocated;
		if (amount === 0n) continue;
		await tx.creditLot.update({
			where: { id: lot.id },
			data: { remainingAmount: { decrement: amount }, reservedAmount: { increment: amount } },
		});
		allocations.push({ lotId: lot.id, amount });
		unallocated -= amount;
	}
	if (unallocated !== 0n) throw new Error("INSUFFICIENT_CREDITS");

	const reservation = await tx.creditReservation.create({
		data: { accountId: input.accountId, jobId: input.jobId, amount: input.amount },
	});
	await tx.creditReservationAllocation.createMany({
		data: allocations.map((allocation) => ({
			reservationId: reservation.id,
			...allocation,
		})),
	});
	await tx.creditAccount.update({
		where: { id: input.accountId },
		data: {
			spendableCredits: { decrement: input.amount },
			reservedCredits: { increment: input.amount },
			version: { increment: 1 },
		},
	});
	await tx.creditLedgerEntry.create({
		data: {
			accountId: input.accountId,
			reservationId: reservation.id,
			type: "RESERVE",
			amount: input.amount,
			referenceKey: input.referenceKey,
			metadata: createCreditLedgerMetadata(
				createReserveCommand(input),
				{ ledgerAmount: input.amount },
				{ spendable: -input.amount, reserved: input.amount },
			),
		},
	});
	return reservation;
}

export async function reserveCredits(input: ReserveCreditsInput, client: MediaTransactionClient) {
	const command = createReserveCommand(input);
	try {
		return await runSerializable(client, (tx) => reserveCreditsInTransaction(input, tx));
	} catch (error) {
		if (!isDatabaseUniqueConflict(error)) throw error;
		const winner = await client.creditReservation.findUnique({ where: { jobId: input.jobId } });
		if (!winner) {
			return resolveCreditLedgerUniqueRace(
				error,
				{
					referenceKey: input.referenceKey,
					type: "RESERVE",
					accountId: input.accountId,
					command,
					resolveResult: async (ledger) => {
						if (!ledger.reservationId) {
							throwReservationReplayConflict("reserve ledger is missing its reservation");
						}
						return client.creditReservation.findUniqueOrThrow({
							where: { id: ledger.reservationId },
						});
					},
				},
				client,
			);
		}
		const ledger = await client.creditLedgerEntry.findFirst({
			where: { reservationId: winner.id, type: "RESERVE" },
		});
		if (!ledger) throw error;
		assertCreditLedgerReplay(ledger, {
			type: "RESERVE",
			accountId: input.accountId,
			reservationId: winner.id,
			referenceKey: input.referenceKey,
			command,
		});
		return winner;
	}
}

export async function expireCreditLots(
	input: { accountId: string; now?: Date },
	client: MediaTransactionClient,
) {
	return runSerializable(client, async (tx) => {
		await lockAccount(tx, input.accountId);
		const lots = await lockAllLots(tx, input.accountId);
		return materializeExpiredLots(tx, {
			accountId: input.accountId,
			lots,
			now: input.now ?? new Date(),
		});
	});
}

async function finalizeReservation(
	mode: "settle" | "release",
	input: CreditMutationInput,
	tx: Prisma.TransactionClient,
) {
	if (input.amount < 0n) throw new Error("Credit amount cannot be negative");
	const replay = await tx.creditLedgerEntry.findUnique({
		where: { referenceKey: input.referenceKey },
	});
	if (replay) {
		const replayReservation = await tx.creditReservation.findUniqueOrThrow({
			where: { id: input.reservationId },
		});
		assertCreditLedgerReplay(replay, {
			type: mode === "settle" ? "SETTLE" : "RELEASE",
			accountId: replayReservation.accountId,
			reservationId: input.reservationId,
			command: createFinalizeCommand(
				mode === "settle" ? "SETTLE" : "RELEASE",
				input,
				replayReservation.accountId,
			),
		});
		return tx.creditReservation.findUniqueOrThrow({ where: { id: input.reservationId } });
	}
	const snapshot = await tx.creditReservation.findUnique({ where: { id: input.reservationId } });
	if (!snapshot) throw new Error("Credit reservation not found");
	await lockAccount(tx, snapshot.accountId);
	const lots = await lockAllLots(tx, snapshot.accountId);
	const now = new Date();
	await materializeExpiredLots(tx, { accountId: snapshot.accountId, lots, now });
	const locked = (
		await tx.$queryRaw<
			Array<{
				id: string;
				accountId: string;
				amount: bigint;
				settledAmount: bigint;
				releasedAmount: bigint;
				status: "ACTIVE" | "SETTLED" | "RELEASED";
			}>
		>`SELECT "id", "accountId", "amount", "settledAmount", "releasedAmount", "status"
		  FROM "credit_reservation" WHERE "id" = ${input.reservationId} FOR UPDATE`
	)[0];
	if (!locked) throw new Error("Credit reservation not found");
	if (locked.status !== "ACTIVE") {
		throw new IdempotencyConflictError("reservation was already finalized by another command");
	}

	const allocations = await tx.$queryRaw<
		Array<{
			id: string;
			lotId: string;
			amount: bigint;
			settledAmount: bigint;
			releasedAmount: bigint;
			expiresAt: Date | null;
			revokedAmount: bigint;
			revokedSettledAmount: bigint;
			revokedReleasedAmount: bigint;
		}>
	>`SELECT allocation."id", allocation."lotId", allocation."amount",
		          allocation."settledAmount", allocation."releasedAmount", allocation."revokedAmount",
		          lot."expiresAt" AS "expiresAt", allocation."revokedSettledAmount", allocation."revokedReleasedAmount"
	  FROM "credit_reservation_allocation" allocation
	  JOIN "credit_lot" lot ON lot."id" = allocation."lotId"
	  WHERE allocation."reservationId" = ${input.reservationId}
	  ORDER BY lot."expiresAt" ASC NULLS LAST, lot."createdAt" ASC, lot."id" ASC
	  FOR UPDATE OF allocation`;
	const available = locked.amount - locked.settledAmount - locked.releasedAmount;
	const settleAmount = mode === "settle" ? input.amount : 0n;
	if (settleAmount > available) throw new Error("Settlement exceeds reserved credits");
	const releaseAmount = available - settleAmount;
	let settleRemaining = settleAmount;
	let spendableReleased = 0n;
	let revokedSettled = 0n;
	let revokedReleased = 0n;
	let expiredReleased = 0n;

	for (const allocation of allocations) {
		const unresolved = allocation.amount - allocation.settledAmount - allocation.releasedAmount;
		const settled = unresolved < settleRemaining ? unresolved : settleRemaining;
		const released = unresolved - settled;
		const unresolvedRevoked =
			allocation.revokedAmount - allocation.revokedSettledAmount - allocation.revokedReleasedAmount;
		const settledRevoked = unresolvedRevoked < settled ? unresolvedRevoked : settled;
		const releasedRevoked = unresolvedRevoked - settledRevoked;
		const refundableRelease = released - releasedRevoked;
		const restorable = allocation.expiresAt && allocation.expiresAt <= now ? 0n : refundableRelease;
		await tx.creditReservationAllocation.update({
			where: { id: allocation.id },
			data: {
				settledAmount: { increment: settled },
				releasedAmount: { increment: released },
				revokedSettledAmount: { increment: settledRevoked },
				revokedReleasedAmount: { increment: releasedRevoked },
			},
		});
		await tx.creditLot.update({
			where: { id: allocation.lotId },
			data: {
				reservedAmount: { decrement: unresolved },
				remainingAmount: { increment: restorable },
			},
		});
		settleRemaining -= settled;
		spendableReleased += restorable;
		revokedSettled += settledRevoked;
		revokedReleased += releasedRevoked;
		expiredReleased += refundableRelease - restorable;
	}

	const status = mode === "settle" ? "SETTLED" : "RELEASED";
	const reservation = await tx.creditReservation.update({
		where: { id: locked.id },
		data: {
			status,
			settledAmount: { increment: settleAmount },
			releasedAmount: { increment: releaseAmount },
		},
	});
	await tx.creditAccount.update({
		where: { id: locked.accountId },
		data: {
			reservedCredits: { decrement: available },
			spendableCredits: { increment: spendableReleased },
			creditDebt: { increment: revokedSettled },
			version: { increment: 1 },
		},
	});
	if (mode === "settle") {
		const settleCommand = createFinalizeCommand("SETTLE", input, locked.accountId);
		await tx.creditLedgerEntry.create({
			data: {
				accountId: locked.accountId,
				reservationId: locked.id,
				type: "SETTLE",
				amount: settleAmount,
				referenceKey: input.referenceKey,
				metadata: createCreditLedgerMetadata(
					settleCommand,
					{ ledgerAmount: settleAmount },
					{ reserved: -settleAmount },
					{ revokedAmount: revokedSettled.toString() },
				),
			},
		});
		if (revokedSettled > 0n) {
			await tx.creditLedgerEntry.create({
				data: {
					accountId: locked.accountId,
					reservationId: locked.id,
					type: "DEBT_INCURRED",
					amount: revokedSettled,
					referenceKey: `${input.referenceKey}:debt-incurred`,
					metadata: createCreditLedgerMetadata(
						settleCommand,
						{ ledgerAmount: revokedSettled },
						{ debt: revokedSettled },
						{ revokedSettledAmount: revokedSettled.toString() },
					),
				},
			});
		}
		if (releaseAmount > 0n) {
			await tx.creditLedgerEntry.create({
				data: {
					accountId: locked.accountId,
					reservationId: locked.id,
					type: "RELEASE",
					amount: releaseAmount,
					referenceKey: `${input.referenceKey}:release`,
					metadata: createCreditLedgerMetadata(
						settleCommand,
						{ ledgerAmount: releaseAmount },
						{ spendable: spendableReleased, reserved: -releaseAmount },
						{
							revokedAmount: revokedReleased.toString(),
							expiredAmount: expiredReleased.toString(),
						},
					),
				},
			});
		}
	} else {
		const releaseCommand = createFinalizeCommand("RELEASE", input, locked.accountId);
		await tx.creditLedgerEntry.create({
			data: {
				accountId: locked.accountId,
				reservationId: locked.id,
				type: "RELEASE",
				amount: releaseAmount,
				referenceKey: input.referenceKey,
				metadata: createCreditLedgerMetadata(
					releaseCommand,
					{ ledgerAmount: releaseAmount },
					{ spendable: spendableReleased, reserved: -releaseAmount },
					{
						revokedAmount: revokedReleased.toString(),
						expiredAmount: expiredReleased.toString(),
					},
				),
			},
		});
	}
	return reservation;
}

export async function settleCredits(input: CreditMutationInput, client: MediaTransactionClient) {
	return finalizeCreditsWithReplay("settle", input, client);
}

export async function releaseCredits(
	input: Omit<CreditMutationInput, "amount"> & { amount?: bigint },
	client: MediaTransactionClient,
) {
	return finalizeCreditsWithReplay("release", { ...input, amount: input.amount ?? 0n }, client);
}

async function finalizeCreditsWithReplay(
	mode: "settle" | "release",
	input: CreditMutationInput,
	client: MediaTransactionClient,
) {
	try {
		return await runSerializable(client, (tx) => finalizeReservation(mode, input, tx));
	} catch (error) {
		const reservation = await client.creditReservation.findUnique({
			where: { id: input.reservationId },
		});
		if (!reservation) throw error;
		return resolveCreditLedgerUniqueRace(
			error,
			{
				referenceKey: input.referenceKey,
				type: mode === "settle" ? "SETTLE" : "RELEASE",
				accountId: reservation.accountId,
				reservationId: input.reservationId,
				command: createFinalizeCommand(
					mode === "settle" ? "SETTLE" : "RELEASE",
					input,
					reservation.accountId,
				),
				resolveResult: () =>
					client.creditReservation.findUniqueOrThrow({ where: { id: input.reservationId } }),
			},
			client,
		);
	}
}

export async function createCreditGrant(
	input: CreditGrantInput,
	client: MediaTransactionClient | Prisma.TransactionClient,
	options?: SerializableExecutionOptions,
) {
	if (input.amount <= 0n) throw new Error("Grant amount must be positive");
	const command = createGrantCommand(input);
	try {
		const execute = async (tx: Prisma.TransactionClient) => {
			const replay = await tx.creditLedgerEntry.findUnique({
				where: { referenceKey: input.referenceKey },
			});
			if (replay) {
				assertCreditLedgerReplay(replay, {
					type: "GRANT",
					accountId: input.accountId,
					command,
				});
				return replay;
			}
			const account = await lockAccount(tx, input.accountId);
			const lots = await lockAllLots(tx, input.accountId);
			await materializeExpiredLots(tx, { accountId: input.accountId, lots, now: new Date() });
			const debtRepaid = account.creditDebt < input.amount ? account.creditDebt : input.amount;
			const spendable = input.amount - debtRepaid;
			let lotId: string | undefined;
			if (spendable > 0n) {
				const lot = await tx.creditLot.create({
					data: {
						accountId: input.accountId,
						grantReferenceKey: input.referenceKey,
						grantedAmount: spendable,
						remainingAmount: spendable,
						expiresAt: input.expiresAt,
					},
				});
				lotId = lot.id;
			}
			await tx.creditAccount.update({
				where: { id: input.accountId },
				data: {
					creditDebt: { decrement: debtRepaid },
					spendableCredits: { increment: spendable },
					version: { increment: 1 },
				},
			});
			const grant = await tx.creditLedgerEntry.create({
				data: {
					accountId: input.accountId,
					lotId,
					type: "GRANT",
					amount: spendable,
					referenceKey: input.referenceKey,
					metadata: createCreditLedgerMetadata(
						command,
						{ ledgerAmount: spendable, lotId },
						{ spendable },
					),
				},
			});
			if (debtRepaid > 0n) {
				await tx.creditLedgerEntry.create({
					data: {
						accountId: input.accountId,
						type: "DEBT_REPAYMENT",
						amount: debtRepaid,
						referenceKey: `${input.referenceKey}:debt-repayment`,
						metadata: createCreditLedgerMetadata(
							command,
							{ ledgerAmount: debtRepaid },
							{ debt: -debtRepaid },
						),
					},
				});
			}
			return grant;
		};
		return isRootClient(client)
			? await runSerializable(client, execute, options)
			: await execute(client);
	} catch (error) {
		return resolveCreditLedgerUniqueRace(
			error,
			{
				referenceKey: input.referenceKey,
				type: "GRANT",
				accountId: input.accountId,
				command,
				resolveResult: (entry) => entry,
			},
			client,
		);
	}
}

export async function refundCreditGrant(
	input: CreditRefundInput,
	client: MediaTransactionClient | Prisma.TransactionClient,
) {
	if (input.amount <= 0n) throw new Error("Refund amount must be positive");
	const command = createRefundCommand(input);
	try {
		const execute = async (tx: Prisma.TransactionClient) => {
			const replay = await tx.creditLedgerEntry.findUnique({
				where: { referenceKey: input.referenceKey },
			});
			if (replay) {
				assertCreditLedgerReplay(replay, {
					type: "REFUND",
					accountId: input.accountId,
					command,
				});
				return replay;
			}
			await lockAccount(tx, input.accountId);
			const originalGrant = await tx.creditLedgerEntry.findUnique({
				where: { referenceKey: input.grantReferenceKey },
			});
			if (
				!originalGrant ||
				originalGrant.type !== "GRANT" ||
				originalGrant.accountId !== input.accountId
			) {
				throw new Error("Credit grant not found for account");
			}
			const lots = await lockAllLots(tx, input.accountId);
			const matching = lots.filter((lot) => lot.grantReferenceKey === input.grantReferenceKey);
			let remaining = input.amount;
			let consumedUnused = 0n;
			for (const lot of matching) {
				if (remaining === 0n) break;
				const amount = lot.remainingAmount < remaining ? lot.remainingAmount : remaining;
				await tx.creditLot.update({
					where: { id: lot.id },
					data: { remainingAmount: { decrement: amount } },
				});
				consumedUnused += amount;
				remaining -= amount;
				lot.remainingAmount -= amount;
			}
			await materializeExpiredLots(tx, { accountId: input.accountId, lots, now: new Date() });
			const allocations = await lockMatchingActiveAllocations(
				tx,
				input.accountId,
				matching.map((lot) => lot.id),
			);
			let revokedReserved = 0n;
			for (const allocation of allocations) {
				if (remaining === 0n) break;
				const revocable =
					allocation.amount -
					allocation.settledAmount -
					allocation.releasedAmount -
					allocation.revokedAmount +
					allocation.revokedSettledAmount +
					allocation.revokedReleasedAmount;
				const amount = revocable < remaining ? revocable : remaining;
				if (amount <= 0n) continue;
				await tx.creditReservationAllocation.update({
					where: { id: allocation.id },
					data: { revokedAmount: { increment: amount } },
				});
				revokedReserved += amount;
				remaining -= amount;
			}
			await tx.creditAccount.update({
				where: { id: input.accountId },
				data: {
					spendableCredits: { decrement: consumedUnused },
					creditDebt: { increment: remaining },
					version: { increment: 1 },
				},
			});
			const refund = await tx.creditLedgerEntry.create({
				data: {
					accountId: input.accountId,
					type: "REFUND",
					amount: input.amount,
					referenceKey: input.referenceKey,
					metadata: createCreditLedgerMetadata(
						command,
						{ ledgerAmount: input.amount },
						{ spendable: -consumedUnused },
						{
							consumedUnused: consumedUnused.toString(),
							revokedReserved: revokedReserved.toString(),
							debtIncurred: remaining.toString(),
						},
					),
				},
			});
			if (remaining > 0n) {
				await tx.creditLedgerEntry.create({
					data: {
						accountId: input.accountId,
						type: "DEBT_INCURRED",
						amount: remaining,
						referenceKey: `${input.referenceKey}:debt-incurred`,
						metadata: createCreditLedgerMetadata(
							command,
							{ ledgerAmount: remaining },
							{ debt: remaining },
						),
					},
				});
			}
			return refund;
		};
		return isRootClient(client) ? await runSerializable(client, execute) : await execute(client);
	} catch (error) {
		return resolveCreditLedgerUniqueRace(
			error,
			{
				referenceKey: input.referenceKey,
				type: "REFUND",
				accountId: input.accountId,
				command,
				resolveResult: (entry) => entry,
			},
			client,
		);
	}
}

function isRootClient(
	client: MediaTransactionClient | Prisma.TransactionClient,
): client is MediaTransactionClient {
	return typeof (client as MediaTransactionClient).$transaction === "function";
}

export async function getCreditInvariantReport(accountId: string, client?: MediaDatabaseClient) {
	const database = getMediaDatabaseClient(client);
	const [
		account,
		lotTotals,
		reservationTotals,
		activeReservationTotals,
		activeAllocationTotals,
		ledgerTotals,
		ledgerEntries,
	] = await Promise.all([
		database.creditAccount.findUniqueOrThrow({ where: { id: accountId } }),
		database.creditLot.aggregate({
			where: { accountId },
			_sum: { remainingAmount: true, reservedAmount: true },
		}),
		database.creditReservation.aggregate({
			where: { accountId },
			_sum: { amount: true, settledAmount: true, releasedAmount: true },
		}),
		database.creditReservation.aggregate({
			where: { accountId, status: "ACTIVE" },
			_sum: { amount: true, settledAmount: true, releasedAmount: true },
		}),
		database.creditReservationAllocation.aggregate({
			where: { reservation: { accountId, status: "ACTIVE" } },
			_sum: { amount: true, settledAmount: true, releasedAmount: true },
		}),
		database.creditLedgerEntry.groupBy({
			by: ["type"],
			where: { accountId },
			_sum: { amount: true },
		}),
		database.creditLedgerEntry.findMany({ where: { accountId }, select: { metadata: true } }),
	]);
	const ledgerByType = Object.fromEntries(
		ledgerTotals.map((item) => [item.type, item._sum.amount ?? 0n]),
	) as Partial<Record<string, bigint>>;
	const lotSpendable = lotTotals._sum.remainingAmount ?? 0n;
	const lotReserved = lotTotals._sum.reservedAmount ?? 0n;
	const reservationReserved =
		(activeReservationTotals._sum.amount ?? 0n) -
		(activeReservationTotals._sum.settledAmount ?? 0n) -
		(activeReservationTotals._sum.releasedAmount ?? 0n);
	const allocationReserved =
		(activeAllocationTotals._sum.amount ?? 0n) -
		(activeAllocationTotals._sum.settledAmount ?? 0n) -
		(activeAllocationTotals._sum.releasedAmount ?? 0n);
	const totalReserved = reservationTotals._sum.amount ?? 0n;
	const totalSettled = reservationTotals._sum.settledAmount ?? 0n;
	const totalReleased = reservationTotals._sum.releasedAmount ?? 0n;
	const debtFromLedger = (ledgerByType.DEBT_INCURRED ?? 0n) - (ledgerByType.DEBT_REPAYMENT ?? 0n);
	const aggregateFromLedger = ledgerEntries.reduce(
		(total, entry) => {
			const deltas = readCreditDeltas(entry.metadata);
			return {
				spendable: total.spendable + deltas.spendable,
				reserved: total.reserved + deltas.reserved,
				debt: total.debt + deltas.debt,
			};
		},
		{ spendable: 0n, reserved: 0n, debt: 0n },
	);
	return {
		valid:
			account.spendableCredits === lotSpendable &&
			account.reservedCredits === lotReserved &&
			lotReserved === reservationReserved &&
			reservationReserved === allocationReserved &&
			totalReserved === (ledgerByType.RESERVE ?? 0n) &&
			totalSettled === (ledgerByType.SETTLE ?? 0n) &&
			totalReleased === (ledgerByType.RELEASE ?? 0n) &&
			account.creditDebt === debtFromLedger &&
			account.spendableCredits === aggregateFromLedger.spendable &&
			account.reservedCredits === aggregateFromLedger.reserved &&
			account.creditDebt === aggregateFromLedger.debt,
		account: {
			spendable: account.spendableCredits,
			reserved: account.reservedCredits,
			debt: account.creditDebt,
		},
		lots: { spendable: lotSpendable, reserved: lotReserved },
		reservations: { reserved: reservationReserved },
		allocations: { reserved: allocationReserved },
		ledger: {
			spendable: aggregateFromLedger.spendable,
			reservedAggregate: aggregateFromLedger.reserved,
			debtAggregate: aggregateFromLedger.debt,
			reserved: ledgerByType.RESERVE ?? 0n,
			settled: ledgerByType.SETTLE ?? 0n,
			released: ledgerByType.RELEASE ?? 0n,
			debtIncurred: ledgerByType.DEBT_INCURRED ?? 0n,
			debtRepaid: ledgerByType.DEBT_REPAYMENT ?? 0n,
		},
	};
}
