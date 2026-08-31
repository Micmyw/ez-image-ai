import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import {
	bindPaymentCheckoutIntentSession,
	createPaymentCheckoutIntent,
	getPaymentCheckoutIntentByProviderSession,
	getPaymentCustomer,
	upsertPaymentCustomer,
} from "../payment-providers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const RUN_ID = crypto.randomUUID();
const fixtureIds = {
	owners: [`payment-owner-a-${RUN_ID}`, `payment-owner-b-${RUN_ID}`],
	plans: [] as string[],
	intents: [] as string[],
	customers: [] as string[],
};

describe("provider-aware payment persistence", () => {
	let client: PrismaClient;

	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl() }),
		});
	});

	afterAll(async () => {
		if (!client) return;
		await client.$transaction([
			client.paymentCheckoutIntent.deleteMany({ where: { id: { in: fixtureIds.intents } } }),
			client.paymentCustomer.deleteMany({ where: { id: { in: fixtureIds.customers } } }),
			client.subscription.deleteMany({
				where: { ownerId: { in: fixtureIds.owners } },
			}),
			client.purchase.deleteMany({ where: { userId: { in: fixtureIds.owners } } }),
		]);
		await client.billingPlan.deleteMany({ where: { id: { in: fixtureIds.plans } } });
		await client.$disconnect();
	});

	it("replays one provider attempt and rejects concurrent cross-provider activation", async () => {
		const plan = await createPlan(client, "paypal", "P-CREATOR-MONTHLY");
		const now = new Date("2026-08-31T00:00:00.000Z");
		const input = {
			provider: "paypal" as const,
			ownerType: "USER" as const,
			ownerId: fixtureIds.owners[0],
			submittedByUserId: fixtureIds.owners[0],
			billingPlanId: plan.id,
			planKey: "creator",
			interval: "month" as const,
			idempotencyKey: `attempt-${RUN_ID}`,
			now,
		};

		const first = await createPaymentCheckoutIntent(input, client);
		fixtureIds.intents.push(first.intent.id);
		const replay = await createPaymentCheckoutIntent(input, client);
		expect(replay).toMatchObject({ replayed: true, intent: { id: first.intent.id } });

		const waffoPlan = await createPlan(client, "waffo", "PROD_CREATOR_MONTHLY");
		await expect(
			createPaymentCheckoutIntent(
				{
					...input,
					provider: "waffo",
					billingPlanId: waffoPlan.id,
					idempotencyKey: `waffo-attempt-${RUN_ID}`,
				},
				client,
			),
		).rejects.toThrow("PAYMENT_CHECKOUT_INTENT_CONFLICT");
	});

	it("scopes customer and provider session identities by provider", async () => {
		const ownerId = fixtureIds.owners[1];
		const paypalCustomer = await upsertPaymentCustomer(
			{
				provider: "paypal",
				ownerType: "USER",
				ownerId,
				providerCustomerId: "same-provider-id",
			},
			client,
		);
		const waffoCustomer = await upsertPaymentCustomer(
			{
				provider: "waffo",
				ownerType: "USER",
				ownerId,
				providerCustomerId: "same-provider-id",
			},
			client,
		);
		fixtureIds.customers.push(paypalCustomer.id, waffoCustomer.id);

		await expect(
			getPaymentCustomer("paypal", { ownerType: "USER", ownerId }, client),
		).resolves.toMatchObject({ id: paypalCustomer.id });
		await expect(
			getPaymentCustomer("waffo", { ownerType: "USER", ownerId }, client),
		).resolves.toMatchObject({ id: waffoCustomer.id });

		const paypalPlan = await createPlan(client, "paypal", `P-PLAN-${RUN_ID}`.toUpperCase());
		const intent = await createPaymentCheckoutIntent(
			{
				provider: "paypal",
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				billingPlanId: paypalPlan.id,
				planKey: "studio",
				interval: "month",
				idempotencyKey: `session-attempt-${RUN_ID}`,
				now: new Date("2026-08-31T00:00:00.000Z"),
			},
			client,
		);
		fixtureIds.intents.push(intent.intent.id);
		await bindPaymentCheckoutIntentSession(
			{
				intentId: intent.intent.id,
				provider: "paypal",
				providerSessionId: "same-session-id",
			},
			client,
		);
		await expect(
			getPaymentCheckoutIntentByProviderSession("paypal", "same-session-id", client),
		).resolves.toMatchObject({ id: intent.intent.id });
		await expect(
			getPaymentCheckoutIntentByProviderSession("waffo", "same-session-id", client),
		).resolves.toBeNull();
	});
});

async function createPlan(client: PrismaClient, provider: string, providerPriceId: string) {
	const plan = await client.billingPlan.create({
		data: {
			provider,
			providerPriceId,
			name: "creator",
			creditsPerPeriod: 1_000n,
			priceMicros: 19_000_000n,
			currency: "USD",
			metadata: { planId: "creator", interval: "month" },
		},
	});
	fixtureIds.plans.push(plan.id);
	return plan;
}

function safeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	if (DATABASE_URL && DATABASE_URL === TEST_DATABASE_URL) {
		throw new Error("UNSAFE_TEST_DATABASE: TEST_DATABASE_URL must not equal DATABASE_URL");
	}
	const parsed = new URL(TEST_DATABASE_URL);
	if (
		(parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
		parsed.port !== "55432" ||
		!/^\/ezpic_[a-z0-9_]+_test$/.test(parsed.pathname)
	) {
		throw new Error("UNSAFE_TEST_DATABASE: expected a disposable EzPic database on port 55432");
	}
	return TEST_DATABASE_URL;
}
