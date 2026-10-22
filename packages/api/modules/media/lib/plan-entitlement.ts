import { resolvePlanEntitlement } from "@repo/config";
import { findEffectivePaidSubscription } from "@repo/database";
import { db } from "@repo/database/client";

interface LoadUserPlanEntitlementOptions {
	now?: Date;
	client?: Parameters<typeof findEffectivePaidSubscription>[1];
}

export async function loadUserPlanEntitlement(
	userId: string,
	options: LoadUserPlanEntitlementOptions = {},
) {
	return (await loadUserPlanAccess(userId, options)).entitlement;
}

/** One request-local read; admission transactions still recheck mutable policy. */
export async function loadUserPlanAccess(
	userId: string,
	options: LoadUserPlanEntitlementOptions = {},
) {
	const now = options.now ?? new Date();
	const subscription = await findEffectivePaidSubscription(
		{ ownerType: "USER", ownerId: userId, now },
		options.client ?? db,
	);
	return {
		entitlement: resolvePlanEntitlement(subscription?.plan.metadata, subscription?.plan.name),
		hasEffectivePaidSubscription: subscription !== null,
	};
}
