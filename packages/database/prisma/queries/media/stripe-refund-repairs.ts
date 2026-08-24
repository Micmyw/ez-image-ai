import { createHash } from "node:crypto";

import type {
	Prisma,
	StripeRefundRepairAction as StripeRefundRepairActionValue,
} from "../../generated/client";
import { createCreditGrant, expireCreditLotsInTransaction } from "./credits";
import { runSerializable, type MediaTransactionClient } from "./types";

const PROVIDER = "stripe";
const LEGACY_REPAIR_CODE = "STRIPE_LEGACY_REFUND_REPAIR_REQUIRED";

export interface ApproveLegacyStripeRefundRepairInput {
	providerRefundId: string;
	issueKey: string;
	action: StripeRefundRepairActionValue;
	expectedLastProviderChangeId: string;
	expectedCredits: bigint;
	approvalKey: string;
	actorUserId: string;
	reason: string;
}

export interface ApplyApprovedLegacyStripeRefundRepairInput {
	approvalKey: string;
	idempotencyKey: string;
	actorUserId: string;
	reason: string;
	now?: Date;
}

interface LegacyRefundLedgerRow {
	entryId: string;
	referenceKey: string;
	accountId: string;
	amount: bigint;
	periodId: string;
	grantReferenceKey: string | null;
	providerChargeId: string | null;
	periodRefundedCredits: bigint;
	periodRefundedAmount: bigint;
	periodCreditAmount: bigint;
	periodStatus: "PENDING" | "ACTIVE" | "CLOSED" | "VOID" | "REFUNDED";
	startsAt: Date;
	endsAt: Date;
}

interface RefundLifecycleSnapshot {
	id: string;
	providerRefundId: string;
	providerChargeId: string;
	amount: bigint;
	status: "PENDING" | "REQUIRES_ACTION" | "SUCCEEDED" | "FAILED" | "CANCELED";
	lastProviderChangeId: string;
	lastProviderChangeAt: Date;
}

interface ChargeRefundProjectionRow {
	periodId: string;
	subscriptionId: string;
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
	startsAt: Date;
	endsAt: Date;
	periodStatus: "PENDING" | "ACTIVE" | "CLOSED" | "VOID" | "REFUNDED";
	creditAmount: bigint;
	refundedCredits: bigint;
	refundedAmount: bigint;
	paidAmount: bigint;
	grantReferenceKey: string | null;
	grantAccountId: string | null;
	providerInvoiceId: string | null;
	providerInvoicePaymentId: string | null;
	providerChargeId: string | null;
	projectedRefundCredits: bigint;
}

interface ChargeRefundProjectionSnapshot {
	periods: ChargeRefundProjectionRow[];
	projectedCredits: bigint;
}

export async function approveLegacyStripeRefundRepair(
	input: ApproveLegacyStripeRefundRepairInput,
	client: MediaTransactionClient,
) {
	assertRepairInput(input);
	return runSerializable(client, async (tx) => {
		await advisoryLock(tx, `stripe-refund-repair-approval:${input.approvalKey}`);
		await advisoryLock(tx, `stripe-refund-repair-refund:${input.providerRefundId}`);
		let refund = await findRefundLifecycle(input.providerRefundId, tx);
		if (!refund) throw new Error("STRIPE_REFUND_REPAIR_LIFECYCLE_NOT_FOUND");
		await advisoryLock(tx, `stripe-refund:${refund.providerChargeId}`);
		await lockRefundLifecycle(refund.id, tx);
		refund = await findRefundLifecycle(input.providerRefundId, tx);
		if (!refund) throw new Error("STRIPE_REFUND_REPAIR_LIFECYCLE_NOT_FOUND");

		const approvalReplay = await tx.stripeRefundRepairAuthority.findUnique({
			where: { approvalKey: input.approvalKey },
			include: { issue: { select: { issueKey: true } } },
		});
		if (approvalReplay) {
			assertApprovalReplay(approvalReplay, refund, input);
			return {
				authorityId: approvalReplay.id,
				approvalKey: approvalReplay.approvalKey,
				replayed: true,
			};
		}

		if (refund.lastProviderChangeId !== input.expectedLastProviderChangeId) {
			throw new Error("STRIPE_REFUND_REPAIR_APPROVAL_STALE");
		}
		assertRepairActionMatchesStatus(input.action, refund.status);
		const issue = await tx.stripeReconciliationIssue.findUnique({
			where: { issueKey: input.issueKey },
		});
		if (
			!issue ||
			issue.provider !== PROVIDER ||
			issue.entityType !== "REFUND" ||
			issue.providerObjectId !== input.providerRefundId ||
			issue.code !== LEGACY_REPAIR_CODE ||
			issue.status !== "OPEN"
		) {
			throw new Error("STRIPE_REFUND_REPAIR_ISSUE_INVALID");
		}

		const rows = await loadLegacyRefundLedger(input.providerRefundId, tx);
		const approvedCredits = totalLegacyCredits(rows);
		if (approvedCredits !== input.expectedCredits) {
			throw new Error("STRIPE_REFUND_REPAIR_CREDIT_SNAPSHOT_MISMATCH");
		}
		const projection = await loadChargeRefundProjection(refund, rows, tx);
		if (
			input.action === "COMPENSATE_FAILED_OR_CANCELED" &&
			(await hasActiveLegacyRevocation(input.providerRefundId, tx))
		) {
			throw new Error("STRIPE_REFUND_REPAIR_RESERVATION_ACTIVE");
		}

		const ledgerFingerprint = fingerprintLegacyRefundLedger(rows, projection, refund);
		const existingSnapshotApproval = await tx.stripeRefundRepairAuthority.findFirst({
			where: {
				refundId: refund.id,
				lifecycleLastProviderChangeId: refund.lastProviderChangeId,
				ledgerFingerprint,
			},
		});
		if (existingSnapshotApproval) {
			throw new Error("STRIPE_REFUND_REPAIR_ALREADY_APPROVED");
		}
		const authority = await tx.stripeRefundRepairAuthority.create({
			data: {
				approvalKey: input.approvalKey,
				refundId: refund.id,
				issueId: issue.id,
				action: input.action,
				lifecycleStatus: refund.status,
				lifecycleLastProviderChangeId: refund.lastProviderChangeId,
				lifecycleLastProviderChangeAt: refund.lastProviderChangeAt,
				approvedCredits,
				ledgerFingerprint,
				approvedByUserId: input.actorUserId,
				reason: input.reason.trim(),
			},
		});
		await tx.auditLog.create({
			data: {
				actorUserId: input.actorUserId,
				action: "STRIPE_REFUND_REPAIR_APPROVED",
				targetType: "STRIPE_REFUND_REPAIR_AUTHORITY",
				targetId: authority.id,
				after: {
					action: input.action,
					lifecycleStatus: refund.status,
					providerRefundId: refund.providerRefundId,
				},
				metadata: {
					approvedCredits: approvedCredits.toString(),
					issueKey: issue.issueKey,
					reason: input.reason.trim(),
				},
			},
		});
		return { authorityId: authority.id, approvalKey: authority.approvalKey, replayed: false };
	});
}

export async function applyApprovedLegacyStripeRefundRepair(
	input: ApplyApprovedLegacyStripeRefundRepairInput,
	client: MediaTransactionClient,
) {
	assertApplicationInput(input);
	return runSerializable(client, async (tx) => {
		await advisoryLock(tx, `stripe-refund-repair-operation:${input.idempotencyKey}`);
		const operationReplay = await tx.stripeRefundRepairReceipt.findUnique({
			where: { operationKey: input.idempotencyKey },
			include: { authority: true },
		});
		if (operationReplay) {
			if (
				operationReplay.authority.approvalKey !== input.approvalKey ||
				operationReplay.appliedByUserId !== input.actorUserId ||
				operationReplay.reason !== input.reason.trim()
			) {
				throw new Error("IDEMPOTENCY_CONFLICT");
			}
			return repairReceiptResult(operationReplay, operationReplay.authority, true);
		}

		await advisoryLock(tx, `stripe-refund-repair-approval:${input.approvalKey}`);
		let authority = await tx.stripeRefundRepairAuthority.findUnique({
			where: { approvalKey: input.approvalKey },
			include: { issue: true, receipt: true, refund: true },
		});
		if (!authority) throw new Error("STRIPE_REFUND_REPAIR_APPROVAL_NOT_FOUND");
		if (authority.receipt) {
			if (
				authority.receipt.operationKey !== input.idempotencyKey ||
				authority.receipt.appliedByUserId !== input.actorUserId ||
				authority.receipt.reason !== input.reason.trim()
			) {
				throw new Error("IDEMPOTENCY_CONFLICT");
			}
			return repairReceiptResult(authority.receipt, authority, true);
		}
		if (authority.approvedByUserId === input.actorUserId) {
			throw new Error("STRIPE_REFUND_REPAIR_SECOND_APPROVER_REQUIRED");
		}

		await advisoryLock(tx, `stripe-refund:${authority.refund.providerChargeId}`);
		await lockRefundLifecycle(authority.refundId, tx);
		authority = await tx.stripeRefundRepairAuthority.findUnique({
			where: { id: authority.id },
			include: { issue: true, receipt: true, refund: true },
		});
		if (!authority) throw new Error("STRIPE_REFUND_REPAIR_APPROVAL_NOT_FOUND");
		if (
			authority.refund.status !== authority.lifecycleStatus ||
			authority.refund.lastProviderChangeId !== authority.lifecycleLastProviderChangeId ||
			authority.refund.lastProviderChangeAt.getTime() !==
				authority.lifecycleLastProviderChangeAt.getTime()
		) {
			throw new Error("STRIPE_REFUND_REPAIR_APPROVAL_STALE");
		}
		assertRepairActionMatchesStatus(authority.action, authority.refund.status);
		if (
			authority.issue.issueKey !==
				`${PROVIDER}:REFUND:${authority.refund.providerRefundId}:${LEGACY_REPAIR_CODE}` ||
			authority.issue.code !== LEGACY_REPAIR_CODE ||
			authority.issue.providerObjectId !== authority.refund.providerRefundId ||
			authority.issue.status !== "OPEN"
		) {
			throw new Error("STRIPE_REFUND_REPAIR_ISSUE_STALE");
		}

		const rows = await loadLegacyRefundLedger(authority.refund.providerRefundId, tx);
		const projection = await loadChargeRefundProjection(authority.refund, rows, tx);
		if (
			totalLegacyCredits(rows) !== authority.approvedCredits ||
			fingerprintLegacyRefundLedger(rows, projection, authority.refund) !==
				authority.ledgerFingerprint
		) {
			throw new Error("STRIPE_REFUND_REPAIR_LEDGER_SNAPSHOT_STALE");
		}

		const now = input.now ?? new Date();
		let compensatedCredits = 0n;
		if (authority.action === "CONFIRM_SUCCEEDED") {
			const changed = await tx.stripeRefund.updateMany({
				where: {
					id: authority.refund.id,
					status: "SUCCEEDED",
					lastProviderChangeId: authority.lifecycleLastProviderChangeId,
					creditsFinalizedAt: null,
				},
				data: { finalizedCredits: projection.projectedCredits, creditsFinalizedAt: now },
			});
			if (changed.count !== 1) throw new Error("STRIPE_REFUND_REPAIR_APPROVAL_STALE");
		} else {
			if (await hasActiveLegacyRevocation(authority.refund.providerRefundId, tx)) {
				throw new Error("STRIPE_REFUND_REPAIR_RESERVATION_ACTIVE");
			}
			compensatedCredits = await compensateLegacyRefund(authority, rows, projection, now, tx);
		}

		const resolved = await tx.stripeReconciliationIssue.updateMany({
			where: {
				id: authority.issue.id,
				issueKey: authority.issue.issueKey,
				code: LEGACY_REPAIR_CODE,
				providerObjectId: authority.refund.providerRefundId,
				status: "OPEN",
			},
			data: { status: "RESOLVED", resolvedAt: now },
		});
		if (resolved.count !== 1) throw new Error("STRIPE_REFUND_REPAIR_ISSUE_STALE");
		const receipt = await tx.stripeRefundRepairReceipt.create({
			data: {
				authorityId: authority.id,
				operationKey: input.idempotencyKey,
				appliedByUserId: input.actorUserId,
				reason: input.reason.trim(),
				compensatedCredits,
				appliedAt: now,
			},
		});
		await tx.auditLog.create({
			data: {
				actorUserId: input.actorUserId,
				action: "STRIPE_REFUND_REPAIR_APPLIED",
				targetType: "STRIPE_REFUND_REPAIR_RECEIPT",
				targetId: receipt.id,
				after: {
					action: authority.action,
					providerRefundId: authority.refund.providerRefundId,
				},
				metadata: {
					approvalKey: authority.approvalKey,
					compensatedCredits: compensatedCredits.toString(),
					reason: input.reason.trim(),
				},
			},
		});
		return repairReceiptResult(receipt, authority, false);
	});
}

async function compensateLegacyRefund(
	authority: {
		id: string;
		approvedCredits: bigint;
		refund: RefundLifecycleSnapshot;
	},
	rows: LegacyRefundLedgerRow[],
	projection: ChargeRefundProjectionSnapshot,
	now: Date,
	tx: Prisma.TransactionClient,
): Promise<bigint> {
	const grouped = new Map<string, { row: LegacyRefundLedgerRow; amount: bigint }>();
	for (const row of rows) {
		const existing = grouped.get(row.periodId);
		if (existing) existing.amount += row.amount;
		else grouped.set(row.periodId, { row, amount: row.amount });
	}
	for (const { row, amount } of grouped.values()) {
		if (!row.grantReferenceKey) throw new Error("STRIPE_REFUND_REPAIR_GRANT_BINDING_INVALID");
		await expireCreditLotsInTransaction({ accountId: row.accountId, now }, tx);
		await createCreditGrant(
			{
				accountId: row.accountId,
				amount,
				expiresAt: row.endsAt,
				referenceKey: `stripe-refund-repair:${authority.refund.providerRefundId}:${authority.id}:${row.periodId}`,
				metadata: {
					authorityId: authority.id,
					providerRefundId: authority.refund.providerRefundId,
					billingPeriodId: row.periodId,
				},
			},
			tx,
		);
		await expireCreditLotsInTransaction({ accountId: row.accountId, now }, tx);
	}

	for (const period of projection.periods) {
		if (period.projectedRefundCredits === 0n && period.refundedAmount === 0n) continue;
		const changed = await tx.billingPeriod.updateMany({
			where: {
				id: period.periodId,
				refundedCredits: period.refundedCredits,
				refundedAmount: period.refundedAmount,
				status: period.periodStatus,
			},
			data: {
				refundedCredits: 0n,
				refundedAmount: 0n,
				...(period.periodStatus !== "VOID" ? { status: billingPeriodStatusAt(period, now) } : {}),
			},
		});
		if (changed.count !== 1) throw new Error("STRIPE_REFUND_REPAIR_PERIOD_SNAPSHOT_STALE");
	}
	return authority.approvedCredits;
}

async function findRefundLifecycle(
	providerRefundId: string,
	tx: Prisma.TransactionClient,
): Promise<RefundLifecycleSnapshot | null> {
	return tx.stripeRefund.findUnique({
		where: { provider_providerRefundId: { provider: PROVIDER, providerRefundId } },
		select: {
			id: true,
			providerRefundId: true,
			providerChargeId: true,
			amount: true,
			status: true,
			lastProviderChangeId: true,
			lastProviderChangeAt: true,
		},
	});
}

async function lockRefundLifecycle(refundId: string, tx: Prisma.TransactionClient): Promise<void> {
	const rows = await tx.$queryRaw<Array<{ id: string }>>`
		SELECT "id" FROM "stripe_refund" WHERE "id" = ${refundId} FOR UPDATE`;
	if (rows.length !== 1) throw new Error("STRIPE_REFUND_REPAIR_LIFECYCLE_NOT_FOUND");
}

async function loadLegacyRefundLedger(
	providerRefundId: string,
	tx: Prisma.TransactionClient,
): Promise<LegacyRefundLedgerRow[]> {
	const rows = await tx.$queryRaw<LegacyRefundLedgerRow[]>`
		SELECT entry."id" AS "entryId", entry."referenceKey", entry."accountId", entry."amount",
		       period."id" AS "periodId", period."grantReferenceKey", period."providerChargeId",
		       period."refundedCredits" AS "periodRefundedCredits",
		       period."refundedAmount" AS "periodRefundedAmount",
		       period."creditAmount" AS "periodCreditAmount",
		       period."status"::text AS "periodStatus", period."startsAt", period."endsAt"
		FROM "credit_ledger_entry" entry
		JOIN "billing_period" period
		  ON period."id" = split_part(entry."referenceKey", ':', 3)
		WHERE entry."type" = 'REFUND'
		  AND split_part(entry."referenceKey", ':', 1) = 'stripe-refund'
		  AND split_part(entry."referenceKey", ':', 2) = ${providerRefundId}
		  AND array_length(string_to_array(entry."referenceKey", ':'), 1) = 3
		ORDER BY period."startsAt" ASC, period."id" ASC, entry."id" ASC
		FOR UPDATE OF period`;
	if (rows.length === 0) throw new Error("STRIPE_REFUND_REPAIR_LEDGER_NOT_FOUND");
	return rows;
}

async function hasActiveLegacyRevocation(
	providerRefundId: string,
	tx: Prisma.TransactionClient,
): Promise<boolean> {
	const [row] = await tx.$queryRaw<Array<{ active: boolean }>>`
		SELECT EXISTS (
			SELECT 1
			FROM "credit_ledger_entry" entry
			JOIN "billing_period" period
			  ON period."id" = split_part(entry."referenceKey", ':', 3)
			JOIN "credit_lot" lot ON lot."grantReferenceKey" = period."grantReferenceKey"
			JOIN "credit_reservation_allocation" allocation ON allocation."lotId" = lot."id"
			JOIN "credit_reservation" reservation ON reservation."id" = allocation."reservationId"
			WHERE entry."type" = 'REFUND'
			  AND split_part(entry."referenceKey", ':', 1) = 'stripe-refund'
			  AND split_part(entry."referenceKey", ':', 2) = ${providerRefundId}
			  AND reservation."status" = 'ACTIVE'
			  AND allocation."revokedAmount" >
			      allocation."revokedSettledAmount" + allocation."revokedReleasedAmount"
		) AS "active"`;
	return row?.active ?? false;
}

async function loadChargeRefundProjection(
	refund: RefundLifecycleSnapshot,
	rows: LegacyRefundLedgerRow[],
	tx: Prisma.TransactionClient,
): Promise<ChargeRefundProjectionSnapshot> {
	const accounts = new Set(rows.map((row) => row.accountId));
	if (accounts.size !== 1) throw new Error("STRIPE_REFUND_REPAIR_ACCOUNT_BINDING_INVALID");
	if (rows.some((row) => row.providerChargeId !== refund.providerChargeId)) {
		throw new Error("STRIPE_REFUND_REPAIR_CHARGE_BINDING_INVALID");
	}
	const ledgerByPeriod = new Map<string, bigint>();
	for (const row of rows) {
		ledgerByPeriod.set(row.periodId, (ledgerByPeriod.get(row.periodId) ?? 0n) + row.amount);
	}

	const databasePeriods = await tx.$queryRaw<
		Array<Omit<ChargeRefundProjectionRow, "projectedRefundCredits">>
	>`
		SELECT period."id" AS "periodId", period."subscriptionId",
		       subscription."ownerType"::text AS "ownerType", subscription."ownerId",
		       period."startsAt", period."endsAt", period."status"::text AS "periodStatus",
		       period."creditAmount", period."refundedCredits", period."refundedAmount",
		       period."paidAmount", period."grantReferenceKey",
		       grant_entry."accountId" AS "grantAccountId", period."providerInvoiceId",
		       period."providerInvoicePaymentId", period."providerChargeId"
		FROM "billing_period" period
		JOIN "subscription" subscription ON subscription."id" = period."subscriptionId"
		LEFT JOIN "credit_ledger_entry" grant_entry
		  ON grant_entry."referenceKey" = period."grantReferenceKey"
		 AND grant_entry."type" = 'GRANT'
		WHERE period."providerChargeId" = ${refund.providerChargeId}
		ORDER BY period."startsAt" ASC, period."id" ASC
		FOR UPDATE OF period`;
	if (databasePeriods.length === 0) {
		throw new Error("STRIPE_REFUND_REPAIR_CHARGE_BINDING_INVALID");
	}
	const refunds = await tx.stripeRefund.findMany({
		where: { provider: PROVIDER, providerChargeId: refund.providerChargeId },
		select: { providerRefundId: true },
		take: 2,
	});
	const legacyRefundIds = await tx.$queryRaw<Array<{ providerRefundId: string }>>`
		SELECT DISTINCT split_part(entry."referenceKey", ':', 2) AS "providerRefundId"
		FROM "credit_ledger_entry" entry
		JOIN "billing_period" period
		  ON period."id" = split_part(entry."referenceKey", ':', 3)
		WHERE entry."type" = 'REFUND'
		  AND entry."referenceKey" ~ '^stripe-refund:re_[A-Za-z0-9_-]+:[^:]+$'
		  AND period."providerChargeId" = ${refund.providerChargeId}
		ORDER BY "providerRefundId"`;
	if (
		refunds.length !== 1 ||
		refunds[0]?.providerRefundId !== refund.providerRefundId ||
		legacyRefundIds.length !== 1 ||
		legacyRefundIds[0]?.providerRefundId !== refund.providerRefundId
	) {
		throw new Error("STRIPE_REFUND_REPAIR_CHARGE_BINDING_INVALID");
	}

	const subscriptionIds = new Set(databasePeriods.map((period) => period.subscriptionId));
	const owners = new Set(databasePeriods.map((period) => `${period.ownerType}:${period.ownerId}`));
	const invoiceIds = new Set(databasePeriods.map((period) => period.providerInvoiceId));
	const invoicePaymentIds = new Set(
		databasePeriods.map((period) => period.providerInvoicePaymentId),
	);
	const paidAmounts = new Set(databasePeriods.map((period) => period.paidAmount.toString()));
	if (
		subscriptionIds.size !== 1 ||
		owners.size !== 1 ||
		invoiceIds.size !== 1 ||
		invoiceIds.has(null) ||
		invoicePaymentIds.size !== 1 ||
		paidAmounts.size !== 1 ||
		databasePeriods.some((period) => period.providerChargeId !== refund.providerChargeId)
	) {
		throw new Error("STRIPE_REFUND_REPAIR_CHARGE_BINDING_INVALID");
	}
	const firstPeriod = databasePeriods[0]!;
	const account = await tx.creditAccount.findUnique({
		where: {
			ownerType_ownerId: { ownerType: firstPeriod.ownerType, ownerId: firstPeriod.ownerId },
		},
		select: { id: true },
	});
	const ledgerAccountId = [...accounts][0]!;
	if (
		!account ||
		account.id !== ledgerAccountId ||
		databasePeriods.some(
			(period) => period.grantAccountId !== null && period.grantAccountId !== ledgerAccountId,
		)
	) {
		throw new Error("STRIPE_REFUND_REPAIR_ACCOUNT_BINDING_INVALID");
	}

	const invoicePaidAmount = firstPeriod.paidAmount;
	const invoiceCredits = databasePeriods.reduce((total, period) => total + period.creditAmount, 0n);
	if (
		invoicePaidAmount <= 0n ||
		invoiceCredits <= 0n ||
		refund.amount <= 0n ||
		refund.amount > invoicePaidAmount
	) {
		throw new Error("STRIPE_REFUND_REPAIR_PERIOD_SNAPSHOT_INVALID");
	}
	const projectedCredits =
		(invoiceCredits * refund.amount + invoicePaidAmount - 1n) / invoicePaidAmount;
	let remainingProjectedCredits = projectedCredits;
	const periods = databasePeriods.map((period, index): ChargeRefundProjectionRow => {
		const projectedRefundCredits =
			period.creditAmount < remainingProjectedCredits
				? period.creditAmount
				: remainingProjectedCredits;
		remainingProjectedCredits -= projectedRefundCredits;
		const ledgerCredits = ledgerByPeriod.get(period.periodId) ?? 0n;
		const expectedRefundedAmount = index === 0 ? refund.amount : 0n;
		if (
			period.refundedCredits !== projectedRefundCredits ||
			period.refundedAmount !== expectedRefundedAmount ||
			(projectedRefundCredits > 0n && !period.grantReferenceKey) ||
			(period.grantAccountId === null && ledgerCredits !== 0n) ||
			(period.grantAccountId !== null && ledgerCredits !== projectedRefundCredits)
		) {
			throw new Error("STRIPE_REFUND_REPAIR_PERIOD_SNAPSHOT_INVALID");
		}
		return { ...period, projectedRefundCredits };
	});
	if (remainingProjectedCredits !== 0n) {
		throw new Error("STRIPE_REFUND_REPAIR_PERIOD_SNAPSHOT_INVALID");
	}
	return { periods, projectedCredits };
}

function totalLegacyCredits(rows: LegacyRefundLedgerRow[]): bigint {
	return rows.reduce((total, row) => total + row.amount, 0n);
}

function fingerprintLegacyRefundLedger(
	rows: LegacyRefundLedgerRow[],
	projection: ChargeRefundProjectionSnapshot,
	refund: RefundLifecycleSnapshot,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				refund: {
					amount: refund.amount.toString(),
					providerChargeId: refund.providerChargeId,
					providerRefundId: refund.providerRefundId,
				},
				ledger: rows.map((row) => ({
					accountId: row.accountId,
					amount: row.amount.toString(),
					endsAt: row.endsAt.toISOString(),
					entryId: row.entryId,
					grantReferenceKey: row.grantReferenceKey,
					periodCreditAmount: row.periodCreditAmount.toString(),
					periodId: row.periodId,
					providerChargeId: row.providerChargeId,
					periodRefundedAmount: row.periodRefundedAmount.toString(),
					periodRefundedCredits: row.periodRefundedCredits.toString(),
					periodStatus: row.periodStatus,
					referenceKey: row.referenceKey,
					startsAt: row.startsAt.toISOString(),
				})),
				projection: projection.periods.map((period) => ({
					creditAmount: period.creditAmount.toString(),
					endsAt: period.endsAt.toISOString(),
					grantAccountId: period.grantAccountId,
					grantReferenceKey: period.grantReferenceKey,
					ownerId: period.ownerId,
					ownerType: period.ownerType,
					paidAmount: period.paidAmount.toString(),
					periodId: period.periodId,
					periodStatus: period.periodStatus,
					projectedRefundCredits: period.projectedRefundCredits.toString(),
					providerChargeId: period.providerChargeId,
					providerInvoiceId: period.providerInvoiceId,
					providerInvoicePaymentId: period.providerInvoicePaymentId,
					refundedAmount: period.refundedAmount.toString(),
					refundedCredits: period.refundedCredits.toString(),
					startsAt: period.startsAt.toISOString(),
					subscriptionId: period.subscriptionId,
				})),
				projectedCredits: projection.projectedCredits.toString(),
			}),
		)
		.digest("hex");
}

function assertRepairActionMatchesStatus(
	action: StripeRefundRepairActionValue,
	status: RefundLifecycleSnapshot["status"],
): void {
	if (status === "PENDING" || status === "REQUIRES_ACTION") {
		throw new Error("STRIPE_REFUND_REPAIR_STATUS_NOT_TERMINAL");
	}
	if (
		(action === "CONFIRM_SUCCEEDED" && status !== "SUCCEEDED") ||
		(action === "COMPENSATE_FAILED_OR_CANCELED" && status !== "FAILED" && status !== "CANCELED")
	) {
		throw new Error("STRIPE_REFUND_REPAIR_ACTION_INVALID");
	}
}

function assertApprovalReplay(
	authority: {
		id: string;
		approvalKey: string;
		refundId: string;
		issueId: string;
		action: StripeRefundRepairActionValue;
		lifecycleStatus: RefundLifecycleSnapshot["status"];
		lifecycleLastProviderChangeId: string;
		lifecycleLastProviderChangeAt: Date;
		approvedCredits: bigint;
		approvedByUserId: string;
		reason: string;
		issue: { issueKey: string };
	},
	refund: RefundLifecycleSnapshot,
	input: ApproveLegacyStripeRefundRepairInput,
): void {
	if (
		authority.refundId !== refund.id ||
		authority.issue.issueKey !== input.issueKey ||
		authority.action !== input.action ||
		authority.lifecycleLastProviderChangeId !== input.expectedLastProviderChangeId ||
		authority.approvedCredits !== input.expectedCredits ||
		authority.approvedByUserId !== input.actorUserId ||
		authority.reason !== input.reason.trim()
	) {
		throw new Error("IDEMPOTENCY_CONFLICT");
	}
	if (
		refund.lastProviderChangeId !== authority.lifecycleLastProviderChangeId ||
		refund.status !== authority.lifecycleStatus ||
		refund.lastProviderChangeAt.getTime() !== authority.lifecycleLastProviderChangeAt.getTime()
	) {
		throw new Error("STRIPE_REFUND_REPAIR_APPROVAL_STALE");
	}
}

function repairReceiptResult(
	receipt: { id: string; compensatedCredits: bigint },
	authority: { id: string; approvalKey: string; action: StripeRefundRepairActionValue },
	replayed: boolean,
) {
	return {
		authorityId: authority.id,
		approvalKey: authority.approvalKey,
		action: authority.action,
		receiptId: receipt.id,
		compensatedCredits: receipt.compensatedCredits,
		replayed,
	};
}

function billingPeriodStatusAt(
	period: { startsAt: Date; endsAt: Date },
	now: Date,
): "PENDING" | "ACTIVE" | "CLOSED" {
	if (now < period.startsAt) return "PENDING";
	if (now >= period.endsAt) return "CLOSED";
	return "ACTIVE";
}

function assertRepairInput(input: ApproveLegacyStripeRefundRepairInput): void {
	if (!/^re_[A-Za-z0-9_-]+$/.test(input.providerRefundId)) {
		throw new Error("STRIPE_REFUND_REPAIR_ID_INVALID");
	}
	if (input.expectedCredits <= 0n) throw new Error("STRIPE_REFUND_REPAIR_CREDITS_INVALID");
	if (!input.approvalKey.trim() || !input.actorUserId.trim()) {
		throw new Error("STRIPE_REFUND_REPAIR_APPROVAL_INVALID");
	}
	assertReason(input.reason);
}

function assertApplicationInput(input: ApplyApprovedLegacyStripeRefundRepairInput): void {
	if (!input.approvalKey.trim() || !input.idempotencyKey.trim() || !input.actorUserId.trim()) {
		throw new Error("STRIPE_REFUND_REPAIR_APPLICATION_INVALID");
	}
	assertReason(input.reason);
}

function assertReason(reason: string): void {
	const normalized = reason.trim();
	if (normalized.length < 10 || normalized.length > 500) {
		throw new Error("STRIPE_REFUND_REPAIR_REASON_INVALID");
	}
}

async function advisoryLock(tx: Prisma.TransactionClient, key: string): Promise<void> {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
