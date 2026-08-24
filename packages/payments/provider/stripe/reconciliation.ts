import { randomUUID } from "node:crypto";

import { runSerializable, type Prisma } from "@repo/database";

import type {
	StripeBillingPage,
	StripeBillingPageInput,
	StripeBillingSource,
	StripeBillingSourceIssue,
} from "./billing-source";
import type { StripeBillingFact } from "./normalization";
import { applyStripeBillingFact, persistStripeRefundLifecycleForReview } from "./reducer";

const CHECKPOINT_ID = "stripe-billing-reconciliation";
const PROVIDER = "stripe";
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_INVOICE_PAYMENT_LOOKUPS = 25;
const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_RUN_DEADLINE_MS = 75_000;
const MAX_PROVIDER_REQUEST_TIMEOUT_MS = 10_000;

type DatabaseClient = Parameters<typeof runSerializable>[0];
type ReconciliationStage = "SUBSCRIPTIONS" | "INVOICES" | "REFUNDS";
type ReconciliationClock = () => Date;
type ReconciliationSkipReason = "CONTINUATION_INVALID" | "LEASE_ACTIVE" | "SWEEP_NOT_ACTIVE";

const REVIEWABLE_FACT_ERROR_CODES = new Set([
	"STRIPE_ANNUAL_INVOICE_PERIOD_INVALID",
	"STRIPE_BILLING_PLAN_BINDING_INVALID",
	"STRIPE_CUSTOMER_OWNER_CONFLICT",
	"STRIPE_INVOICE_BINDING_AMBIGUOUS",
	"STRIPE_INVOICE_PLAN_UNMAPPED",
	"STRIPE_INVOICE_PLAN_INTERVAL_INVALID",
	"STRIPE_MONTHLY_INVOICE_PERIOD_INVALID",
	"STRIPE_PURCHASE_BINDING_INVALID",
	"STRIPE_REFUND_AMOUNT_EXCEEDS_INVOICE",
	"STRIPE_REFUND_BINDING_AMBIGUOUS",
	"STRIPE_REFUND_BINDING_PENDING",
	"STRIPE_REFUND_IDENTITY_CONFLICT",
	"STRIPE_REFUND_TERMINAL_CONFLICT",
	"STRIPE_LEGACY_REFUND_REPAIR_REQUIRED",
	"STRIPE_SCHEDULED_PLAN_MISMATCH",
	"STRIPE_SUBSCRIPTION_BINDING_AMBIGUOUS",
	"STRIPE_SUBSCRIPTION_BINDING_PENDING",
	"STRIPE_SUBSCRIPTION_CUSTOMER_CONFLICT",
	"STRIPE_SUBSCRIPTION_EVENT_ORDER_AMBIGUOUS",
	"STRIPE_SUBSCRIPTION_OWNER_CONFLICT",
	"STRIPE_SUBSCRIPTION_OWNER_INVALID",
	"STRIPE_SUBSCRIPTION_PLAN_UNMAPPED",
	"STRIPE_SUBSCRIPTION_PROVIDER_CONFLICT",
	"STRIPE_SUBSCRIPTION_PURCHASE_BINDING_INVALID",
	"STRIPE_SUBSCRIPTION_TERMINAL_CONFLICT",
	"STRIPE_UNSCHEDULED_PLAN_CHANGE",
]);

interface CheckpointLease {
	id: string;
	token: string;
	sweepId: string;
	cutoff: Date;
	stage: ReconciliationStage;
	cursor: string | null;
	progress: number;
	continuationSequence: number;
	leaseSeconds: number;
}

export interface ReconcileStripeBillingInput {
	now?: Date;
	pageSize?: number;
	maxPages?: number;
	maxInvoicePaymentLookups?: number;
	leaseSeconds?: number;
	runDeadlineMs?: number;
	expectedSweepId?: string;
	continuationSequence?: number;
}

export type ReconcileStripeBillingResult =
	| {
			skipped: true;
			reason: ReconciliationSkipReason;
			completed: false;
			pagesProcessed: 0;
			issues: 0;
	  }
	| {
			skipped: false;
			completed: true;
			pagesProcessed: number;
			issues: number;
			sweepId: string;
	  }
	| {
			skipped: false;
			completed: false;
			pagesProcessed: number;
			issues: number;
			sweepId: string;
			continuationKey: string;
			continuationSequence: number;
	  };

type CheckpointClaim =
	| { kind: "LEASE"; lease: CheckpointLease }
	| { kind: "REPLAY"; sweepId: string; continuationSequence: number }
	| { kind: "SKIP"; reason: ReconciliationSkipReason };

export async function reconcileStripeBilling(
	input: ReconcileStripeBillingInput,
	client: DatabaseClient,
	source: StripeBillingSource,
): Promise<ReconcileStripeBillingResult> {
	const clock: ReconciliationClock = input.now ? () => input.now! : () => new Date();
	const claimTime = clock();
	const pageSize = clampInteger(input.pageSize, DEFAULT_PAGE_SIZE, 1, 100);
	const maxPages = clampInteger(input.maxPages, DEFAULT_MAX_PAGES, 1, 100);
	let invoicePaymentLookupsRemaining = clampInteger(
		input.maxInvoicePaymentLookups,
		DEFAULT_MAX_INVOICE_PAYMENT_LOOKUPS,
		1,
		1_000,
	);
	const leaseSeconds = clampInteger(input.leaseSeconds, DEFAULT_LEASE_SECONDS, 30, 900);
	const runDeadlineMs = clampInteger(input.runDeadlineMs, DEFAULT_RUN_DEADLINE_MS, 1_000, 110_000);
	const runDeadlineAt = Date.now() + runDeadlineMs;
	const continuationSequence = clampInteger(input.continuationSequence, 0, 0, 1_000_000_000);
	let claim: CheckpointClaim;
	try {
		claim = await claimCheckpoint(
			{
				now: claimTime,
				leaseSeconds,
				expectedSweepId: input.expectedSweepId,
				continuationSequence,
			},
			client,
		);
	} catch {
		throw new Error("STRIPE_RECONCILIATION_CHECKPOINT_FAILURE");
	}
	if (claim.kind === "SKIP") {
		return {
			skipped: true,
			reason: claim.reason,
			completed: false,
			pagesProcessed: 0,
			issues: 0,
		};
	}
	if (claim.kind === "REPLAY") {
		return {
			skipped: false,
			completed: false,
			pagesProcessed: 0,
			issues: 0,
			sweepId: claim.sweepId,
			continuationKey: continuationKey(claim.sweepId, claim.continuationSequence),
			continuationSequence: claim.continuationSequence,
		};
	}
	let lease = claim.lease;

	let pagesProcessed = 0;
	let issues = 0;
	try {
		while (pagesProcessed < maxPages) {
			if (
				isRunDeadlineReached(runDeadlineAt) ||
				(lease.stage === "INVOICES" && invoicePaymentLookupsRemaining <= 0)
			) {
				return pauseReconciliation(lease, pagesProcessed, issues, clock, client);
			}
			const stagePageSize = lease.stage === "INVOICES" ? 1 : pageSize;
			const pageInput: StripeBillingPageInput = {
				cutoff: lease.cutoff,
				cursor: lease.cursor,
				limit: stagePageSize,
				sweepId: lease.sweepId,
				requestTimeoutMs: Math.max(
					1,
					Math.min(MAX_PROVIDER_REQUEST_TIMEOUT_MS, runDeadlineAt - Date.now()),
				),
				requestDeadlineAtMs: runDeadlineAt,
			};
			let page: StripeBillingPage<StripeBillingFact>;
			try {
				page = await loadStagePage(lease.stage, pageInput, source);
			} catch (error) {
				if (isProviderDeadlineReached(error)) {
					return pauseReconciliation(lease, pagesProcessed, issues, clock, client);
				}
				await persistFailure(lease, "STRIPE_RECONCILIATION_SOURCE_FAILURE", clock(), client);
				throw new Error("STRIPE_RECONCILIATION_SOURCE_FAILURE");
			}
			if (lease.stage === "INVOICES") {
				const invoiceObjectsRead = page.facts.length + page.issues.length;
				if (invoiceObjectsRead > stagePageSize) {
					await persistFailure(
						lease,
						"STRIPE_RECONCILIATION_LOOKUP_BUDGET_EXCEEDED",
						clock(),
						client,
					);
					throw new Error("STRIPE_RECONCILIATION_LOOKUP_BUDGET_EXCEEDED");
				}
				invoicePaymentLookupsRemaining -= invoiceObjectsRead;
			}
			if (isRunDeadlineReached(runDeadlineAt)) {
				return pauseReconciliation(lease, pagesProcessed, issues, clock, client);
			}
			await renewCheckpointLease(lease, clock(), client);

			for (const issue of page.issues) {
				if (isRunDeadlineReached(runDeadlineAt)) {
					return pauseReconciliation(lease, pagesProcessed, issues, clock, client);
				}
				try {
					await recordSourceIssue(lease, issue, clock, client);
				} catch (error) {
					if (isLeaseLost(error)) throw error;
					await persistFailure(lease, "STRIPE_RECONCILIATION_ISSUE_WRITE_FAILURE", clock(), client);
					throw new Error("STRIPE_RECONCILIATION_ISSUE_WRITE_FAILURE");
				}
				issues += 1;
			}

			for (const fact of page.facts) {
				if (isRunDeadlineReached(runDeadlineAt)) {
					return pauseReconciliation(lease, pagesProcessed, issues, clock, client);
				}
				const factLease = lease;
				try {
					await runSerializable(client, async (tx) => {
						const operationTime = clock();
						await lockAndRenewCheckpointLease(factLease, operationTime, tx);
						await applyStripeBillingFact(fact, tx, { now: operationTime });
						await markSubscriptionSeen(factIdentity(fact), factLease, operationTime, true, tx);
					});
				} catch (error) {
					if (isLeaseLost(error)) throw error;
					const code = reviewableFactError(error);
					if (!code) {
						await persistFailure(factLease, "STRIPE_RECONCILIATION_APPLY_FAILURE", clock(), client);
						throw new Error("STRIPE_RECONCILIATION_APPLY_FAILURE");
					}
					try {
						await recordFactIssue(factLease, fact, code, clock, client);
					} catch (issueError) {
						if (isLeaseLost(issueError)) throw issueError;
						await persistFailure(
							factLease,
							"STRIPE_RECONCILIATION_ISSUE_WRITE_FAILURE",
							clock(),
							client,
						);
						throw new Error("STRIPE_RECONCILIATION_ISSUE_WRITE_FAILURE");
					}
					issues += 1;
				}
			}
			if (isRunDeadlineReached(runDeadlineAt)) {
				return pauseReconciliation(lease, pagesProcessed, issues, clock, client);
			}

			if (lease.stage === "SUBSCRIPTIONS" && !page.hasMore) {
				issues += await recordMissingSubscriptions(lease, clock, client);
			}

			const advancement = await advanceCheckpoint(lease, page, clock(), client);
			pagesProcessed += 1;
			if (advancement.completed) {
				return {
					skipped: false,
					completed: true,
					pagesProcessed,
					issues,
					sweepId: lease.sweepId,
				};
			}
			lease = advancement.lease;
		}

		return pauseReconciliation(lease, pagesProcessed, issues, clock, client);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("STRIPE_RECONCILIATION_")) {
			throw error;
		}
		await persistFailure(lease, "STRIPE_RECONCILIATION_INTERNAL_FAILURE", clock(), client);
		throw new Error("STRIPE_RECONCILIATION_INTERNAL_FAILURE");
	}
}

async function pauseReconciliation(
	lease: CheckpointLease,
	pagesProcessed: number,
	issues: number,
	clock: ReconciliationClock,
	client: DatabaseClient,
): Promise<ReconcileStripeBillingResult> {
	const continuationSequence = await releaseCheckpointForContinuation(lease, clock, client);
	return {
		skipped: false,
		completed: false,
		pagesProcessed,
		issues,
		sweepId: lease.sweepId,
		continuationKey: continuationKey(lease.sweepId, continuationSequence),
		continuationSequence,
	};
}

async function claimCheckpoint(
	input: {
		now: Date;
		leaseSeconds: number;
		expectedSweepId?: string;
		continuationSequence: number;
	},
	client: DatabaseClient,
): Promise<CheckpointClaim> {
	return runSerializable(client, async (tx) => {
		await tx.$queryRaw<Array<{ locked: string }>>`
			SELECT pg_advisory_xact_lock(hashtextextended(${CHECKPOINT_ID}, 0))::text AS "locked"`;
		let checkpoint = await tx.stripeReconciliationCheckpoint.findUnique({
			where: { provider: PROVIDER },
		});
		if (!checkpoint) {
			checkpoint = await tx.stripeReconciliationCheckpoint.create({
				data: { id: CHECKPOINT_ID, provider: PROVIDER },
			});
		}
		const startingNewSweep = checkpoint.status === "IDLE";
		if (startingNewSweep && input.expectedSweepId) {
			return { kind: "SKIP", reason: "SWEEP_NOT_ACTIVE" };
		}
		if (!startingNewSweep) {
			if (!checkpoint.sweepId || !checkpoint.sweepCutoff) {
				throw new Error("STRIPE_RECONCILIATION_CHECKPOINT_INVALID");
			}
			if (input.expectedSweepId && input.expectedSweepId !== checkpoint.sweepId) {
				return { kind: "SKIP", reason: "SWEEP_NOT_ACTIVE" };
			}
			if (input.continuationSequence < checkpoint.continuationSequence) {
				return {
					kind: "REPLAY",
					sweepId: checkpoint.sweepId,
					continuationSequence: checkpoint.continuationSequence,
				};
			}
			if (input.continuationSequence > checkpoint.continuationSequence) {
				return { kind: "SKIP", reason: "CONTINUATION_INVALID" };
			}
			if (checkpoint.leaseToken && checkpoint.leasedUntil && checkpoint.leasedUntil > input.now) {
				return { kind: "SKIP", reason: "LEASE_ACTIVE" };
			}
		}

		const token = randomUUID();
		const sweepId = startingNewSweep ? randomUUID() : checkpoint.sweepId;
		const cutoff = startingNewSweep ? input.now : checkpoint.sweepCutoff;
		if (!sweepId || !cutoff) throw new Error("STRIPE_RECONCILIATION_CHECKPOINT_INVALID");
		const stage = startingNewSweep ? "SUBSCRIPTIONS" : checkpoint.stage;
		const cursor = startingNewSweep ? null : checkpoint.cursor;
		await tx.stripeReconciliationCheckpoint.update({
			where: { id: checkpoint.id },
			data: {
				status: "RUNNING",
				sweepId,
				sweepCutoff: cutoff,
				stage,
				cursor,
				leaseToken: token,
				leasedUntil: addSeconds(input.now, input.leaseSeconds),
				lastAttemptAt: input.now,
				lastErrorCode: null,
				...(startingNewSweep
					? { pagesProcessed: 0, continuationSequence: 0, failureCount: 0 }
					: {}),
			},
		});
		return {
			kind: "LEASE",
			lease: {
				id: checkpoint.id,
				token,
				sweepId,
				cutoff,
				stage,
				cursor,
				progress: startingNewSweep ? 0 : checkpoint.pagesProcessed,
				continuationSequence: startingNewSweep ? 0 : checkpoint.continuationSequence,
				leaseSeconds: input.leaseSeconds,
			},
		};
	});
}

async function loadStagePage(
	stage: ReconciliationStage,
	input: StripeBillingPageInput,
	source: StripeBillingSource,
): Promise<StripeBillingPage<StripeBillingFact>> {
	switch (stage) {
		case "SUBSCRIPTIONS":
			return source.listSubscriptionsPage(input);
		case "INVOICES":
			return source.listPaidInvoicesPage(input);
		case "REFUNDS":
			return source.listRefundsPage(input);
	}
}

async function renewCheckpointLease(
	lease: CheckpointLease,
	now: Date,
	client: DatabaseClient,
): Promise<void> {
	const changed = await client.stripeReconciliationCheckpoint.updateMany({
		where: {
			id: lease.id,
			status: "RUNNING",
			leaseToken: lease.token,
			leasedUntil: { gt: now },
		},
		data: { leasedUntil: addSeconds(now, lease.leaseSeconds) },
	});
	if (changed.count !== 1) throw new Error("STRIPE_RECONCILIATION_LEASE_LOST");
}

async function advanceCheckpoint(
	lease: CheckpointLease,
	page: StripeBillingPage<StripeBillingFact>,
	now: Date,
	client: DatabaseClient,
): Promise<{ completed: true } | { completed: false; lease: CheckpointLease }> {
	if (page.hasMore && !page.nextCursor) {
		await persistFailure(lease, "STRIPE_RECONCILIATION_CURSOR_MISSING", now, client);
		throw new Error("STRIPE_RECONCILIATION_CURSOR_MISSING");
	}
	const completed = !page.hasMore && lease.stage === "REFUNDS";
	const nextStage = page.hasMore ? lease.stage : stageAfter(lease.stage);
	const nextCursor = page.hasMore ? page.nextCursor : null;
	const changed = await client.stripeReconciliationCheckpoint.updateMany({
		where: {
			id: lease.id,
			status: "RUNNING",
			leaseToken: lease.token,
			leasedUntil: { gt: now },
		},
		data: completed
			? {
					status: "IDLE",
					sweepId: null,
					sweepCutoff: null,
					stage: "SUBSCRIPTIONS",
					cursor: null,
					leaseToken: null,
					leasedUntil: null,
					continuationSequence: 0,
					pagesProcessed: { increment: 1 },
					lastCompletedAt: now,
					lastErrorCode: null,
				}
			: {
					stage: nextStage,
					cursor: nextCursor,
					leasedUntil: addSeconds(now, lease.leaseSeconds),
					pagesProcessed: { increment: 1 },
					lastErrorCode: null,
				},
	});
	if (changed.count !== 1) throw new Error("STRIPE_RECONCILIATION_LEASE_LOST");
	if (completed) return { completed: true };
	return {
		completed: false,
		lease: {
			...lease,
			stage: nextStage,
			cursor: nextCursor,
			progress: lease.progress + 1,
		},
	};
}

async function releaseCheckpointForContinuation(
	lease: CheckpointLease,
	clock: ReconciliationClock,
	client: DatabaseClient,
): Promise<number> {
	return runSerializable(client, async (tx) => {
		const now = clock();
		await lockAndRenewCheckpointLease(lease, now, tx);
		const continuationSequence = lease.continuationSequence + 1;
		await tx.stripeReconciliationCheckpoint.update({
			where: { id: lease.id },
			data: { continuationSequence, leaseToken: null, leasedUntil: now },
		});
		return continuationSequence;
	});
}

async function persistFailure(
	lease: CheckpointLease,
	code: string,
	now: Date,
	client: DatabaseClient,
) {
	try {
		await client.stripeReconciliationCheckpoint.updateMany({
			where: { id: lease.id, status: "RUNNING", leaseToken: lease.token },
			data: {
				leaseToken: null,
				leasedUntil: now,
				failureCount: { increment: 1 },
				lastErrorCode: code,
			},
		});
	} catch {
		// The caller will throw only a stable code. A checkpoint write failure must never
		// replace it with a provider/database object that could contain sensitive details.
	}
}

async function recordSourceIssue(
	lease: CheckpointLease,
	issue: StripeBillingSourceIssue,
	clock: ReconciliationClock,
	client: DatabaseClient,
) {
	await runSerializable(client, async (tx) => {
		const now = clock();
		await lockAndRenewCheckpointLease(lease, now, tx);
		await upsertIssue(
			lease,
			issue,
			issue.code,
			{ providerObjectId: issue.providerObjectId },
			now,
			tx,
		);
		await markSubscriptionSeen(issue, lease, now, false, tx);
	});
}

async function recordFactIssue(
	lease: CheckpointLease,
	fact: StripeBillingFact,
	code: string,
	clock: ReconciliationClock,
	client: DatabaseClient,
) {
	const identity = factIdentity(fact);
	await runSerializable(client, async (tx) => {
		const now = clock();
		await lockAndRenewCheckpointLease(lease, now, tx);
		if (code === "STRIPE_LEGACY_REFUND_REPAIR_REQUIRED" && fact.kind === "REFUND") {
			await persistStripeRefundLifecycleForReview(fact, tx);
		}
		await upsertIssue(
			lease,
			identity,
			code,
			{ factKind: fact.kind, providerObjectId: identity.providerObjectId },
			now,
			tx,
		);
		await markSubscriptionSeen(identity, lease, now, false, tx);
	});
}

async function upsertIssue(
	lease: CheckpointLease,
	identity: ReconciliationEntityIdentity,
	code: string,
	details: Prisma.InputJsonObject,
	now: Date,
	client: Prisma.TransactionClient,
) {
	const issueKey = `${PROVIDER}:${identity.entityType}:${identity.providerObjectId}:${code}`;
	await client.stripeReconciliationIssue.upsert({
		where: { issueKey },
		create: {
			issueKey,
			provider: PROVIDER,
			sweepId: lease.sweepId,
			stage: lease.stage,
			code,
			entityType: identity.entityType,
			providerObjectId: identity.providerObjectId,
			details,
			lastSeenAt: now,
		},
		update: {
			sweepId: lease.sweepId,
			stage: lease.stage,
			status: "OPEN",
			resolvedAt: null,
			occurrences: { increment: 1 },
			lastSeenAt: now,
		},
	});
}

async function markSubscriptionSeen(
	identity: ReconciliationEntityIdentity,
	lease: CheckpointLease,
	now: Date,
	applied: boolean,
	client: Prisma.TransactionClient,
) {
	if (identity.entityType !== "SUBSCRIPTION") return;
	await client.subscription.updateMany({
		where: {
			provider: PROVIDER,
			providerSubscriptionId: identity.providerObjectId,
		},
		data: {
			lastReconciliationSweepId: lease.sweepId,
			...(applied
				? {
						lastReconciliationAppliedSweepId: lease.sweepId,
						lastReconciledAt: now,
					}
				: {}),
		},
	});
	await client.stripeReconciliationIssue.updateMany({
		where: {
			issueKey: missingSubscriptionIssueKey(identity.providerObjectId),
			status: "OPEN",
		},
		data: { status: "RESOLVED", resolvedAt: now },
	});
}

async function recordMissingSubscriptions(
	lease: CheckpointLease,
	clock: ReconciliationClock,
	client: DatabaseClient,
): Promise<number> {
	return runSerializable(client, async (tx) => {
		const now = clock();
		await lockAndRenewCheckpointLease(lease, now, tx);
		const [result] = await tx.$queryRaw<Array<{ count: bigint }>>`
			WITH missing AS (
				SELECT
					"providerSubscriptionId",
					${`${PROVIDER}:SUBSCRIPTION:`} || "providerSubscriptionId" || ${":STRIPE_SUBSCRIPTION_MISSING_FROM_PROVIDER"} AS "issueKey"
				FROM "subscription"
				WHERE "provider" = ${PROVIDER}
					AND "status" IN ('PENDING', 'ACTIVE', 'PAST_DUE')
					AND "createdAt" <= ${lease.cutoff}
					AND "lastReconciliationSweepId" IS DISTINCT FROM ${lease.sweepId}
			), upserted AS (
				INSERT INTO "stripe_reconciliation_issue" (
					"id", "issueKey", "provider", "sweepId", "stage", "code",
					"entityType", "providerObjectId", "status", "details",
					"occurrences", "firstSeenAt", "lastSeenAt"
				)
				SELECT
					"issueKey", "issueKey", ${PROVIDER}, ${lease.sweepId},
					'SUBSCRIPTIONS'::"StripeReconciliationStage",
					'STRIPE_SUBSCRIPTION_MISSING_FROM_PROVIDER', 'SUBSCRIPTION',
					"providerSubscriptionId", 'OPEN'::"StripeReconciliationIssueStatus",
					jsonb_build_object('providerObjectId', "providerSubscriptionId"),
					1, ${now}, ${now}
				FROM missing
				ON CONFLICT ("issueKey") DO UPDATE SET
					"sweepId" = EXCLUDED."sweepId",
					"stage" = EXCLUDED."stage",
					"status" = 'OPEN'::"StripeReconciliationIssueStatus",
					"resolvedAt" = NULL,
					"occurrences" = "stripe_reconciliation_issue"."occurrences" + 1,
					"lastSeenAt" = EXCLUDED."lastSeenAt"
				RETURNING 1
			)
			SELECT COUNT(*)::bigint AS "count" FROM upserted`;
		return Number(result?.count ?? 0n);
	});
}

async function lockAndRenewCheckpointLease(
	lease: CheckpointLease,
	now: Date,
	client: Prisma.TransactionClient,
): Promise<void> {
	const [checkpoint] = await client.$queryRaw<
		Array<{ status: string; leaseToken: string | null; leasedUntil: Date | null }>
	>`
		SELECT "status"::text AS "status", "leaseToken", "leasedUntil"
		FROM "stripe_reconciliation_checkpoint"
		WHERE "id" = ${lease.id}
		FOR UPDATE`;
	if (
		!checkpoint ||
		checkpoint.status !== "RUNNING" ||
		checkpoint.leaseToken !== lease.token ||
		!checkpoint.leasedUntil ||
		checkpoint.leasedUntil.getTime() <= now.getTime()
	) {
		throw new Error("STRIPE_RECONCILIATION_LEASE_LOST");
	}
	await client.stripeReconciliationCheckpoint.update({
		where: { id: lease.id },
		data: { leasedUntil: addSeconds(now, lease.leaseSeconds) },
	});
}

interface ReconciliationEntityIdentity {
	entityType: "SUBSCRIPTION" | "INVOICE" | "REFUND";
	providerObjectId: string;
}

function factIdentity(fact: StripeBillingFact): ReconciliationEntityIdentity {
	switch (fact.kind) {
		case "SUBSCRIPTION":
			return { entityType: "SUBSCRIPTION", providerObjectId: fact.providerSubscriptionId };
		case "PAID_INVOICE":
		case "INVOICE_PAYMENT_FAILED":
			return { entityType: "INVOICE", providerObjectId: fact.providerInvoiceId };
		case "REFUND":
			return { entityType: "REFUND", providerObjectId: fact.providerRefundId };
	}
}

function reviewableFactError(error: unknown): string | null {
	const message = error instanceof Error ? error.message : "";
	return REVIEWABLE_FACT_ERROR_CODES.has(message) ? message : null;
}

function missingSubscriptionIssueKey(providerSubscriptionId: string): string {
	return `${PROVIDER}:SUBSCRIPTION:${providerSubscriptionId}:STRIPE_SUBSCRIPTION_MISSING_FROM_PROVIDER`;
}

function isLeaseLost(error: unknown): boolean {
	return error instanceof Error && error.message === "STRIPE_RECONCILIATION_LEASE_LOST";
}

function stageAfter(stage: ReconciliationStage): ReconciliationStage {
	if (stage === "SUBSCRIPTIONS") return "INVOICES";
	if (stage === "INVOICES") return "REFUNDS";
	return "SUBSCRIPTIONS";
}

function addSeconds(value: Date, seconds: number): Date {
	return new Date(value.getTime() + seconds * 1_000);
}

function isRunDeadlineReached(deadlineAt: number): boolean {
	return Date.now() >= deadlineAt;
}

function isProviderDeadlineReached(error: unknown): boolean {
	return error instanceof Error && error.message === "STRIPE_RECONCILIATION_RUN_DEADLINE_REACHED";
}

function continuationKey(sweepId: string, sequence: number): string {
	return `stripe-reconciliation:${sweepId}:continuation:${sequence}`;
}

function clampInteger(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
) {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value)) throw new Error("STRIPE_RECONCILIATION_LIMIT_INVALID");
	return Math.min(Math.max(value, minimum), maximum);
}
