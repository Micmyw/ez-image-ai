import { db } from "@repo/database/client";

import { reconcileSubscriptionsWithClient } from "./reconcile-subscriptions-core";

export async function reconcileSubscriptions(input: { now?: Date; limit?: number } = {}) {
	return reconcileSubscriptionsWithClient(input, db);
}
