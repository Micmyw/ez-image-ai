import {
	DEFAULT_PRODUCT_CONFIG,
	EZPIC_PRODUCT_KEYS,
	getImageProductSelectionContract,
	resolvePlanEntitlement,
} from "@repo/config";

import { findEffectivePaidSubscription } from "./billing";
import type { MediaDatabaseClient } from "./types";

/** Transaction-current policy facts. Never accepts a cached plan from before a paid audit. */
export async function loadCurrentGenerationAdmission(
	input: { ownerId: string; productKey: string; costMicros: bigint; now: Date },
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
	if (!entitlement.allowedProducts.includes(productKey)) throw new Error("ENTITLEMENT_REQUIRED");
	if (input.costMicros > BigInt(DEFAULT_PRODUCT_CONFIG.budgets.maximumJobCostMicros))
		throw new Error("BUDGET_EXCEEDED");
	return {
		maximumConcurrentJobs: entitlement.maximumConcurrentJobs,
		maximumInputBytes: Math.min(
			entitlement.maximumInputBytes,
			getImageProductSelectionContract(productKey)?.maximumInputBytes ??
				entitlement.maximumInputBytes,
		),
	};
}
