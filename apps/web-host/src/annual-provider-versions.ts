import {
	ANNUAL_OPERATION,
	ANNUAL_TIERS,
	AnnualOperationError,
	record,
	safeFailure,
	string,
	validWaffoTerms,
	waffoEvidence,
	type AnnualTier,
	type ProviderPort,
	type WaffoEvidence,
	type WaffoVersionEvidence,
} from "./annual-provider-core";
import type { AttemptKey } from "./annual-provider-prepare";

export const UNUSED_WAFFO_ANNUAL_PRODUCTS = [
	"PROD_6J8mFwX20ogb3oOvJBUyyx",
	"PROD_4cidU1O82aYG4sJdCIEJkj",
	"PROD_17HbhJ1VtmWUR5lkAxZQHJ",
] as const;
export type WaffoProductUsage = {
	productId: string;
	subscriptionOrderCount: number | null;
	status: "VERIFIED" | "UNKNOWN";
	reason?: "PRODUCT_ORDER_FILTER_UNSUPPORTED" | "PRODUCT_ORDER_COUNT_UNAVAILABLE";
};
export interface WaffoVersionPort extends Pick<ProviderPort, "waffoCatalog"> {
	waffoUnusedProductUsage?(): Promise<WaffoProductUsage[]>;
	waffoUpdateProductionVersion(tier: AnnualTier, previousVersionId: string): Promise<void>;
}
export type VersionBaseline = Record<
	AnnualTier["key"],
	{ productId: string; previousVersionId: string; previousVersionNumber: number }
>;
export type VersionSelection = {
	productId: string;
	previousVersionId: string;
	targetVersionId: string;
	targetVersionNumber: number;
};
export type VersionReceipt = {
	operation: typeof ANNUAL_OPERATION;
	plan: AnnualTier["key"];
	productId: string;
	action: "UPDATE_PRODUCTION_VERSION";
	phase: "ATTEMPT_STARTED" | "VERIFIED" | "RECOVERED" | "UNCERTAIN";
	requestKey: string;
	versionId?: string;
	failure?: ReturnType<typeof safeFailure>;
};
function versionId(value: unknown): string {
	const id = string(value);
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
		throw new AnnualOperationError("WAFFO_VERSION_ID_INVALID");
	return id;
}
export function waffoVersionLocalKey(productId: string, id: string): string {
	if (!ANNUAL_TIERS.some((tier) => tier.waffo === productId))
		throw new AnnualOperationError("WAFFO_PRODUCT_SCOPE_INVALID");
	return `waffo:${productId}:${versionId(id)}`;
}
export function encodeVersionBaseline(baseline: VersionBaseline): string {
	return Buffer.from(JSON.stringify(baseline)).toString("base64url");
}
export function decodeVersionBaseline(encoded: string): VersionBaseline {
	if (!/^[A-Za-z0-9_-]{1,4096}$/.test(encoded))
		throw new AnnualOperationError("WAFFO_VERSION_BASELINE_INVALID");
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch {
		throw new AnnualOperationError("WAFFO_VERSION_BASELINE_INVALID");
	}
	const input = record(value);
	if (Object.keys(input).sort().join() !== "creator,studio,ultimate")
		throw new AnnualOperationError("WAFFO_VERSION_BASELINE_INVALID");
	const result: Partial<VersionBaseline> = {};
	for (const tier of ANNUAL_TIERS) {
		const row = record(input[tier.key]);
		if (
			Object.keys(row).sort().join() !== "previousVersionId,previousVersionNumber,productId" ||
			row.productId !== tier.waffo ||
			!Number.isSafeInteger(row.previousVersionNumber) ||
			Number(row.previousVersionNumber) < 1
		)
			throw new AnnualOperationError("WAFFO_VERSION_BASELINE_INVALID");
		result[tier.key] = {
			productId: tier.waffo,
			previousVersionId: versionId(row.previousVersionId),
			previousVersionNumber: Number(row.previousVersionNumber),
		};
	}
	return result as VersionBaseline;
}
function terms(
	version: WaffoVersionEvidence | null | undefined,
	price: number,
): version is WaffoVersionEvidence & { id: string } {
	return (
		!!version &&
		!!version.id &&
		/^[A-Za-z0-9_-]{1,128}$/.test(version.id) &&
		Number.isSafeInteger(version.versionNumber) &&
		version.versionNumber > 0 &&
		validWaffoTerms(version, price, "yearly") &&
		version.prices[0]?.taxCategory === "saas"
	);
}
async function read(
	environment: Record<string, string | undefined>,
	port: Pick<WaffoVersionPort, "waffoCatalog">,
) {
	if (environment.WAFFO_ENVIRONMENT !== "prod")
		throw new AnnualOperationError("PRODUCTION_ENVIRONMENT_REQUIRED");
	const catalog = await port.waffoCatalog();
	if (
		catalog.store.id !== environment.WAFFO_STORE_ID ||
		catalog.store.status !== "active" ||
		catalog.store.prodEnabled !== true ||
		catalog.store.payinEnable !== true
	)
		throw new AnnualOperationError("WAFFO_VERSION_STORE_NOT_READY");
	const products = catalog.products.map(waffoEvidence);
	const result: Partial<Record<AnnualTier["key"], WaffoEvidence>> = {};
	for (const tier of ANNUAL_TIERS) {
		const matched = products.filter((product) => product.id === tier.waffo);
		if (matched.length !== 1 || matched[0]!.status !== "active" || !matched[0]!.hasProdVersion)
			throw new AnnualOperationError("WAFFO_PRODUCT_SCOPE_INVALID");
		const monthlyId = environment[`WAFFO_PRODUCT_ID_${tier.key.toUpperCase()}_MONTHLY`];
		const monthly = products.find((product) => product.id === monthlyId);
		if (
			!monthly ||
			monthly.status !== "active" ||
			!monthly.hasProdVersion ||
			!validWaffoTerms(monthly.production, tier.monthly, "monthly")
		)
			throw new AnnualOperationError("WAFFO_MONTHLY_CHANGED");
		result[tier.key] = matched[0]!;
	}
	return {
		store: {
			id: string(catalog.store.id),
			status: string(catalog.store.status),
			prodEnabled: true,
			payinEnable: true,
		},
		products: result as Record<AnnualTier["key"], WaffoEvidence>,
		unusedProducts: UNUSED_WAFFO_ANNUAL_PRODUCTS.map((id) => {
			const product = products.find((entry) => entry.id === id);
			return {
				productId: id,
				status: product?.status ?? "NOT_FOUND",
				hasProdVersion: product?.hasProdVersion ?? false,
			};
		}),
	};
}
function binding(tier: AnnualTier, selection: VersionSelection) {
	return {
		plan: tier.key,
		productId: tier.waffo,
		providerPriceId: waffoVersionLocalKey(tier.waffo, selection.targetVersionId),
		previousVersionId: selection.previousVersionId,
		priceMicros: String(tier.annual * 10000),
		creditsPerPeriod: tier.credits,
		metadata: {
			waffoProductId: tier.waffo,
			waffoProductVersionId: selection.targetVersionId,
			waffoProductVersionNumber: selection.targetVersionNumber,
			waffoTaxCategory: "saas",
		},
	};
}
export async function auditWaffoAnnualVersions(
	environment: Record<string, string | undefined>,
	port: Pick<WaffoVersionPort, "waffoCatalog">,
) {
	const current = await read(environment, port);
	const issues = ANNUAL_TIERS.filter(
		(tier) =>
			!terms(current.products[tier.key].production, tier.previous) &&
			!terms(current.products[tier.key].production, tier.annual),
	).map((tier) => `WAFFO_ANNUAL_${tier.key.toUpperCase()}_INVALID`);
	const baseline: Partial<VersionBaseline> = {};
	for (const tier of ANNUAL_TIERS) {
		const previous = current.products[tier.key].production;
		if (terms(previous, tier.previous))
			baseline[tier.key] = {
				productId: tier.waffo,
				previousVersionId: previous.id,
				previousVersionNumber: previous.versionNumber,
			};
	}
	const encodedBaseline =
		Object.keys(baseline).length === 3 ? encodeVersionBaseline(baseline as VersionBaseline) : null;
	const providerUsage =
		"waffoUnusedProductUsage" in port && typeof port.waffoUnusedProductUsage === "function"
			? ((await port.waffoUnusedProductUsage()) as WaffoProductUsage[])
			: UNUSED_WAFFO_ANNUAL_PRODUCTS.map((productId) => ({
					productId,
					subscriptionOrderCount: null,
					status: "UNKNOWN" as const,
					reason: "PRODUCT_ORDER_COUNT_UNAVAILABLE" as const,
				}));
	return {
		operation: ANNUAL_OPERATION,
		mode: "audit-waffo-versions" as const,
		providerUsage,
		encodedBaseline,
		baseline,
		issues,
		ready: issues.length === 0,
		...current,
	};
}

function assertBaseline(
	product: WaffoEvidence,
	tier: AnnualTier,
	baseline: VersionBaseline[AnnualTier["key"]],
) {
	const previous = product.versions.find((version) => version.id === baseline.previousVersionId);
	if (!terms(previous, tier.previous) || previous.versionNumber !== baseline.previousVersionNumber)
		throw new AnnualOperationError("WAFFO_VERSION_BASELINE_CHANGED");
	const production = product.production;
	if (production?.id === previous.id && terms(production, tier.previous))
		return { previous, production, changed: false };
	if (
		terms(production, tier.annual) &&
		production.id !== previous.id &&
		production.versionNumber > previous.versionNumber &&
		production.name === previous.name
	)
		return { previous, production, changed: true };
	throw new AnnualOperationError("WAFFO_PRODUCTION_VERSION_CHANGED");
}
/** Production update is immediate. Invoke only after the compatible old-price snapshot receiver is live.
 * Existing subscriptions retain their immutable version; publish is first-publish-only and is not used.
 * https://docs.waffo.ai/api-reference/endpoints/subscription-products/update-product
 * https://docs.waffo.ai/api-reference/endpoints/subscription-products/publish-product
 */
export async function updateWaffoAnnualProductionVersions(
	environment: Record<string, string | undefined>,
	port: WaffoVersionPort,
	baseline: VersionBaseline,
	options: { priorAttempts?: Set<AttemptKey>; onReceipt?: (receipt: VersionReceipt) => void } = {},
) {
	const previous = decodeVersionBaseline(encodeVersionBaseline(baseline));
	if ([...(options.priorAttempts ?? [])].some((key) => !key.startsWith("waffo:")))
		throw new AnnualOperationError("PRIOR_ATTEMPTS_INVALID");
	const initial = await read(environment, port);
	for (const tier of ANNUAL_TIERS)
		assertBaseline(initial.products[tier.key], tier, previous[tier.key]);
	const receipts: VersionReceipt[] = [];
	for (const tier of ANNUAL_TIERS) {
		const product = (await read(environment, port)).products[tier.key];
		const state = assertBaseline(product, tier, previous[tier.key]);
		if (state.changed) continue;
		if (options.priorAttempts?.has(`waffo:${tier.key}`))
			throw new AnnualOperationError("WAFFO_PRIOR_UPDATE_UNRESOLVED");
		const requestKey = `${ANNUAL_OPERATION}-waffo:${tier.key}-update-production-version`;
		const emit = (phase: VersionReceipt["phase"], id?: string, failure?: unknown) => {
			const receipt: VersionReceipt = {
				operation: ANNUAL_OPERATION,
				plan: tier.key,
				productId: tier.waffo,
				action: "UPDATE_PRODUCTION_VERSION",
				phase,
				requestKey,
				...(id ? { versionId: id } : {}),
				...(failure ? { failure: safeFailure(failure) } : {}),
			};
			receipts.push(receipt);
			options.onReceipt?.(receipt);
		};
		emit("ATTEMPT_STARTED");
		let failure: unknown;
		try {
			await port.waffoUpdateProductionVersion(tier, previous[tier.key].previousVersionId);
		} catch (error) {
			failure = error;
		}
		let actual: WaffoVersionEvidence & { id: string };
		try {
			const queried = assertBaseline(
				(await read(environment, port)).products[tier.key],
				tier,
				previous[tier.key],
			);
			if (!queried.changed) throw new AnnualOperationError("WAFFO_PRODUCTION_VERSION_UNCONFIRMED");
			actual = queried.production;
		} catch (error) {
			emit("UNCERTAIN", undefined, failure ?? error);
			throw new AnnualOperationError("WAFFO_UPDATE_VERSION_UNCERTAIN");
		}
		emit(failure ? "RECOVERED" : "VERIFIED", actual.id);
	}
	const final = await read(environment, port);
	const selections = ANNUAL_TIERS.map((tier) => {
		const verified = assertBaseline(final.products[tier.key], tier, previous[tier.key]);
		if (!verified.changed)
			throw new AnnualOperationError("WAFFO_UPDATED_VERSION_VERIFICATION_FAILED");
		return {
			tier,
			selection: {
				productId: tier.waffo,
				previousVersionId: previous[tier.key].previousVersionId,
				targetVersionId: verified.production.id,
				targetVersionNumber: verified.production.versionNumber,
			},
		};
	});
	return {
		operation: ANNUAL_OPERATION,
		mode: "update-waffo-versions" as const,
		ready: true,
		productionUpdated: true,
		bindings: selections.map(({ tier, selection }) => binding(tier, selection)),
		receipts,
		baseline: previous,
		products: final.products,
	};
}
