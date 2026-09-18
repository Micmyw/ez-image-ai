import {
	claimCheckoutRecovery,
	claimCheckoutActivation,
	finishCheckoutRecovery,
	readCheckoutRecovery,
	type CheckoutRecovery,
	type RecoverableCheckout,
} from "@repo/database";

import type {
	PaymentProvider,
	SubscriptionCheckoutRecoveryInput,
	SubscriptionCheckoutInspection,
} from "../types";
import { paymentReconciliationScope } from "./event-reconciliation";

export function newSubscriptionCheckoutRecovery(
	provider: "paypal" | "waffo",
	environment: Record<string, string | undefined> = process.env,
): CheckoutRecovery {
	return {
		version: 1,
		mode: provider === "paypal" ? "MERCHANT" : "AUTOMATIC",
		environment: environment[provider === "paypal" ? "PAYPAL_ENVIRONMENT" : "WAFFO_ENVIRONMENT"],
		scope: paymentReconciliationScope(provider, environment),
		sequence: 0,
		status: "PENDING",
		failures: 0,
		checks: 0,
	};
}

export function assertCheckoutRecoveryScope(
	intent: RecoverableCheckout,
	environment: Record<string, string | undefined>,
) {
	const state = readCheckoutRecovery(intent.checkoutRecovery);
	if (intent.provider !== "paypal" && intent.provider !== "waffo")
		throw new Error("CHECKOUT_PROVIDER_UNAVAILABLE");
	if (
		state.mode !== "LEGACY" &&
		(state.environment !==
			environment[intent.provider === "paypal" ? "PAYPAL_ENVIRONMENT" : "WAFFO_ENVIRONMENT"] ||
			state.scope !== paymentReconciliationScope(intent.provider, environment))
	)
		throw new Error("CHECKOUT_PROVIDER_SCOPE_MISMATCH");
}

/** Durable job: browser callbacks only wake inspection; they never prove approval or payment. */
export async function recoverSubscriptionCheckout(
	input: { checkoutIntentId: string; sequence: number },
	client: Parameters<typeof claimCheckoutRecovery>[1],
	dependencies: {
		getProvider(name: string): PaymentProvider | null;
		environment: Record<string, string | undefined>;
		now?: () => Date;
	},
) {
	const now = () => dependencies.now?.() ?? new Date();
	const claimed = await claimCheckoutRecovery(
		{ id: input.checkoutIntentId, sequence: input.sequence, now: now() },
		client,
	);
	if (!claimed) return;
	const { intent, leaseToken } = claimed;
	let result: SubscriptionCheckoutInspection | { status: "ACTIVATING"; reason: string } = {
		status: "UNKNOWN",
		reason: "PROVIDER_UNAVAILABLE",
	};
	try {
		assertCheckoutRecoveryScope(intent, dependencies.environment);
		const state = readCheckoutRecovery(intent.checkoutRecovery);
		const provider = dependencies.getProvider(intent.provider);
		if (!intent.providerSessionId || !provider?.recoverSubscriptionCheckout)
			throw new Error("CHECKOUT_SESSION_UNCONFIRMED");
		const inspection: SubscriptionCheckoutRecoveryInput = {
			checkoutIntentId: intent.id,
			providerSessionId: intent.providerSessionId,
			providerOrderId: intent.providerOrderId,
			priceId: intent.billingPlan.providerPriceId,
			expiresAt: intent.expiresAt,
			now: now(),
			cancelRequested: Boolean(state.cancelRequestedAt),
			sessionExpiryVerified: state.mode !== "LEGACY",
		};
		result = await provider.recoverSubscriptionCheckout(inspection);
		if (
			result.providerOrderId &&
			intent.providerOrderId &&
			result.providerOrderId !== intent.providerOrderId
		)
			throw new Error("CHECKOUT_PROVIDER_BINDING_MISMATCH");
		if (
			result.status === "APPROVED" &&
			state.mode === "MERCHANT" &&
			provider.activateSubscriptionCheckout
		) {
			if (await claimCheckoutActivation({ id: intent.id, leaseToken, now: now() }, client)) {
				// Claim is persisted first. A timeout cannot restore local abandon permission.
				try {
					await provider.activateSubscriptionCheckout(inspection);
				} catch {
					/* Inspect the same resource before retrying. */
				}
				result = await provider.recoverSubscriptionCheckout({ ...inspection, now: now() });
				if (result.status === "APPROVED" || result.status === "PENDING")
					result = { status: "ACTIVATING", reason: "ACTIVATION_UNCONFIRMED" };
			}
		}
		if (
			state.cancelRequestedAt &&
			state.mode !== "MERCHANT" &&
			["PENDING", "APPROVED"].includes(result.status) &&
			intent.provider === "paypal"
		)
			result = { status: "UNKNOWN", reason: "LEGACY_APPROVAL_CANNOT_BE_REVOKED" };
	} catch {
		result = { status: "UNKNOWN", reason: "PROVIDER_UNCONFIRMED" };
	}
	await finishCheckoutRecovery({ id: intent.id, leaseToken, ...result, now: now() }, client);
}
