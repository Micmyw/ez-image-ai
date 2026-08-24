import type Stripe from "stripe";

import {
	normalizeStripeInvoice,
	normalizeStripeInvoicePayment,
	normalizeStripeRefund,
	normalizeStripeSubscription,
	type StripePaidInvoiceFact,
	type StripeRefundFact,
	type StripeSubscriptionFact,
} from "./normalization";

export interface StripeBillingPageInput {
	cutoff: Date;
	cursor: string | null;
	limit: number;
	sweepId: string;
	requestTimeoutMs?: number;
	requestDeadlineAtMs?: number;
}

export interface StripeBillingPage<T> {
	facts: T[];
	issues: StripeBillingSourceIssue[];
	hasMore: boolean;
	nextCursor: string | null;
}

const STRIPE_BILLING_SOURCE_ISSUE_CODES = [
	"STRIPE_BILLING_OBJECT_NORMALIZATION_FAILED",
	"STRIPE_EVENT_INVALID_CURRENCY",
	"STRIPE_EVENT_INVALID_INVOICE_AMOUNT_PAID",
	"STRIPE_EVENT_INVALID_INVOICE_LINE_PERIOD_END",
	"STRIPE_EVENT_INVALID_INVOICE_LINE_PERIOD_START",
	"STRIPE_EVENT_INVALID_INVOICE_PAYMENT_AMOUNT_PAID",
	"STRIPE_EVENT_INVALID_INVOICE_PERIOD_END",
	"STRIPE_EVENT_INVALID_INVOICE_PERIOD_START",
	"STRIPE_EVENT_INVALID_REFUND_AMOUNT",
	"STRIPE_EVENT_INVALID_REFUND_CREATED",
	"STRIPE_EVENT_INVALID_SUBSCRIPTION_ITEM_CURRENT_PERIOD_END",
	"STRIPE_EVENT_INVALID_SUBSCRIPTION_ITEM_CURRENT_PERIOD_START",
	"STRIPE_EVENT_MISSING_INVOICE_ID",
	"STRIPE_EVENT_MISSING_INVOICE_PAYMENT_ID",
	"STRIPE_EVENT_MISSING_REFUND_ID",
	"STRIPE_EVENT_MISSING_SUBSCRIPTION_CUSTOMER",
	"STRIPE_EVENT_MISSING_SUBSCRIPTION_ID",
	"STRIPE_EVENT_MISSING_SUBSCRIPTION_PRICE_ID",
	"STRIPE_INVOICE_CUSTOMER_MISSING",
	"STRIPE_INVOICE_BILLING_REASON_UNSUPPORTED",
	"STRIPE_INVOICE_LINES_INCOMPLETE",
	"STRIPE_INVOICE_PAYMENT_AMBIGUOUS",
	"STRIPE_INVOICE_PAYMENT_AMOUNT_MISMATCH",
	"STRIPE_INVOICE_PAYMENT_CHARGE_MISSING",
	"STRIPE_INVOICE_PAYMENT_METHOD_UNSUPPORTED",
	"STRIPE_INVOICE_PAYMENT_NOT_PAID",
	"STRIPE_INVOICE_PAYMENT_PAGE_OVERFLOW",
	"STRIPE_INVOICE_PLAN_AMBIGUOUS",
	"STRIPE_INVOICE_PRORATION_UNSUPPORTED",
	"STRIPE_INVOICE_SUBSCRIPTION_LINE_AMBIGUOUS",
	"STRIPE_INVOICE_SUBSCRIPTION_LINE_INVALID",
	"STRIPE_INVOICE_SUBSCRIPTION_MISMATCH",
	"STRIPE_REFUND_CHARGE_MISSING",
	"STRIPE_REFUND_STATUS_UNSUPPORTED",
	"STRIPE_SUBSCRIPTION_ID_MISSING",
	"STRIPE_SUBSCRIPTION_ITEM_AMBIGUOUS",
] as const;

export type StripeBillingSourceIssueCode = (typeof STRIPE_BILLING_SOURCE_ISSUE_CODES)[number];

export interface StripeBillingSourceIssue {
	code: StripeBillingSourceIssueCode;
	entityType: "SUBSCRIPTION" | "INVOICE" | "REFUND";
	providerObjectId: string;
}

export interface StripeBillingSource {
	listSubscriptionsPage(
		input: StripeBillingPageInput,
	): Promise<StripeBillingPage<StripeSubscriptionFact>>;
	listPaidInvoicesPage(
		input: StripeBillingPageInput,
	): Promise<StripeBillingPage<StripePaidInvoiceFact>>;
	listRefundsPage(input: StripeBillingPageInput): Promise<StripeBillingPage<StripeRefundFact>>;
	listInvoicePayments(invoiceId: string): Promise<Stripe.InvoicePayment[]>;
}

export function createStripeBillingSource(stripe: Stripe): StripeBillingSource {
	const fetchInvoicePaymentsPage = (
		invoiceId: string,
		requestBudget: Pick<StripeBillingPageInput, "requestTimeoutMs" | "requestDeadlineAtMs"> = {},
	) => {
		const parameters = {
			invoice: invoiceId,
			status: "paid" as const,
			limit: 100,
			expand: ["data.payment.payment_intent.latest_charge"],
		};
		const requestOptions = stripeRequestOptions(requestBudget);
		return requestOptions === undefined
			? stripe.invoicePayments.list(parameters)
			: stripe.invoicePayments.list(parameters, requestOptions);
	};

	const listInvoicePayments = async (invoiceId: string) => {
		const page = await fetchInvoicePaymentsPage(invoiceId, { requestTimeoutMs: 10_000 });
		if (page.has_more) throw new Error("STRIPE_INVOICE_PAYMENT_PAGE_OVERFLOW");
		return page.data;
	};

	return {
		async listSubscriptionsPage(input) {
			const parameters = {
				status: "all",
				created: { lte: toUnixSeconds(input.cutoff) },
				...(input.cursor ? { starting_after: input.cursor } : {}),
				limit: input.limit,
			} as const;
			const requestOptions = stripeRequestOptions(input);
			const page = await (requestOptions === undefined
				? stripe.subscriptions.list(parameters)
				: stripe.subscriptions.list(parameters, requestOptions));
			const normalized = collectNormalizedObjects(page.data, "SUBSCRIPTION", (subscription) =>
				normalizeStripeSubscription(subscription, {
					origin: "RECONCILIATION",
					changeAt: input.cutoff,
					changeId: `stripe-reconcile:${input.sweepId}:subscription:${subscription.id}`,
				}),
			);
			return normalizePage(
				normalized.facts,
				normalized.issues,
				page.has_more,
				page.data[page.data.length - 1]?.id ?? null,
			);
		},

		async listPaidInvoicesPage(input) {
			const parameters = {
				status: "paid",
				created: { lte: toUnixSeconds(input.cutoff) },
				...(input.cursor ? { starting_after: input.cursor } : {}),
				limit: input.limit,
			} as const;
			const requestOptions = stripeRequestOptions(input);
			const page = await (requestOptions === undefined
				? stripe.invoices.list(parameters)
				: stripe.invoices.list(parameters, requestOptions));
			const facts: StripePaidInvoiceFact[] = [];
			const issues: StripeBillingSourceIssue[] = [];
			for (const invoice of page.data) {
				// Keep the remote call outside the normalization boundary. Stripe API
				// failures abort the page so its cursor is retried; only one bad object
				// becomes a review issue.
				const paymentPage = await fetchInvoicePaymentsPage(invoice.id, input);
				const normalized = captureNormalizedObject(invoice, "INVOICE", () => {
					if (paymentPage.has_more) {
						throw new Error("STRIPE_INVOICE_PAYMENT_PAGE_OVERFLOW");
					}
					const payments = paymentPage.data.map(normalizeStripeInvoicePayment);
					return normalizeStripeInvoice(invoice, payments, {
						origin: "RECONCILIATION",
						changeAt: input.cutoff,
						changeId: `stripe-reconcile:${input.sweepId}:invoice:${invoice.id}`,
					});
				});
				if (normalized.ok) facts.push(normalized.fact);
				else issues.push(normalized.issue);
			}
			return normalizePage(
				facts,
				issues,
				page.has_more,
				page.data[page.data.length - 1]?.id ?? null,
			);
		},

		async listRefundsPage(input) {
			const parameters = {
				created: { lte: toUnixSeconds(input.cutoff) },
				...(input.cursor ? { starting_after: input.cursor } : {}),
				limit: input.limit,
			} as const;
			const requestOptions = stripeRequestOptions(input);
			const page = await (requestOptions === undefined
				? stripe.refunds.list(parameters)
				: stripe.refunds.list(parameters, requestOptions));
			const normalized = collectNormalizedObjects(page.data, "REFUND", (refund) =>
				normalizeStripeRefund(refund, {
					origin: "RECONCILIATION",
					changeAt: input.cutoff,
					changeId: `stripe-reconcile:${input.sweepId}:refund:${refund.id}`,
				}),
			);
			return normalizePage(
				normalized.facts,
				normalized.issues,
				page.has_more,
				page.data[page.data.length - 1]?.id ?? null,
			);
		},

		listInvoicePayments,
	};
}

function normalizePage<T>(
	facts: T[],
	issues: StripeBillingSourceIssue[],
	hasMore: boolean,
	nextCursor: string | null,
): StripeBillingPage<T> {
	if (hasMore && !nextCursor) throw new Error("STRIPE_PAGE_CURSOR_MISSING");
	return { facts, issues, hasMore, nextCursor };
}

const stripeBillingSourceIssueCodeSet = new Set<string>(STRIPE_BILLING_SOURCE_ISSUE_CODES);

function collectNormalizedObjects<TInput extends { id?: string }, TFact>(
	objects: readonly TInput[],
	entityType: StripeBillingSourceIssue["entityType"],
	normalize: (object: TInput) => TFact,
): { facts: TFact[]; issues: StripeBillingSourceIssue[] } {
	const facts: TFact[] = [];
	const issues: StripeBillingSourceIssue[] = [];
	for (const object of objects) {
		const normalized = captureNormalizedObject(object, entityType, () => normalize(object));
		if (normalized.ok) facts.push(normalized.fact);
		else issues.push(normalized.issue);
	}
	return { facts, issues };
}

function captureNormalizedObject<TFact>(
	object: { id?: string },
	entityType: StripeBillingSourceIssue["entityType"],
	normalize: () => TFact,
): { ok: true; fact: TFact } | { ok: false; issue: StripeBillingSourceIssue } {
	try {
		return { ok: true, fact: normalize() };
	} catch (error) {
		return {
			ok: false,
			issue: {
				code: safeIssueCode(error),
				entityType,
				providerObjectId: safeProviderObjectId(object.id),
			},
		};
	}
}

function safeIssueCode(error: unknown): StripeBillingSourceIssueCode {
	const message = error instanceof Error ? error.message : "";
	return stripeBillingSourceIssueCodeSet.has(message)
		? (message as StripeBillingSourceIssueCode)
		: "STRIPE_BILLING_OBJECT_NORMALIZATION_FAILED";
}

function safeProviderObjectId(value: unknown): string {
	return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function toUnixSeconds(value: Date): number {
	if (Number.isNaN(value.getTime())) throw new Error("STRIPE_RECONCILIATION_CUTOFF_INVALID");
	return Math.floor(value.getTime() / 1_000);
}

function stripeRequestOptions(
	input: Pick<StripeBillingPageInput, "requestTimeoutMs" | "requestDeadlineAtMs">,
): { timeout: number } | undefined {
	let timeout = input.requestTimeoutMs;
	if (input.requestDeadlineAtMs !== undefined) {
		if (!Number.isSafeInteger(input.requestDeadlineAtMs) || input.requestDeadlineAtMs < 0) {
			throw new Error("STRIPE_RECONCILIATION_REQUEST_DEADLINE_INVALID");
		}
		const remaining = input.requestDeadlineAtMs - Date.now();
		if (remaining <= 0) {
			throw new Error("STRIPE_RECONCILIATION_RUN_DEADLINE_REACHED");
		}
		timeout = timeout === undefined ? remaining : Math.min(timeout, remaining);
	}
	if (timeout === undefined) return undefined;
	if (!Number.isSafeInteger(timeout) || timeout <= 0) {
		throw new Error("STRIPE_RECONCILIATION_REQUEST_TIMEOUT_INVALID");
	}
	return { timeout };
}
