import {
	ANNUAL_OPERATION,
	ANNUAL_TIERS,
	AnnualOperationError,
	auditAnnualProviders,
	safeFailure,
	targetName,
	validPaypalTerms,
	validWaffoTerms,
	waffoEvidence,
	paypalEvidence,
	type AnnualTier,
	type ProviderPort,
	type WaffoEvidence,
	type PayPalEvidence,
} from "./annual-provider-core";

export type AttemptKey = `${"waffo" | "paypal"}:${AnnualTier["key"]}`;
export type OperationReceipt = {
	operation: typeof ANNUAL_OPERATION;
	provider: "waffo" | "paypal";
	plan: AnnualTier["key"];
	action: "CREATE" | "PUBLISH" | "ACTIVATE";
	phase: "ATTEMPT_STARTED" | "VERIFIED" | "RECOVERED" | "UNCERTAIN";
	requestKey: string;
	productId?: string;
	failure?: ReturnType<typeof safeFailure>;
};
export interface PreparationPort extends ProviderPort {
	waffoAuthorizeTarget(id: string, tier: AnnualTier): Promise<void>;
}
export function parsePriorAttempts(value: string | undefined): Set<AttemptKey> {
	const keys = value ? value.split(",") : [];
	const allowed = new Set(
		ANNUAL_TIERS.flatMap((tier) => [`waffo:${tier.key}`, `paypal:${tier.key}`]),
	);
	if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length)
		throw new AnnualOperationError("PRIOR_ATTEMPTS_INVALID");
	return new Set(keys as AttemptKey[]);
}
function identityName(value: string): string {
	return value
		.toLowerCase()
		.replaceAll(ANNUAL_OPERATION, "")
		.replace(/\b(?:annual|annually|yearly|monthly|year|month|usd|plan|subscription)\b/g, "")
		.replace(/\d+(?:\.\d+)?/g, "")
		.replace(/[^a-z]+/g, " ")
		.trim();
}
function ownedTarget(product: WaffoEvidence, tier: AnnualTier): boolean {
	const versions = [product.production, product.test].filter((version) => version !== null);
	return (
		versions.length > 0 &&
		versions.every(
			(version) =>
				version.name === targetName(tier) &&
				version.operation === ANNUAL_OPERATION &&
				version.previousProductId === tier.waffo &&
				validWaffoTerms(version, tier.annual, "yearly"),
		)
	);
}
function candidateIdentity(
	product: WaffoEvidence,
	previous: WaffoEvidence,
	tier: AnnualTier,
): boolean {
	if (product.production) {
		return (
			validWaffoTerms(product.production, tier.annual, "yearly") &&
			(product.production.previousProductId === tier.waffo ||
				identityName(product.production.name) ===
					identityName(previous.production?.name ?? previous.name))
		);
	}
	return ownedTarget(product, tier);
}

function samePayPalPaymentPreferences(
	candidate: PayPalEvidence,
	previous: PayPalEvidence,
): boolean {
	return (
		candidate.paymentPreferences.setupFeeMinor === previous.paymentPreferences.setupFeeMinor &&
		candidate.paymentPreferences.autoBillOutstanding ===
			previous.paymentPreferences.autoBillOutstanding &&
		candidate.paymentPreferences.setupFeeFailureAction ===
			previous.paymentPreferences.setupFeeFailureAction &&
		candidate.paymentPreferences.paymentFailureThreshold ===
			previous.paymentPreferences.paymentFailureThreshold &&
		candidate.taxPercent === previous.taxPercent
	);
}
/** Caller must carry ATTEMPT_STARTED keys from durable build logs on any resumed run. */
export async function prepareAnnualProviders(
	environment: Record<string, string | undefined>,
	port: PreparationPort,
	options: {
		priorAttempts?: Set<AttemptKey>;
		onReceipt?: (receipt: OperationReceipt) => void;
	} = {},
) {
	const initial = await auditAnnualProviders(environment, port);
	if (!initial.ready) throw new AnnualOperationError("AUDIT_NOT_READY");
	// This price-only operation preserves the independently audited payment preferences.
	for (const tier of initial.tiers) {
		const preferences = tier.paypal.previousAnnual.paymentPreferences;
		if (
			!preferences.autoBillOutstanding ||
			preferences.setupFeeMinor !== 0 ||
			preferences.setupFeeFailureAction !== "CANCEL" ||
			preferences.paymentFailureThreshold !== 2 ||
			tier.paypal.previousAnnual.taxPercent !== null
		)
			throw new AnnualOperationError("PAYPAL_PREVIOUS_PREFERENCES_CHANGED");
	}
	if (!port.waffoCreate || !port.waffoPublish || !port.waffoActivate || !port.paypalCreate)
		throw new AnnualOperationError("PREPARATION_NOT_AVAILABLE");
	const attempts = new Set(options.priorAttempts ?? []);
	const receipts: OperationReceipt[] = [];
	const emit = (receipt: Omit<OperationReceipt, "operation">) => {
		const complete: OperationReceipt = { operation: ANNUAL_OPERATION, ...receipt };
		receipts.push(complete);
		options.onReceipt?.(complete);
	};
	const bindings: { plan: AnnualTier["key"]; waffoProductId: string; paypalPlanId: string }[] = [];
	for (const tier of ANNUAL_TIERS) {
		const baseline = initial.tiers.find((entry) => entry.plan === tier.key)!;
		const readWaffo = async () => {
			const catalog = await port.waffoCatalog();
			if (catalog.store.id !== initial.store.id || catalog.store.status !== "active")
				throw new AnnualOperationError("WAFFO_STORE_CHANGED");
			return catalog.products.map(waffoEvidence);
		};
		const chooseWaffo = (products: WaffoEvidence[]): WaffoEvidence | undefined => {
			const candidates = products.filter(
				(product) =>
					product.id !== tier.waffo &&
					[product.production, product.test].some((version) =>
						validWaffoTerms(version, tier.annual, "yearly"),
					),
			);
			if (
				candidates.some(
					(candidate) => !candidateIdentity(candidate, baseline.waffo.previousAnnual, tier),
				)
			)
				throw new AnnualOperationError("WAFFO_TARGET_IDENTITY_REQUIRES_REVIEW");
			if (candidates.length > 1) throw new AnnualOperationError("WAFFO_TARGET_AMBIGUOUS");
			return candidates[0];
		};
		let waffoTarget = chooseWaffo(await readWaffo());
		const waffoKey: AttemptKey = `waffo:${tier.key}`;
		if (!waffoTarget) {
			if (attempts.has(waffoKey)) throw new AnnualOperationError("WAFFO_PRIOR_CREATE_UNRESOLVED");
			attempts.add(waffoKey);
			emit({
				provider: "waffo",
				plan: tier.key,
				action: "CREATE",
				phase: "ATTEMPT_STARTED",
				requestKey: `${ANNUAL_OPERATION}-${waffoKey}`,
			});
			let createId: string | undefined;
			let createFailure: unknown;
			try {
				createId = await port.waffoCreate(tier, tier.waffo);
			} catch (error) {
				createFailure = error;
			}
			// A timeout never justifies another create. Query the deterministic target once.
			try {
				waffoTarget = chooseWaffo(await readWaffo());
			} catch (error) {
				emit({
					provider: "waffo",
					plan: tier.key,
					action: "CREATE",
					phase: "UNCERTAIN",
					requestKey: `${ANNUAL_OPERATION}-${waffoKey}`,
					...(createId ? { productId: createId } : {}),
					failure: safeFailure(error),
				});
				throw new AnnualOperationError("WAFFO_CREATE_UNCERTAIN");
			}
			if (
				!waffoTarget ||
				(createId && waffoTarget.id !== createId) ||
				!ownedTarget(waffoTarget, tier)
			) {
				emit({
					provider: "waffo",
					plan: tier.key,
					action: "CREATE",
					phase: "UNCERTAIN",
					requestKey: `${ANNUAL_OPERATION}-${waffoKey}`,
					...(createId ? { productId: createId } : {}),
					...(createFailure ? { failure: safeFailure(createFailure) } : {}),
				});
				throw new AnnualOperationError("WAFFO_CREATE_UNCERTAIN");
			}
			emit({
				provider: "waffo",
				plan: tier.key,
				action: "CREATE",
				phase: createFailure ? "RECOVERED" : "VERIFIED",
				requestKey: `${ANNUAL_OPERATION}-${waffoKey}`,
				productId: waffoTarget.id,
			});
		}
		if (
			!validWaffoTerms(waffoTarget.production, tier.annual, "yearly") ||
			waffoTarget.status !== "active"
		) {
			if (!ownedTarget(waffoTarget, tier))
				throw new AnnualOperationError("WAFFO_EXISTING_DRAFT_REQUIRES_REVIEW");
			await port.waffoAuthorizeTarget(waffoTarget.id, tier);
			for (const action of ["PUBLISH", "ACTIVATE"] as const) {
				if (!waffoTarget) throw new AnnualOperationError("WAFFO_TARGET_NOT_READY");
				if (action === "PUBLISH" && validWaffoTerms(waffoTarget.production, tier.annual, "yearly"))
					continue;
				if (action === "ACTIVATE" && waffoTarget.status === "active") continue;
				const requestKey = `${ANNUAL_OPERATION}-${waffoKey}-${action.toLowerCase()}`;
				emit({
					provider: "waffo",
					plan: tier.key,
					action,
					phase: "ATTEMPT_STARTED",
					requestKey,
					productId: waffoTarget.id,
				});
				let writeFailure: unknown;
				try {
					if (action === "PUBLISH") await port.waffoPublish(waffoTarget.id);
					else await port.waffoActivate(waffoTarget.id);
				} catch (error) {
					writeFailure = error;
				}
				const previousId = waffoTarget.id;
				try {
					waffoTarget = chooseWaffo(await readWaffo());
				} catch {
					waffoTarget = undefined;
				}
				const verified =
					!!waffoTarget &&
					waffoTarget.id === previousId &&
					validWaffoTerms(waffoTarget.production, tier.annual, "yearly") &&
					(action !== "ACTIVATE" || waffoTarget.status === "active");
				if (!verified) {
					emit({
						provider: "waffo",
						plan: tier.key,
						action,
						phase: "UNCERTAIN",
						requestKey,
						productId: previousId,
						...(writeFailure ? { failure: safeFailure(writeFailure) } : {}),
					});
					throw new AnnualOperationError(`WAFFO_${action}_UNCERTAIN`);
				}
				emit({
					provider: "waffo",
					plan: tier.key,
					action,
					phase: writeFailure ? "RECOVERED" : "VERIFIED",
					requestKey,
					productId: previousId,
				});
			}
		}
		if (
			!waffoTarget ||
			!validWaffoTerms(waffoTarget.production, tier.annual, "yearly") ||
			waffoTarget.status !== "active"
		)
			throw new AnnualOperationError("WAFFO_TARGET_NOT_READY");
		const readPayPal = async () =>
			(await port.paypalPlans(baseline.paypal.previousAnnual.productId)).map(paypalEvidence);
		const choosePayPal = (
			plans: ReturnType<typeof paypalEvidence>[],
		): ReturnType<typeof paypalEvidence> | undefined => {
			if (
				plans.some(
					(plan) =>
						plan.name === targetName(tier) &&
						!samePayPalPaymentPreferences(plan, baseline.paypal.previousAnnual),
				)
			)
				throw new AnnualOperationError("PAYPAL_TARGET_PREFERENCES_MISMATCH");
			const candidates = plans.filter(
				(plan) =>
					plan.productId === baseline.paypal.previousAnnual.productId &&
					validPaypalTerms(plan, tier.annual, "YEAR") &&
					samePayPalPaymentPreferences(plan, baseline.paypal.previousAnnual),
			);
			if (candidates.length > 1) throw new AnnualOperationError("PAYPAL_TARGET_AMBIGUOUS");
			return candidates[0];
		};
		let paypalTarget = choosePayPal(await readPayPal());
		const paypalKey: AttemptKey = `paypal:${tier.key}`;
		if (!paypalTarget) {
			if (attempts.has(paypalKey)) throw new AnnualOperationError("PAYPAL_PRIOR_CREATE_UNRESOLVED");
			attempts.add(paypalKey);
			emit({
				provider: "paypal",
				plan: tier.key,
				action: "CREATE",
				phase: "ATTEMPT_STARTED",
				requestKey: `ezpic-${ANNUAL_OPERATION}-${tier.key}`,
			});
			let createId: string | undefined;
			let createFailure: unknown;
			try {
				createId = await port.paypalCreate(tier, baseline.paypal.previousAnnual.productId);
			} catch (error) {
				createFailure = error;
			}
			try {
				paypalTarget = choosePayPal(await readPayPal());
			} catch {
				paypalTarget = undefined;
			}
			if (!paypalTarget || (createId && paypalTarget.id !== createId)) {
				emit({
					provider: "paypal",
					plan: tier.key,
					action: "CREATE",
					phase: "UNCERTAIN",
					requestKey: `ezpic-${ANNUAL_OPERATION}-${tier.key}`,
					...(createId ? { productId: createId } : {}),
					...(createFailure ? { failure: safeFailure(createFailure) } : {}),
				});
				throw new AnnualOperationError("PAYPAL_CREATE_UNCERTAIN");
			}
			emit({
				provider: "paypal",
				plan: tier.key,
				action: "CREATE",
				phase: createFailure ? "RECOVERED" : "VERIFIED",
				requestKey: `ezpic-${ANNUAL_OPERATION}-${tier.key}`,
				productId: paypalTarget.id,
			});
		}
		bindings.push({
			plan: tier.key,
			waffoProductId: waffoTarget.id,
			paypalPlanId: paypalTarget.id,
		});
	}
	const final = await auditAnnualProviders(environment, port);
	if (!final.ready) throw new AnnualOperationError("POST_PREPARATION_AUDIT_NOT_READY");
	for (const binding of bindings) {
		const tier = ANNUAL_TIERS.find((entry) => entry.key === binding.plan)!;
		const verified = final.tiers.find((entry) => entry.plan === binding.plan)!;
		const waffo = verified.waffo.candidates.find((entry) => entry.id === binding.waffoProductId);
		const paypal = verified.paypal.candidates.find((entry) => entry.id === binding.paypalPlanId);
		if (
			!waffo ||
			waffo.status !== "active" ||
			!waffo.hasProdVersion ||
			!validWaffoTerms(waffo.production, tier.annual, "yearly") ||
			!candidateIdentity(waffo, verified.waffo.previousAnnual, tier) ||
			!paypal ||
			paypal.productId !== verified.paypal.previousAnnual.productId ||
			!validPaypalTerms(paypal, tier.annual, "YEAR") ||
			!samePayPalPaymentPreferences(paypal, verified.paypal.previousAnnual)
		)
			throw new AnnualOperationError("PREPARED_BINDING_VERIFICATION_FAILED");
	}
	return {
		operation: ANNUAL_OPERATION,
		mode: "prepare" as const,
		ready: true,
		bindings,
		receipts,
		audit: final,
		attempted: [...attempts],
	};
}
