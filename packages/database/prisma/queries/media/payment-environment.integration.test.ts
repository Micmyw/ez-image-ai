import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { assertLiveBillingDataIsolation } from "./payment-environment";

let client: PrismaClient;
const id = `billing-environment-${crypto.randomUUID()}`;
beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url || url === process.env.DATABASE_URL) throw new Error("UNSAFE_TEST_DATABASE");
	const target = new URL(url);
	if (
		!["localhost", "127.0.0.1"].includes(target.hostname) ||
		target.port !== "55432" ||
		target.pathname !== "/ai_media_foundation_test"
	)
		throw new Error("UNSAFE_TEST_DATABASE");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
});
afterAll(async () => {
	if (client) {
		await client.$disconnect();
	}
});
it("rejects unknown and sandbox payment provenance before live checkout", async () => {
	await client.$transaction(async (tx) => {
		// The gate is intentionally database-wide. Transaction-local tables copied
		// from the real schema keep unrelated integration fixtures out of this case.
		await tx.$executeRaw`CREATE TEMP TABLE "payment_event" (LIKE public."payment_event" INCLUDING DEFAULTS) ON COMMIT DROP`;
		await tx.$executeRaw`CREATE TEMP TABLE "billing_plan" (LIKE public."billing_plan" INCLUDING DEFAULTS) ON COMMIT DROP`;
		await tx.$executeRaw`CREATE TEMP TABLE "subscription" (LIKE public."subscription" INCLUDING DEFAULTS) ON COMMIT DROP`;
		await tx.$executeRaw`CREATE TEMP TABLE "payment_checkout_intent" (LIKE public."payment_checkout_intent" INCLUDING DEFAULTS) ON COMMIT DROP`;
		await tx.$executeRaw`INSERT INTO "payment_event" ("id", "provider", "providerEventId", "verifiedAt", "envelope") VALUES (${id}, 'paypal', ${id}, now(), '{}'::jsonb)`;
		await expect(assertLiveBillingDataIsolation(tx)).rejects.toThrow(
			"BILLING_TEST_DATA_ISOLATION_REQUIRED",
		);
		await tx.$executeRaw`UPDATE "payment_event" SET "providerEnvironment" = 'sandbox' WHERE "id" = ${id}`;
		await expect(assertLiveBillingDataIsolation(tx)).rejects.toThrow(
			"BILLING_TEST_DATA_ISOLATION_REQUIRED",
		);
		await tx.$executeRaw`UPDATE "payment_event" SET "providerEnvironment" = 'live' WHERE "id" = ${id}`;
		await expect(assertLiveBillingDataIsolation(tx)).resolves.toBeUndefined();
	});
});
