import { ORPCError } from "@orpc/server";
import { assertLiveBillingDataIsolation } from "@repo/database";
import { db } from "@repo/database/client";

// Only new purchases are gated. Webhooks, capture of an existing order,
// cancellation, refunds and reconciliation must keep running while disabled.
export function isNewBillingEnabled(): boolean {
	return process.env.BILLING_ENABLED === "true";
}

export function assertNewBillingEnabled(): void {
	if (!isNewBillingEnabled()) {
		throw new ORPCError("SERVICE_UNAVAILABLE", { message: "BILLING_DISABLED" });
	}
}

export async function assertBillingEnvironmentReady(): Promise<void> {
	const paypal = process.env.PAYPAL_ENVIRONMENT;
	const waffo = process.env.WAFFO_ENVIRONMENT;
	if (paypal !== "live" && waffo !== "prod") return;
	if (paypal === "sandbox" || waffo === "test")
		throw new ORPCError("SERVICE_UNAVAILABLE", { message: "BILLING_ENVIRONMENT_MIXED" });
	try {
		await assertLiveBillingDataIsolation(db);
	} catch {
		throw new ORPCError("SERVICE_UNAVAILABLE", { message: "BILLING_TEST_DATA_ISOLATION_REQUIRED" });
	}
}
