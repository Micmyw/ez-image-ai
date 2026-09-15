import type { MediaDatabaseClient } from "./types";

/** A live switch must not inherit sandbox payments, pending checkouts or credits. */
export async function assertLiveBillingDataIsolation(client: MediaDatabaseClient) {
	const rows = await client.$queryRaw<Array<{ contaminated: boolean }>>`
		SELECT (
			EXISTS (SELECT 1 FROM "payment_event" e WHERE
				(e."provider" = 'paypal' AND e."providerEnvironment" IS DISTINCT FROM 'live') OR
				(e."provider" = 'waffo' AND e."providerEnvironment" IS DISTINCT FROM 'prod'))
			OR EXISTS (SELECT 1 FROM "billing_plan" p WHERE
				((p."provider" = 'paypal' AND p."metadata"->>'providerEnvironment' IS DISTINCT FROM 'live') OR
				 (p."provider" = 'waffo' AND p."metadata"->>'providerEnvironment' IS DISTINCT FROM 'prod'))
				AND (EXISTS (SELECT 1 FROM "subscription" s WHERE s."planId" = p."id") OR
					 EXISTS (SELECT 1 FROM "payment_checkout_intent" c WHERE c."billingPlanId" = p."id")))
		) AS "contaminated"`;
	if (rows[0]?.contaminated !== false) throw new Error("BILLING_TEST_DATA_ISOLATION_REQUIRED");
}
