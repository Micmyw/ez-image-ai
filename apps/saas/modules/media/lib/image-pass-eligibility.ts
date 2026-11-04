import { isImagePassSkuAllowed } from "@repo/config/client";

interface ImagePassBalanceSkus {
	availableSkuKeys?: readonly string[];
}

/**
 * Whether the signed-in owner's available passes can pay for this size. The
 * server returns the union of sizes frozen on each grant, so passes bought
 * before the 1K/2K restriction keep their original coverage. Without that
 * list (loading or an older API) fall back to the current offer terms.
 */
export function imagePassCoversSku(
	balance: ImagePassBalanceSkus | undefined | null,
	skuKey: unknown,
): boolean {
	if (typeof skuKey !== "string") return false;
	if (balance?.availableSkuKeys && balance.availableSkuKeys.length > 0)
		return balance.availableSkuKeys.includes(skuKey);
	return isImagePassSkuAllowed(skuKey);
}
