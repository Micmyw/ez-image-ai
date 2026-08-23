import { db } from "@repo/database/client";
import { grantDueBillingPeriods as grantDueBillingPeriodsFn } from "@repo/payments";

export async function grantBillingPeriods(input: { now?: Date; limit?: number } = {}) {
	return grantDueBillingPeriodsFn(input, db);
}
