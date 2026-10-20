/** One-shot annual price operation. Provider payloads stay internal; only evidence below is printable. */
export const ANNUAL_OPERATION = "20261020annual50";
export const ANNUAL_TIERS = [
	{
		key: "creator",
		label: "Pro",
		annual: 11400,
		previous: 19000,
		monthly: 1900,
		credits: 700,
		waffo: "PROD_18xMZ5yE5kDMnq0f7wOqli",
		paypal: "P-0JY66815392504113NKUVV6I",
	},
	{
		key: "ultimate",
		label: "Ultimate",
		annual: 29400,
		previous: 49000,
		monthly: 4900,
		credits: 1800,
		waffo: "PROD_65mfk1RFvPmUbkHidbevT2",
		paypal: "P-18H57073FF461215NNKUVV7I",
	},
	{
		key: "studio",
		label: "Max",
		annual: 47400,
		previous: 79000,
		monthly: 7900,
		credits: 3000,
		waffo: "PROD_5zhQ0wBekscylIC9hCOioe",
		paypal: "P-4SA63981KS3778335NKUVWAA",
	},
] as const;
export type AnnualTier = (typeof ANNUAL_TIERS)[number];
export type Data = Record<string, unknown>;
export function record(value: unknown): Data {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new AnnualOperationError("RESPONSE_SHAPE_INVALID");
	return value as Data;
}
export function list(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new AnnualOperationError("RESPONSE_SHAPE_INVALID");
	return value;
}
export function string(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 250 ||
		value.split("").some((character) => character.charCodeAt(0) < 32)
	)
		throw new AnnualOperationError("RESPONSE_SHAPE_INVALID");
	return value;
}
export function amount(value: unknown): number {
	if (typeof value !== "string" || !/^\d{1,8}(\.\d{1,2})?$/.test(value))
		throw new AnnualOperationError("PRICE_INVALID");
	const [whole, fraction = ""] = value.split(".");
	return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
export function targetName(tier: AnnualTier): string {
	return `EzPic ${tier.label} annual USD${tier.annual / 100} ${ANNUAL_OPERATION}`;
}
export class AnnualOperationError extends Error {
	readonly code: string;
	readonly status?: number;
	readonly requestId?: string;
	constructor(code: string, status?: number, requestId?: string) {
		super(code);
		this.code = code;
		this.status = status;
		this.requestId = requestId && /^[A-Za-z0-9_-]{1,100}$/.test(requestId) ? requestId : undefined;
	}
}
export function safeFailure(error: unknown) {
	return error instanceof AnnualOperationError
		? {
				code: error.code,
				...(error.status !== undefined ? { status: error.status } : {}),
				...(error.requestId ? { requestId: error.requestId } : {}),
			}
		: { code: "PROVIDER_OPERATION_FAILED" };
}
export interface WaffoCatalog {
	store: Data;
	products: Data[];
	schemaFields: Record<string, string[]>;
}
export interface ProviderPort {
	waffoCatalog(): Promise<WaffoCatalog>;
	paypalPlan(id: string): Promise<Data>;
	paypalPlans(productId: string): Promise<Data[]>;
	waffoCreate?(tier: AnnualTier, previousId: string): Promise<string>;
	waffoPublish?(id: string): Promise<void>;
	waffoActivate?(id: string): Promise<void>;
	paypalCreate?(tier: AnnualTier, productId: string): Promise<string>;
}
export type PriceEvidence = {
	currency: string;
	amountMinor: number;
	taxCategory?: string;
	trialAmountMinor: number | null;
};
export type WaffoVersionEvidence = {
	versionNumber: number;
	name: string;
	billingPeriod: string;
	prices: PriceEvidence[];
	isProdVersion: boolean;
	isTestVersion: boolean;
	trialDays: number;
	setupFeeMinor: number;
	finiteCycles: number;
	operation?: string;
	previousProductId?: string;
};
export type WaffoEvidence = {
	id: string;
	name: string;
	status: string;
	hasProdVersion: boolean;
	production: WaffoVersionEvidence | null;
	test: WaffoVersionEvidence | null;
};
export function waffoEvidence(raw: Data): WaffoEvidence {
	const versions = list(raw.versions).map((input) => {
		const version = record(input);
		const metadata = version.metadata == null ? {} : record(version.metadata);
		const prices = list(version.prices).map((entry) => {
			const price = record(entry);
			const info = record(price.priceInfo);
			return {
				currency: string(price.currency),
				amountMinor: amount(info.amount),
				taxCategory: typeof info.taxCategory === "string" ? info.taxCategory : undefined,
				trialAmountMinor: info.trialAmount == null ? null : amount(info.trialAmount),
			};
		});
		const numeric = (key: string): number => {
			const value = metadata[key];
			if (value === undefined || value === null || value === "") return 0;
			if (!Number.isSafeInteger(Number(value)) || Number(value) < 0)
				throw new AnnualOperationError("WAFFO_TERMS_UNKNOWN");
			return Number(value);
		};
		if (
			typeof version.isProdVersion !== "boolean" ||
			typeof version.isTestVersion !== "boolean" ||
			!Number.isSafeInteger(version.versionNumber)
		)
			throw new AnnualOperationError("WAFFO_VERSION_UNKNOWN");
		return {
			versionNumber: Number(version.versionNumber),
			name: string(version.name),
			billingPeriod: string(version.billingPeriod),
			prices,
			isProdVersion: version.isProdVersion,
			isTestVersion: version.isTestVersion,
			trialDays: numeric("trialDays"),
			setupFeeMinor: numeric("setupFeeMinor") + numeric("setupFee") * 100,
			finiteCycles: numeric("totalCycles") + numeric("cycles") + numeric("billingCycles"),
			...(metadata.operation === ANNUAL_OPERATION ? { operation: ANNUAL_OPERATION } : {}),
			...(typeof metadata.previousProductId === "string" &&
			/^PROD_[0-9A-Za-z]{22}$/.test(metadata.previousProductId)
				? { previousProductId: metadata.previousProductId }
				: {}),
		};
	});
	const prod = versions.filter((version) => version.isProdVersion);
	const test = versions.filter((version) => version.isTestVersion);
	if (prod.length > 1 || test.length > 1) throw new AnnualOperationError("WAFFO_VERSION_AMBIGUOUS");
	return {
		id: string(raw.id),
		name: string(raw.name),
		status: string(raw.status),
		hasProdVersion: raw.hasProdVersion === true,
		production: prod[0] ?? null,
		test: test[0] ?? null,
	};
}
export type PayPalEvidence = {
	id: string;
	productId: string;
	name: string;
	status: string;
	billingCycles: {
		tenureType: string;
		intervalUnit: string;
		intervalCount: number;
		totalCycles: number;
		sequence: number;
		currency: string;
		amountMinor: number;
	}[];
	paymentPreferences: {
		setupFeeMinor: number;
		setupFeeCurrency: string | null;
		autoBillOutstanding: boolean;
		setupFeeFailureAction: string | null;
		paymentFailureThreshold: number | null;
	};
	taxPercent: string | null;
};
export function paypalEvidence(raw: Data): PayPalEvidence {
	const preferences = record(raw.payment_preferences);
	const setupFee = preferences.setup_fee == null ? null : record(preferences.setup_fee);
	const cycles = list(raw.billing_cycles).map((input) => {
		const cycle = record(input);
		const frequency = record(cycle.frequency);
		const fixedPrice =
			cycle.tenure_type === "TRIAL" && cycle.pricing_scheme == null
				? null
				: record(record(cycle.pricing_scheme).fixed_price);
		if (![frequency.interval_count, cycle.total_cycles, cycle.sequence].every(Number.isSafeInteger))
			throw new AnnualOperationError("PAYPAL_TERMS_UNKNOWN");
		return {
			tenureType: string(cycle.tenure_type),
			intervalUnit: string(frequency.interval_unit),
			intervalCount: Number(frequency.interval_count),
			totalCycles: Number(cycle.total_cycles),
			sequence: Number(cycle.sequence),
			currency: fixedPrice ? string(fixedPrice.currency_code) : "UNSPECIFIED",
			amountMinor: fixedPrice ? amount(fixedPrice.value) : 0,
		};
	});
	const taxes = raw.taxes == null ? null : record(raw.taxes);
	return {
		id: string(raw.id),
		productId: string(raw.product_id),
		name: string(raw.name),
		status: string(raw.status),
		billingCycles: cycles,
		paymentPreferences: {
			setupFeeMinor: setupFee ? amount(setupFee.value) : 0,
			setupFeeCurrency: setupFee ? string(setupFee.currency_code) : null,
			autoBillOutstanding: preferences.auto_bill_outstanding === true,
			setupFeeFailureAction:
				typeof preferences.setup_fee_failure_action === "string"
					? preferences.setup_fee_failure_action
					: null,
			paymentFailureThreshold:
				typeof preferences.payment_failure_threshold === "number"
					? preferences.payment_failure_threshold
					: null,
		},
		taxPercent: taxes ? string(taxes.percentage) : null,
	};
}
export function validWaffoTerms(
	version: WaffoVersionEvidence | null,
	price: number,
	period: string,
): boolean {
	return (
		!!version &&
		version.billingPeriod === period &&
		version.prices.length === 1 &&
		version.prices[0]?.currency === "USD" &&
		version.prices[0].amountMinor === price &&
		version.prices[0].trialAmountMinor === null &&
		version.trialDays === 0 &&
		version.setupFeeMinor === 0 &&
		version.finiteCycles === 0
	);
}
export function validPaypalTerms(plan: PayPalEvidence, price: number, period: string): boolean {
	const cycle = plan.billingCycles[0];
	return (
		plan.status === "ACTIVE" &&
		plan.billingCycles.length === 1 &&
		!!cycle &&
		cycle.tenureType === "REGULAR" &&
		cycle.intervalUnit === period &&
		cycle.intervalCount === 1 &&
		cycle.totalCycles === 0 &&
		cycle.sequence === 1 &&
		cycle.currency === "USD" &&
		cycle.amountMinor === price &&
		plan.paymentPreferences.setupFeeMinor === 0 &&
		(plan.paymentPreferences.setupFeeCurrency === null ||
			plan.paymentPreferences.setupFeeCurrency === "USD") &&
		(plan.taxPercent === null || Number(plan.taxPercent) === 0)
	);
}
export type AuditResult = Awaited<ReturnType<typeof auditAnnualProviders>>;
export async function auditAnnualProviders(
	environment: Record<string, string | undefined>,
	port: ProviderPort,
) {
	if (environment.WAFFO_ENVIRONMENT !== "prod" || environment.PAYPAL_ENVIRONMENT !== "live")
		throw new AnnualOperationError("PRODUCTION_ENVIRONMENT_REQUIRED");
	const catalog = await port.waffoCatalog();
	if (catalog.store.id !== environment.WAFFO_STORE_ID)
		throw new AnnualOperationError("WAFFO_STORE_ID_MISMATCH");
	const products = catalog.products.map(waffoEvidence);
	const unique = new Set(products.map((product) => product.id));
	if (unique.size !== products.length) throw new AnnualOperationError("WAFFO_CATALOG_DUPLICATE");
	const issues: string[] = [];
	if (catalog.store.status !== "active") issues.push("WAFFO_STORE_NOT_ACTIVE");
	const tiers = [];
	for (const tier of ANNUAL_TIERS) {
		const suffix = tier.key.toUpperCase();
		const getWaffo = (id: string | undefined) => {
			const match = products.find((product) => product.id === id);
			if (!match) throw new AnnualOperationError("MAPPED_WAFFO_PRODUCT_MISSING");
			return match;
		};
		const monthlyWaffo = getWaffo(environment[`WAFFO_PRODUCT_ID_${suffix}_MONTHLY`]);
		const oldWaffo = getWaffo(tier.waffo);
		const currentWaffo = getWaffo(environment[`WAFFO_PRODUCT_ID_${suffix}_YEARLY`]);
		const monthlyPayPal = paypalEvidence(
			await port.paypalPlan(string(environment[`PAYPAL_PLAN_ID_${suffix}_MONTHLY`])),
		);
		const oldPayPal = paypalEvidence(await port.paypalPlan(tier.paypal));
		const currentPayPalId = string(environment[`PAYPAL_PLAN_ID_${suffix}_YEARLY`]);
		const currentPayPal =
			currentPayPalId === tier.paypal
				? oldPayPal
				: paypalEvidence(await port.paypalPlan(currentPayPalId));
		if (
			!validWaffoTerms(monthlyWaffo.production, tier.monthly, "monthly") ||
			monthlyWaffo.status !== "active" ||
			!monthlyWaffo.hasProdVersion
		)
			issues.push(`WAFFO_MONTHLY_${suffix}_INVALID`);
		if (
			!validWaffoTerms(oldWaffo.production, tier.previous, "yearly") ||
			oldWaffo.status !== "active"
		)
			issues.push(`WAFFO_OLD_ANNUAL_${suffix}_INVALID`);
		if (!validPaypalTerms(monthlyPayPal, tier.monthly, "MONTH"))
			issues.push(`PAYPAL_MONTHLY_${suffix}_INVALID`);
		if (!validPaypalTerms(oldPayPal, tier.previous, "YEAR"))
			issues.push(`PAYPAL_OLD_ANNUAL_${suffix}_INVALID`);
		if (
			monthlyPayPal.productId !== oldPayPal.productId ||
			currentPayPal.productId !== oldPayPal.productId
		)
			issues.push(`PAYPAL_PRODUCT_IDENTITY_${suffix}_INVALID`);
		const listed = await port.paypalPlans(oldPayPal.productId);
		// The adapter returns details, never trust list summaries for monetary terms.
		const paypalDetails = listed.map(paypalEvidence);
		const paypalCandidates = paypalDetails.filter((plan) =>
			plan.billingCycles.some(
				(cycle) =>
					cycle.intervalUnit === "YEAR" &&
					cycle.currency === "USD" &&
					cycle.amountMinor === tier.annual,
			),
		);
		const waffoCandidates = products.filter((product) =>
			[product.production, product.test].some(
				(version) =>
					version?.billingPeriod === "yearly" &&
					version.prices.some(
						(price) => price.currency === "USD" && price.amountMinor === tier.annual,
					),
			),
		);
		const paypalTargets = listed
			.filter((plan) => plan.name === targetName(tier))
			.map(paypalEvidence);
		const waffoTargets = products.filter(
			(product) =>
				product.name === targetName(tier) ||
				product.test?.name === targetName(tier) ||
				product.production?.name === targetName(tier),
		);
		if (waffoTargets.length > 1 || paypalTargets.length > 1)
			issues.push(`TARGET_${suffix}_AMBIGUOUS`);
		for (const target of waffoTargets) {
			const version = target.production ?? target.test;
			if (
				!validWaffoTerms(version, tier.annual, "yearly") ||
				version?.operation !== ANNUAL_OPERATION ||
				version.previousProductId !== tier.waffo
			)
				issues.push(`WAFFO_TARGET_${suffix}_INVALID`);
		}
		for (const target of paypalTargets)
			if (
				!validPaypalTerms(target, tier.annual, "YEAR") ||
				target.productId !== oldPayPal.productId
			)
				issues.push(`PAYPAL_TARGET_${suffix}_INVALID`);
		if (
			currentWaffo.id !== tier.waffo &&
			!waffoTargets.some((target) => target.id === currentWaffo.id)
		)
			issues.push(`WAFFO_CURRENT_${suffix}_UNEXPECTED`);
		if (
			currentPayPal.id !== tier.paypal &&
			!paypalTargets.some((target) => target.id === currentPayPal.id)
		)
			issues.push(`PAYPAL_CURRENT_${suffix}_UNEXPECTED`);
		tiers.push({
			plan: tier.key,
			monthlyCredits: tier.credits,
			waffo: {
				monthly: monthlyWaffo,
				previousAnnual: oldWaffo,
				currentAnnual: currentWaffo,
				targets: waffoTargets,
				candidates: waffoCandidates,
			},
			paypal: {
				monthly: monthlyPayPal,
				previousAnnual: oldPayPal,
				currentAnnual: currentPayPal,
				targets: paypalTargets,
				candidates: paypalCandidates,
			},
		});
	}
	return {
		operation: ANNUAL_OPERATION,
		mode: "audit" as const,
		store: {
			id: string(catalog.store.id),
			name: string(catalog.store.name),
			status: string(catalog.store.status),
		},
		schemaFields: catalog.schemaFields,
		tiers,
		issues,
		ready: issues.length === 0,
	};
}
