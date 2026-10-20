import { WAFFO_PRODUCT_ID_PATTERN } from "@repo/config/client";

interface WaffoPriceReference {
	productId: string;
	versionId?: string;
}

// Version-qualified keys identify local immutable BillingPlan snapshots. They are
// never sent to Waffo as product IDs, and never select a mutable "latest" version.
export function parseWaffoPriceReference(value: string): WaffoPriceReference | null {
	if (WAFFO_PRODUCT_ID_PATTERN.test(value)) return { productId: value };
	const parts = value.split(":");
	if (
		parts.length !== 3 ||
		parts[0] !== "waffo" ||
		!WAFFO_PRODUCT_ID_PATTERN.test(parts[1]!) ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(parts[2]!) ||
		/^(latest|current|prod|test)$/i.test(parts[2]!)
	)
		return null;
	return { productId: parts[1]!, versionId: parts[2]! };
}

export function resolveWaffoProductId(value: string): string {
	const reference = parseWaffoPriceReference(value);
	if (!reference) throw new Error("WAFFO_PRICE_REFERENCE_INVALID");
	return reference.productId;
}

export function isWaffoBillingPlanReference(value: string, metadata: unknown): boolean {
	const reference = parseWaffoPriceReference(value);
	if (!reference) return false;
	if (!reference.versionId) return true; // Historical native-key snapshots stay immutable.
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
	const record = metadata as Record<string, unknown>;
	return (
		record.waffoProductId === reference.productId &&
		record.waffoProductVersionId === reference.versionId &&
		Number.isSafeInteger(record.waffoProductVersionNumber) &&
		Number(record.waffoProductVersionNumber) > 0 &&
		record.waffoTaxCategory === "saas"
	);
}
