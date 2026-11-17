import {
	DEFAULT_PRODUCT_CONFIG,
	EZPIC_PRODUCT_KEYS,
	getImageProductSelectionContract,
	resolvePlanEntitlement,
	planIncludesImageSelection,
} from "@repo/config";

import { findEffectivePaidSubscription } from "./billing";
import { loadImageAdminTestSkuKeys } from "./image-admin-test-access";
import { hasSpendablePurchasedImageCredits } from "./image-credit-access";
import { assertImagePassAvailable, type GenerationFundingSource } from "./image-passes";
import type { MediaDatabaseClient } from "./types";

/** Transaction-current policy facts. Never accepts a cached plan from before a paid audit. */
export async function loadCurrentGenerationAdmission(
	input: {
		ownerId: string;
		productKey: string;
		costMicros: bigint;
		now: Date;
		fundingSource?: GenerationFundingSource;
		skuKey?: unknown;
		imagePassBenefitPolicy?: unknown;
		outputFormat?: unknown;
		requiresPaidImageAccess?: boolean;
	},
	tx: MediaDatabaseClient,
) {
	const productKey = EZPIC_PRODUCT_KEYS.find((key) => key === input.productKey);
	if (!productKey) throw new Error("MODEL_DISABLED");
	const disabled = await tx.runtimeConfigOverride.findMany({
		where: {
			active: true,
			value: { equals: false },
			configKey: { in: ["media.generation.enabled", `media.model.${productKey}.enabled`] },
		},
		select: { configKey: true },
	});
	if (disabled.length) throw new Error("MODEL_DISABLED");
	const subscription = await findEffectivePaidSubscription(
		{ ownerType: "USER", ownerId: input.ownerId, now: input.now },
		tx,
	);
	const entitlement = resolvePlanEntitlement(subscription?.plan.metadata, subscription?.plan.name);
	const planIncludesProduct = planIncludesImageSelection(entitlement, productKey, input.skuKey);
	const needsPurchasedCreditAccess =
		!subscription &&
		input.fundingSource !== "IMAGE_PASS" &&
		(!planIncludesProduct || input.requiresPaidImageAccess);
	if (needsPurchasedCreditAccess) {
		// Serialize qualification with spending and refund projections, then read fresh eligibility.
		await tx.$queryRaw`SELECT "id" FROM "credit_account" WHERE "ownerType" = 'USER' AND "ownerId" = ${input.ownerId} FOR UPDATE`;
	}
	const hasPaidImageAccess =
		Boolean(subscription) ||
		(needsPurchasedCreditAccess && (await hasSpendablePurchasedImageCredits(input.ownerId, tx)));
	if (input.requiresPaidImageAccess && !hasPaidImageAccess && input.fundingSource !== "IMAGE_PASS")
		throw new Error("ENTITLEMENT_REQUIRED");
	if (!hasPaidImageAccess && !planIncludesProduct && input.fundingSource !== "IMAGE_PASS") {
		const testSkus = await loadImageAdminTestSkuKeys(input.ownerId, tx);
		if (!testSkus.some((sku) => sku === input.skuKey)) throw new Error("ENTITLEMENT_REQUIRED");
	}
	if (input.fundingSource === "IMAGE_PASS")
		await assertImagePassAvailable(
			{
				ownerId: input.ownerId,
				productKey,
				skuKey: input.skuKey,
				imagePassBenefitPolicy: input.imagePassBenefitPolicy,
				outputFormat: input.outputFormat,
				requireModelAccess:
					!planIncludesProduct || Boolean(input.requiresPaidImageAccess && !hasPaidImageAccess),
			},
			tx,
		);
	if (input.costMicros > BigInt(DEFAULT_PRODUCT_CONFIG.budgets.maximumJobCostMicros))
		throw new Error("BUDGET_EXCEEDED");
	return {
		hasEffectivePaidSubscription: Boolean(subscription),
		maximumInputBytes: Math.min(
			entitlement.maximumInputBytes,
			getImageProductSelectionContract(productKey)?.maximumInputBytes ??
				entitlement.maximumInputBytes,
		),
	};
}
