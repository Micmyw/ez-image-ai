import { z } from "zod";

export const checkoutRecoveryStatusSchema = z.enum([
	"PENDING",
	"CHECKING",
	"APPROVED",
	"ACTIVATING",
	"PAID",
	"CLOSED",
	"WAITING",
	"UNKNOWN",
	"REVIEW",
]);
export type CheckoutRecoveryStatus = z.infer<typeof checkoutRecoveryStatusSchema>;
const recoverySchema = z.object({
	version: z.literal(1),
	mode: z.enum(["LEGACY", "AUTOMATIC", "MERCHANT"]),
	environment: z.string().optional(),
	scope: z.string().optional(),
	sequence: z.number().int().nonnegative().default(0),
	completedSequence: z.number().int().nonnegative().optional(),
	status: checkoutRecoveryStatusSchema.default("PENDING"),
	failures: z.number().int().nonnegative().default(0),
	checks: z.number().int().nonnegative().default(0),
	cancelRequestedAt: z.iso.datetime().optional(),
	activationRequestedAt: z.iso.datetime().optional(),
	checkedAt: z.iso.datetime().optional(),
	nextCheckAt: z.iso.datetime().optional(),
	waitUntil: z.iso.datetime().optional(),
	reason: z.string().optional(),
	leaseToken: z.string().optional(),
	leasedUntil: z.iso.datetime().optional(),
	resolution: z
		.object({
			operationKey: z.string(),
			actorUserId: z.string(),
			expectedUpdatedAt: z.string(),
			reason: z.string(),
			evidenceReference: z.string(),
			resolvedAt: z.iso.datetime(),
		})
		.optional(),
});
export type CheckoutRecovery = z.infer<typeof recoverySchema>;
export function readCheckoutRecovery(value: unknown): CheckoutRecovery {
	const result = recoverySchema.safeParse(value);
	return result.success
		? result.data
		: { version: 1, mode: "LEGACY", sequence: 0, status: "PENDING", failures: 0, checks: 0 };
}

export interface RecoverableCheckout {
	id: string;
	provider: string;
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
	submittedByUserId: string;
	productKind: string;
	status: string;
	planKey: string;
	interval: string;
	providerSessionId: string | null;
	providerOrderId: string | null;
	providerCheckoutUrl: string | null;
	checkoutRecovery: unknown;
	expiresAt: Date | null;
	updatedAt?: Date;
	billingPlan: { providerPriceId: string; metadata?: unknown };
}
export type CheckoutRecoveryPatch = {
	checkoutRecovery: CheckoutRecovery;
	status?: "CANCELED" | "REVIEW" | "PROVIDER_PENDING";
	activeScopeKey?: null;
	providerCheckoutUrl?: null;
	providerOrderId?: string;
};
export interface CheckoutRecoveryTransaction {
	lock(owner: { ownerType: string; ownerId: string }): Promise<void>;
	lockProvider(intent: RecoverableCheckout): Promise<void>;
	find(id: string): Promise<RecoverableCheckout | null>;
	hasFinancialActivity(intent: RecoverableCheckout, requireUnapproved?: boolean): Promise<boolean>;
	update(id: string, patch: CheckoutRecoveryPatch): Promise<RecoverableCheckout>;
	enqueue(id: string, sequence: number, availableAt: Date): Promise<void>;
	audit(
		intent: RecoverableCheckout,
		action: string,
		actorUserId?: string,
		metadata?: Record<string, unknown>,
	): Promise<void>;
}
export interface CheckoutRecoveryPersistence {
	transaction<T>(work: (tx: CheckoutRecoveryTransaction) => Promise<T>): Promise<T>;
}
export type OwnedCheckoutRecoveryInput = {
	id: string;
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
	actorUserId: string;
	cancel?: boolean;
	/** Explicit human retry; automatic polling and recovery must leave REVIEW stable. */
	retryReview?: boolean;
	now?: Date;
};
const pendingStatuses = ["CREATED", "PROVIDER_CREATING", "PROVIDER_PENDING", "REVIEW"];
function terminal(intent: RecoverableCheckout) {
	return !pendingStatuses.includes(intent.status);
}
function settledState(intent: RecoverableCheckout): CheckoutRecoveryStatus {
	return intent.status === "COMPLETED"
		? "PAID"
		: intent.status === "CANCELED"
			? "CLOSED"
			: readCheckoutRecovery(intent.checkoutRecovery).status;
}

/** Eligibility only; fresh provider evidence and financial checks are still required. */
export function canReviewLegacyCheckout(intent: RecoverableCheckout, now = new Date()) {
	const state = readCheckoutRecovery(intent.checkoutRecovery);
	return (
		intent.provider === "paypal" &&
		intent.productKind === "PLAN" &&
		["PROVIDER_PENDING", "REVIEW"].includes(intent.status) &&
		Boolean(intent.providerSessionId) &&
		!intent.providerOrderId &&
		state.mode === "LEGACY" &&
		state.status === "REVIEW" &&
		state.failures >= 3 &&
		state.reason === "RESOURCE_NOT_FOUND" &&
		!state.activationRequestedAt &&
		(!state.leasedUntil || new Date(state.leasedUntil) <= now)
	);
}

/** Server-produced inspection, never accepted from an API client. */
export interface CheckoutReviewObservation {
	status: "UNKNOWN";
	reason: "RESOURCE_NOT_FOUND";
	checkedAt: string;
	environment: "sandbox" | "live";
	scope: string;
	priceId: string;
	providerSessionId: string;
}
export interface ResolveCheckoutReviewInput {
	id: string;
	actorUserId: string;
	expectedUpdatedAt: string;
	operationKey: string;
	reason: string;
	evidenceReference: string;
	customerConfirmedNoApproval: boolean;
	merchantRecordsReviewed: boolean;
	providerObservation?: CheckoutReviewObservation;
	now?: Date;
}

/** An audited operator decision, not a claim that PayPal confirmed cancellation. */
export async function resolveCheckoutReviewWithStore(
	input: ResolveCheckoutReviewInput,
	store: CheckoutRecoveryPersistence,
) {
	return store.transaction(async (tx) => {
		const initial = await tx.find(input.id);
		if (!initial) throw new Error("CHECKOUT_NOT_FOUND");
		// Same order as lifecycle processing: provider resource, then subscription owner.
		await tx.lockProvider(initial);
		await tx.lock(initial);
		const intent = await tx.find(input.id);
		if (!intent) throw new Error("CHECKOUT_NOT_FOUND");
		const state = readCheckoutRecovery(intent.checkoutRecovery);
		if (
			!input.customerConfirmedNoApproval ||
			!input.merchantRecordsReviewed ||
			input.reason.trim().length < 10 ||
			input.reason.length > 500 ||
			input.evidenceReference.trim().length < 10 ||
			input.evidenceReference.length > 500 ||
			input.operationKey.length < 8 ||
			input.operationKey.length > 128 ||
			!input.actorUserId
		)
			throw new Error("CHECKOUT_REVIEW_EVIDENCE_REQUIRED");
		if (state.resolution) {
			const prior = state.resolution;
			if (
				intent.status === "CANCELED" &&
				state.status === "CLOSED" &&
				prior.operationKey === input.operationKey &&
				prior.actorUserId === input.actorUserId &&
				prior.expectedUpdatedAt === input.expectedUpdatedAt &&
				prior.reason === input.reason &&
				prior.evidenceReference === input.evidenceReference
			)
				return intent;
			throw new Error("CHECKOUT_REVIEW_STALE");
		}
		if (!intent.updatedAt || intent.updatedAt.toISOString() !== input.expectedUpdatedAt)
			throw new Error("CHECKOUT_REVIEW_STALE");
		const now = input.now ?? new Date();
		if (!canReviewLegacyCheckout(intent, now)) throw new Error("CHECKOUT_REVIEW_NOT_ELIGIBLE");
		const evidence = input.providerObservation;
		const age = now.getTime() - new Date(evidence?.checkedAt ?? "").getTime();
		if (
			!evidence ||
			evidence.status !== "UNKNOWN" ||
			evidence.reason !== "RESOURCE_NOT_FOUND" ||
			!Number.isFinite(age) ||
			age < 0 ||
			age >= 120_000 ||
			!evidence.scope ||
			!["live", "sandbox"].includes(evidence.environment) ||
			evidence.priceId !== intent.billingPlan.providerPriceId ||
			evidence.providerSessionId !== intent.providerSessionId
		)
			throw new Error("CHECKOUT_REVIEW_EVIDENCE_REQUIRED");
		if (await tx.hasFinancialActivity(intent, true))
			throw new Error("CHECKOUT_REVIEW_FINANCIAL_ACTIVITY");
		const resolution = {
			operationKey: input.operationKey,
			actorUserId: input.actorUserId,
			expectedUpdatedAt: input.expectedUpdatedAt,
			reason: input.reason,
			evidenceReference: input.evidenceReference,
			resolvedAt: now.toISOString(),
		};
		const closed = await tx.update(intent.id, {
			status: "CANCELED",
			activeScopeKey: null,
			providerCheckoutUrl: null,
			checkoutRecovery: {
				...state,
				status: "CLOSED",
				reason: "OPERATOR_REVIEWED_ABANDONMENT",
				resolution,
				cancelRequestedAt: state.cancelRequestedAt ?? now.toISOString(),
				leaseToken: undefined,
				leasedUntil: undefined,
				nextCheckAt: undefined,
			},
		});
		await tx.audit(intent, "PAYMENT_CHECKOUT_MANUALLY_CLOSED", input.actorUserId, {
			...resolution,
			providerConfirmed: false,
			providerObservation: evidence,
			customerConfirmedNoApproval: true,
			merchantRecordsReviewed: true,
			previousStatus: intent.status,
			previousRecovery: state,
		});
		return closed;
	});
}

/** Only this persisted MERCHANT mode can revoke activation without closing a PSP URL. */
export async function requestCheckoutRecoveryWithStore(
	input: OwnedCheckoutRecoveryInput,
	store: CheckoutRecoveryPersistence,
) {
	return store.transaction(async (tx) => {
		await tx.lock(input);
		const intent = await tx.find(input.id);
		if (
			!intent ||
			intent.productKind !== "PLAN" ||
			intent.ownerType !== input.ownerType ||
			intent.ownerId !== input.ownerId
		)
			throw new Error("CHECKOUT_NOT_FOUND");
		if (terminal(intent)) return intent;
		const now = input.now ?? new Date();
		const state = readCheckoutRecovery(intent.checkoutRecovery);
		if (state.status === "PAID") return intent;
		if (
			input.cancel &&
			!state.activationRequestedAt &&
			((intent.status === "CREATED" && !intent.providerSessionId) ||
				(intent.provider === "paypal" && state.mode === "MERCHANT")) &&
			!(await tx.hasFinancialActivity(intent))
		) {
			const closed = await tx.update(intent.id, {
				status: "CANCELED",
				activeScopeKey: null,
				providerCheckoutUrl: null,
				checkoutRecovery: {
					...state,
					status: "CLOSED",
					cancelRequestedAt: now.toISOString(),
					leaseToken: undefined,
					leasedUntil: undefined,
					reason: "ACTIVATION_REVOKED",
				},
			});
			await tx.audit(intent, "PAYMENT_CHECKOUT_ABANDONED", input.actorUserId);
			return closed;
		}
		if (input.cancel && !state.cancelRequestedAt) {
			state.cancelRequestedAt = now.toISOString();
			await tx.audit(intent, "PAYMENT_CHECKOUT_CLOSURE_REQUESTED", input.actorUserId);
		} else if (state.nextCheckAt && new Date(state.nextCheckAt) > now) return intent;
		if (state.status === "REVIEW" && !input.retryReview)
			return input.cancel ? tx.update(intent.id, { checkoutRecovery: state }) : intent;
		if (state.leasedUntil && new Date(state.leasedUntil) > now)
			return tx.update(intent.id, { checkoutRecovery: state });
		state.sequence += 1;
		state.nextCheckAt = new Date(now.getTime() + 15_000).toISOString();
		state.status = state.activationRequestedAt ? "ACTIVATING" : "CHECKING";
		const updated = await tx.update(intent.id, { checkoutRecovery: state });
		await tx.enqueue(intent.id, state.sequence, now);
		return updated;
	});
}

export async function claimCheckoutRecoveryWithStore(
	input: { id: string; sequence: number; now?: Date },
	store: CheckoutRecoveryPersistence,
) {
	return store.transaction(async (tx) => {
		const initial = await tx.find(input.id);
		if (!initial) return null;
		await tx.lock(initial);
		const intent = await tx.find(input.id);
		if (!intent || terminal(intent) || intent.productKind !== "PLAN") return null;
		const state = readCheckoutRecovery(intent.checkoutRecovery);
		const now = input.now ?? new Date();
		if (
			state.sequence !== input.sequence ||
			input.sequence <= (state.completedSequence ?? -1) ||
			(state.leasedUntil && new Date(state.leasedUntil) > now)
		)
			return null;
		const leaseToken = crypto.randomUUID();
		state.leaseToken = leaseToken;
		state.leasedUntil = new Date(now.getTime() + 90_000).toISOString();
		return { intent: await tx.update(intent.id, { checkoutRecovery: state }), leaseToken };
	});
}

export async function claimCheckoutActivationWithStore(
	input: { id: string; leaseToken: string; now?: Date },
	store: CheckoutRecoveryPersistence,
) {
	return store.transaction(async (tx) => {
		const initial = await tx.find(input.id);
		if (!initial) return false;
		await tx.lock(initial);
		const intent = await tx.find(input.id);
		if (!intent || terminal(intent)) return false;
		const state = readCheckoutRecovery(intent.checkoutRecovery);
		const now = input.now ?? new Date();
		if (
			intent.provider !== "paypal" ||
			state.mode !== "MERCHANT" ||
			state.leaseToken !== input.leaseToken ||
			!state.leasedUntil ||
			new Date(state.leasedUntil) <= now ||
			(state.cancelRequestedAt && !state.activationRequestedAt) ||
			(await tx.hasFinancialActivity(intent))
		)
			return false;
		await tx.update(intent.id, {
			checkoutRecovery: {
				...state,
				status: "ACTIVATING",
				activationRequestedAt: state.activationRequestedAt ?? now.toISOString(),
			},
		});
		return true;
	});
}

export interface CheckoutRecoveryResultInput {
	id: string;
	leaseToken: string;
	status: CheckoutRecoveryStatus;
	reason?: string;
	waitUntil?: Date;
	providerOrderId?: string;
	now?: Date;
}
export async function finishCheckoutRecoveryWithStore(
	input: CheckoutRecoveryResultInput,
	store: CheckoutRecoveryPersistence,
) {
	return store.transaction(async (tx) => {
		const initial = await tx.find(input.id);
		if (!initial) return null;
		await tx.lock(initial);
		const intent = await tx.find(input.id);
		if (!intent || terminal(intent)) return intent;
		const state = readCheckoutRecovery(intent.checkoutRecovery);
		const now = input.now ?? new Date();
		if (
			state.leaseToken !== input.leaseToken ||
			!state.leasedUntil ||
			new Date(state.leasedUntil) <= now
		)
			return intent;
		let status = input.status;
		if (
			input.providerOrderId &&
			intent.providerOrderId &&
			input.providerOrderId !== intent.providerOrderId
		)
			status = "UNKNOWN";
		if (status === "CLOSED" && (await tx.hasFinancialActivity(intent))) status = "PAID";
		const failures = status === "UNKNOWN" ? state.failures + 1 : 0;
		if (failures >= 3) status = "REVIEW";
		const checks = state.checks + 1;
		if (checks >= 12 && (status === "ACTIVATING" || status === "APPROVED")) status = "REVIEW";
		const nextCheck =
			input.waitUntil && input.waitUntil > now
				? input.waitUntil
				: new Date(now.getTime() + (status === "REVIEW" ? 300_000 : 30_000));
		const next: CheckoutRecovery = {
			...state,
			completedSequence: state.sequence,
			status,
			failures,
			checks,
			checkedAt: now.toISOString(),
			nextCheckAt: nextCheck.toISOString(),
			reason: input.reason,
			waitUntil: input.waitUntil?.toISOString(),
			leaseToken: undefined,
			leasedUntil: undefined,
		};
		const repeat =
			status === "WAITING" ||
			(status === "UNKNOWN" && failures < 3) ||
			(["PENDING", "APPROVED", "ACTIVATING"].includes(status) && checks < 12);
		if (repeat) next.sequence += 1;
		const updated = await tx.update(intent.id, {
			checkoutRecovery: next,
			...(input.providerOrderId && !intent.providerOrderId
				? { providerOrderId: input.providerOrderId }
				: {}),
			...(status === "CLOSED"
				? { status: "CANCELED", activeScopeKey: null, providerCheckoutUrl: null }
				: status !== "REVIEW" && intent.status === "REVIEW" && intent.providerSessionId
					? { status: "PROVIDER_PENDING" }
					: {}),
		});
		if (status === "CLOSED" || (status === "REVIEW" && state.status !== "REVIEW"))
			await tx.audit(
				intent,
				status === "CLOSED" ? "PAYMENT_CHECKOUT_CLOSED" : "PAYMENT_CHECKOUT_RECOVERY_REVIEW",
			);
		if (repeat) await tx.enqueue(intent.id, next.sequence, nextCheck);
		return updated;
	});
}

export function checkoutRecoveryView(intent: RecoverableCheckout) {
	const state = readCheckoutRecovery(intent.checkoutRecovery);
	return {
		id: intent.id,
		provider: intent.provider as "paypal" | "waffo",
		planId: intent.planKey,
		interval: intent.interval,
		status: terminal(intent) ? settledState(intent) : state.status,
		canResume:
			intent.status === "PROVIDER_PENDING" &&
			Boolean(intent.providerCheckoutUrl) &&
			!state.cancelRequestedAt &&
			!state.activationRequestedAt &&
			!["PAID", "REVIEW"].includes(state.status) &&
			(!intent.expiresAt || intent.expiresAt > new Date()),
		canChange:
			pendingStatuses.includes(intent.status) &&
			!state.cancelRequestedAt &&
			!state.activationRequestedAt &&
			state.status !== "PAID",
		waitUntil: state.waitUntil ?? null,
		checkedAt: state.checkedAt ?? null,
	};
}

/** Signed lifecycle/payment receipts must settle before releasing the owner's fence. */
export function hasCheckoutFinancialReceipt(envelope: unknown, requireUnapproved = false): boolean {
	if (!envelope || typeof envelope !== "object") return true;
	const value = envelope as Record<string, unknown>;
	const resource = value.resource as Record<string, unknown> | undefined;
	if (
		requireUnapproved &&
		(value.event_type !== "BILLING.SUBSCRIPTION.CREATED" ||
			resource?.status !== "APPROVAL_PENDING" ||
			resource?.subscriber)
	)
		return true;
	const billing = resource?.billing_info as
		| { last_payment?: unknown; cycle_executions?: Array<{ cycles_completed?: number }> }
		| undefined;
	if (
		["ACTIVE", "SUSPENDED"].includes(String(resource?.status)) ||
		billing?.last_payment ||
		(Array.isArray(billing?.cycle_executions) &&
			billing.cycle_executions.some((cycle) => Number(cycle.cycles_completed) > 0))
	)
		return true;
	// Creation/approval alone cannot charge a merchant-controlled PayPal attempt.
	return ![
		"BILLING.SUBSCRIPTION.CREATED",
		"BILLING.SUBSCRIPTION.APPROVED",
		"BILLING.SUBSCRIPTION.UPDATED",
		"BILLING.SUBSCRIPTION.CANCELLED",
		"BILLING.SUBSCRIPTION.EXPIRED",
	].includes(String(value.event_type));
}
