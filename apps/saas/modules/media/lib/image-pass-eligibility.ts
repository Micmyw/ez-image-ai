interface ImagePassBalanceSkus {
	availableSkuKeys?: readonly string[];
	subscriptionFreeSkuKeys?: readonly string[];
}

/**
 * Whether the signed-in owner's available passes can pay for this size. The
 * server returns the union of sizes frozen on each grant, so passes bought
 * before the 1K/2K restriction keep their original coverage. Missing or empty
 * lists do not infer ownership from the currently advertised offer.
 */
export function imagePassCoversSku(
	balance: ImagePassBalanceSkus | undefined | null,
	skuKey: unknown,
): boolean {
	return typeof skuKey === "string" && balance?.availableSkuKeys?.includes(skuKey) === true;
}

/** Only available grants with independent model access may replace a subscription. */
export function imagePassIncludesSkuAccess(
	balance: ImagePassBalanceSkus | undefined | null,
	skuKey: unknown,
): boolean {
	return (
		imagePassCoversSku(balance, skuKey) &&
		balance?.subscriptionFreeSkuKeys?.includes(skuKey as string) === true
	);
}
