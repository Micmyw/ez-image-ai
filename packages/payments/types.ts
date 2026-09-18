export interface BasePrice {
	/**
	 * Price amount in major currency units, for example `29` for USD 29.00.
	 */
	amount: number;
	/**
	 * ISO currency code charged for this price.
	 */
	currency: string;
	/**
	 * Provider-specific price identifier. In client bundles this may be
	 * unavailable because env-backed values are stripped by Next.js.
	 */
	priceId?: string;
}

export const paymentProviderNames = ["stripe", "paypal", "waffo"] as const;

export type PaymentProviderName = (typeof paymentProviderNames)[number];

export interface PaymentProviderCapabilities {
	checkout: boolean;
	portal: boolean;
	cancellation: boolean;
	seatUpdates: boolean;
	webhooks: boolean;
}

export interface SubscriptionPrice {
	/**
	 * Marks the price as a subscription charge.
	 */
	type: "subscription";
	/**
	 * Billing cadence for the subscription.
	 */
	interval: "month" | "year";
	/**
	 * Indicates whether the subscription scales with seat count.
	 */
	seatBased?: boolean;
	/**
	 * Optional number of free trial days before billing starts.
	 */
	trialPeriodDays?: number;
	monthlyCredits?: number;
	maximumConcurrentJobs?: number;
	maximumStorageBytes?: number;
}

export interface OneTimePrice {
	/**
	 * Marks the price as a one-time purchase.
	 */
	type: "one-time";
}

export type PlanPrice = (BasePrice & SubscriptionPrice) | (BasePrice & OneTimePrice);

export interface PaidPlan {
	/**
	 * Purchasable prices offered for the plan.
	 */
	prices: PlanPrice[];
	/**
	 * Highlights the plan in pricing tables and comparison views.
	 */
	recommended?: boolean;
	/**
	 * Keeps the plan available in configuration while hiding it from standard UI.
	 */
	hidden?: boolean;
}

export interface EnterprisePlan {
	/**
	 * Marks the plan as sales-led rather than directly purchasable.
	 */
	isEnterprise: true;
	/**
	 * Highlights the plan in pricing tables and comparison views.
	 */
	recommended?: boolean;
	/**
	 * Keeps the plan available in configuration while hiding it from standard UI.
	 */
	hidden?: boolean;
}

export type Plan = PaidPlan | EnterprisePlan;

export interface PaymentsConfig {
	/**
	 * Determines whether subscriptions are owned by individual users or by
	 * organizations.
	 */
	billingAttachedTo: "user" | "organization";
	/**
	 * Forces users to hold an active subscription before accessing paid areas.
	 */
	requireActiveSubscription: boolean;
	/**
	 * Catalog of plans exposed to checkout, pricing pages, and billing logic.
	 */
	plans: Record<string, Plan>;
}

export interface CreateCheckoutLinkOptions {
	type: "subscription" | "one-time";
	priceId: string;
	currency: string;
	/** Exact server-owned amount for one-time checkout, in millionths of a currency unit. */
	amountMicros?: bigint;
	/** Server-owned checkout line description. */
	description?: string;
	billingPlanId: string;
	checkoutIntentId: string;
	idempotencyKey: string;
	planKey: string;
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
	submittedByUserId: string;
	/** Compatibility owner fields consumed by non-Stripe providers. */
	organizationId?: string;
	userId?: string;
	email?: string;
	name?: string;
	redirectUrl?: string;
	cancelUrl?: string;
	/** Persisted per attempt; omitted historical attempts keep provider activation. */
	subscriptionActivationMode?: "AUTOMATIC" | "MERCHANT";
	customerId?: string;
	trialPeriodDays?: number;
	seats?: number;
}

export type CreateCheckoutLink = (params: CreateCheckoutLinkOptions) => Promise<string | null>;

export interface CreatedCheckout {
	checkoutUrl: string;
	providerSessionId: string;
	expiresAt: Date | null;
}

export interface RecoverCheckoutOptions extends CreateCheckoutLinkOptions {
	/** Local time immediately before the uncertain provider create was attempted. */
	providerCreatingAt: Date;
	/** Server-owned recovery decision time, supplied explicitly for deterministic policy checks. */
	now: Date;
}

export type CheckoutRecoveryResult =
	| { status: "FOUND"; checkout: CreatedCheckout; providerOrderId?: string }
	| { status: "FOUND_UNRESUMABLE"; providerOrderId: string }
	| { status: "NOT_FOUND" }
	| { status: "UNKNOWN" };

export interface CapturedCheckoutEvent {
	providerEventId: string;
	normalizedTransactionId: string;
	envelope: Record<string, unknown>;
}

export interface CaptureCheckoutOptions {
	providerOrderId: string;
	idempotencyKey: string;
}

export type CreateProviderCheckout = (
	params: CreateCheckoutLinkOptions,
) => Promise<CreatedCheckout>;

export type RecoverProviderCheckout = (
	params: RecoverCheckoutOptions,
) => Promise<CheckoutRecoveryResult>;

export type CreateCustomerPortalLink = (params: {
	subscriptionId?: string;
	customerId: string;
	redirectUrl?: string;
}) => Promise<string | null>;

export type SetSubscriptionSeats = (params: { id: string; seats: number }) => Promise<void>;

export type CancelSubscription = (id: string) => Promise<void>;

export interface InspectSubscriptionCancellationInput {
	subscriptionId: string;
	checkoutIntentId: string;
	priceId: string;
}

export type SubscriptionCancellationState = "RENEWING" | "PENDING" | "DISABLED" | "UNKNOWN";

export type WebhookHandler = (req: Request) => Promise<Response>;

export interface SubscriptionCheckoutRecoveryInput {
	checkoutIntentId: string;
	providerSessionId: string;
	providerOrderId?: string | null;
	priceId: string;
	expiresAt: Date | null;
	now: Date;
	cancelRequested: boolean;
	sessionExpiryVerified: boolean;
}

export interface SubscriptionCheckoutInspection {
	status: "PENDING" | "APPROVED" | "PAID" | "CLOSED" | "WAITING" | "UNKNOWN";
	reason?: string;
	waitUntil?: Date;
	providerOrderId?: string;
}

export type PaymentProvider = {
	name: PaymentProviderName;
	capabilities: PaymentProviderCapabilities;
	createCheckout: CreateProviderCheckout;
	recoverCheckout?: RecoverProviderCheckout;
	recoverSubscriptionCheckout?: (
		input: SubscriptionCheckoutRecoveryInput,
	) => Promise<SubscriptionCheckoutInspection>;
	activateSubscriptionCheckout?: (input: SubscriptionCheckoutRecoveryInput) => Promise<void>;
	resumeSubscriptionCheckout?: (input: {
		checkoutUrl: string;
		priceId: string;
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
	}) => Promise<string>;
	listPaymentEvents?: (
		window: import("./provider/event-source").ProviderEventWindow,
	) => Promise<import("./provider/event-source").ProviderEventPage>;
	inspectCheckout?: (input: {
		checkoutIntentId: string;
		providerSessionId: string;
		priceId: string;
		expiresAt: Date | null;
		now: Date;
	}) => Promise<"PENDING" | "PAID" | "CLOSED" | "UNKNOWN">;
	captureCheckout?: (params: CaptureCheckoutOptions) => Promise<CapturedCheckoutEvent>;
	createPortal?: CreateCustomerPortalLink;
	cancelSubscription?: CancelSubscription;
	inspectSubscriptionCancellation?: (
		input: InspectSubscriptionCancellationInput,
	) => Promise<SubscriptionCancellationState>;
	setSubscriptionSeats?: SetSubscriptionSeats;
};
