interface ImagePassBalanceSkus {
	availableSkuKeys?: readonly string[];
	subscriptionFreeSkuKeys?: readonly string[];
}

/**
 * Whether the signed-in owner's available passes can pay for this size. The
 * server returns effective grant coverage, including versioned benefits for
 * eligible USD 2.99 purchases and the unchanged terms of older grants.
 * Missing or empty lists never infer ownership from the advertised offer.
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
