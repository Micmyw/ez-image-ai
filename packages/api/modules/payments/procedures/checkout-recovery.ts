import {
	bindPaymentCheckoutIntentOrder,
	bindPaymentCheckoutIntentSession,
	getPaymentCheckoutIntentForOwner,
	resetPaymentCheckoutIntentProviderCreating,
	transitionPaymentCheckoutIntentToReview,
} from "@repo/database";
import type {
	CheckoutRecoveryResult,
	CreateCheckoutLinkOptions,
	CreatedCheckout,
	PaymentProvider,
} from "@repo/payments/types";

type CheckoutOwner = { ownerType: "USER" | "ORGANIZATION"; ownerId: string };
type CheckoutProductKind = "PLAN" | "CREDIT_PACK";
type DatabaseClient = Parameters<typeof bindPaymentCheckoutIntentSession>[1];

interface ProviderCreatingIntent {
	id: string;
	provider: string;
	productKind: CheckoutProductKind;
	status: string;
	updatedAt: Date;
}

type RecoveryOutcome =
	| { kind: "RECOVERED"; checkout: CreatedCheckout }
	| { kind: "RETRY" }
	| { kind: "REVIEW" };

export async function recoverProviderCreatingCheckout(
	input: {
		provider: PaymentProvider;
		owner: CheckoutOwner;
		intent: ProviderCreatingIntent;
		checkoutOptions: CreateCheckoutLinkOptions;
		now: Date;
	},
	client: DatabaseClient,
): Promise<RecoveryOutcome> {
	if (
		input.intent.provider !== input.provider.name ||
		input.intent.status !== "PROVIDER_CREATING"
	) {
		return moveProviderCreatingToReview(input, client);
	}

	let recovery: CheckoutRecoveryResult = { status: "UNKNOWN" };
	if (input.provider.recoverCheckout) {
		try {
			recovery = await input.provider.recoverCheckout({
				...input.checkoutOptions,
				providerCreatingAt: input.intent.updatedAt,
				now: input.now,
			});
		} catch {
			recovery = { status: "UNKNOWN" };
		}
	}

	if (recovery.status === "FOUND") {
		try {
			await bindPaymentCheckoutIntentSession(
				{
					intentId: input.intent.id,
					provider: input.provider.name,
					providerSessionId: recovery.checkout.providerSessionId,
					...(recovery.providerOrderId ? { providerOrderId: recovery.providerOrderId } : {}),
					providerCheckoutUrl: recovery.checkout.checkoutUrl,
					expiresAt: recovery.checkout.expiresAt,
				},
				client,
			);
			return { kind: "RECOVERED", checkout: recovery.checkout };
		} catch (error) {
			if (!hasErrorCode(error, "PAYMENT_CHECKOUT_INTENT_BINDING_CONFLICT")) throw error;
			return resolveRecoveredBindingConflict(input, recovery.checkout, client);
		}
	}

	if (recovery.status === "NOT_FOUND") {
		const reset = await resetPaymentCheckoutIntentProviderCreating(
			{
				intentId: input.intent.id,
				provider: input.provider.name,
				expectedProductKind: input.intent.productKind,
				...input.owner,
			},
			client,
		);
		if (reset.count === 1) return { kind: "RETRY" };
		return (await loadConcurrentRecovery(input, client)) ?? { kind: "REVIEW" };
	}

	if (recovery.status === "FOUND_UNRESUMABLE") {
		await bindPaymentCheckoutIntentOrder(
			{
				intentId: input.intent.id,
				provider: input.provider.name,
				providerOrderId: recovery.providerOrderId,
			},
			client,
		);
		return moveProviderCreatingToReview(input, client, recovery.providerOrderId);
	}

	return moveProviderCreatingToReview(input, client);
}

async function resolveRecoveredBindingConflict(
	input: {
		provider: PaymentProvider;
		owner: CheckoutOwner;
		intent: ProviderCreatingIntent;
	},
	recoveredCheckout: CreatedCheckout,
	client: DatabaseClient,
): Promise<RecoveryOutcome> {
	const current = await getPaymentCheckoutIntentForOwner(
		{ intentId: input.intent.id, ...input.owner },
		client,
	);
	if (
		current?.provider === input.provider.name &&
		current.productKind === input.intent.productKind &&
		current.status === "PROVIDER_PENDING" &&
		current.providerSessionId &&
		current.providerCheckoutUrl
	) {
		if (
			current.providerSessionId === recoveredCheckout.providerSessionId &&
			current.providerCheckoutUrl === recoveredCheckout.checkoutUrl
		) {
			return {
				kind: "RECOVERED",
				checkout: {
					providerSessionId: current.providerSessionId,
					checkoutUrl: current.providerCheckoutUrl,
					expiresAt: current.expiresAt,
				},
			};
		}
		await transitionPaymentCheckoutIntentToReview(
			{
				intentId: input.intent.id,
				provider: input.provider.name,
				expectedStatus: "PROVIDER_PENDING",
				expectedProductKind: input.intent.productKind,
				expectedProviderSessionId: current.providerSessionId,
				...(current.providerOrderId ? { expectedProviderOrderId: current.providerOrderId } : {}),
				...input.owner,
			},
			client,
		);
		return { kind: "REVIEW" };
	}
	return moveProviderCreatingToReview(input, client);
}

async function moveProviderCreatingToReview(
	input: {
		provider: PaymentProvider;
		owner: CheckoutOwner;
		intent: ProviderCreatingIntent;
	},
	client: DatabaseClient,
	expectedProviderOrderId?: string,
): Promise<RecoveryOutcome> {
	const transition = await transitionPaymentCheckoutIntentToReview(
		{
			intentId: input.intent.id,
			provider: input.provider.name,
			expectedStatus: "PROVIDER_CREATING",
			expectedProductKind: input.intent.productKind,
			...(expectedProviderOrderId ? { expectedProviderOrderId } : {}),
			...input.owner,
		},
		client,
	);
	if (transition.count === 1) return { kind: "REVIEW" };
	return (await loadConcurrentRecovery(input, client)) ?? { kind: "REVIEW" };
}

async function loadConcurrentRecovery(
	input: { provider: PaymentProvider; owner: CheckoutOwner; intent: ProviderCreatingIntent },
	client: DatabaseClient,
): Promise<RecoveryOutcome | null> {
	const current = await getPaymentCheckoutIntentForOwner(
		{ intentId: input.intent.id, ...input.owner },
		client,
	);
	if (
		current?.provider === input.provider.name &&
		current.productKind === input.intent.productKind &&
		current.status === "PROVIDER_PENDING" &&
		current.providerSessionId &&
		current.providerCheckoutUrl
	) {
		return {
			kind: "RECOVERED",
			checkout: {
				providerSessionId: current.providerSessionId,
				checkoutUrl: current.providerCheckoutUrl,
				expiresAt: current.expiresAt,
			},
		};
	}
	return null;
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && error.message === code;
}
