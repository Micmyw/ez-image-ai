import { IMAGE_SKU_KEYS, type ImageSkuKey } from "@repo/config";

import type { Prisma } from "../../generated/client";

/** Account-specific image testing only; never changes the subscription or funding source. */
export async function loadImageAdminTestSkuKeys(
	ownerId: string,
	tx: Pick<Prisma.TransactionClient, "$queryRaw">,
): Promise<ImageSkuKey[]> {
	const [grant] = await tx.$queryRaw<Array<{ value: unknown; now: Date }>>`
		SELECT config."value", clock_timestamp() AS "now"
		FROM "runtime_config_override" config
		JOIN "user" account ON account."id" = ${ownerId}
		WHERE config."configKey" = ${`media.image-admin-test.${ownerId}`}
			AND config."active" = true AND account."role" = 'admin'
			AND account."isAnonymous" = false
			AND (account."banned" IS NOT TRUE OR account."banExpires" <= clock_timestamp())
		ORDER BY config."version" DESC LIMIT 1`;
	if (!grant || !grant.value || typeof grant.value !== "object" || Array.isArray(grant.value))
		return [];
	const value = grant.value as Record<string, unknown>;
	if (
		value.version !== 1 ||
		typeof value.expiresAt !== "string" ||
		!(Date.parse(value.expiresAt) > grant.now.getTime()) ||
		!Array.isArray(value.skuKeys) ||
		!value.skuKeys.every((sku) => (IMAGE_SKU_KEYS as readonly unknown[]).includes(sku))
	)
		return [];
	return [...new Set(value.skuKeys as ImageSkuKey[])];
}
