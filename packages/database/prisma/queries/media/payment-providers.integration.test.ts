import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import {
	bindPaymentCheckoutIntentSession,
	createPaymentCheckoutIntent,
	getPaymentCheckoutIntentByProviderSession,
	getPaymentCustomer,
	markPaymentCheckoutIntentProviderCreating,
	upsertPaymentCustomer,
} from "../payment-providers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const RUN_ID = crypto.randomUUID();
const fixtureIds = {
	owners: Array.from({ length: 8 }, (_, index) => `payment-owner-${index}-${RUN_ID}`),
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
			client.paymentCheckoutIntent.deleteMany({
				where: { ownerId: { in: fixtureIds.owners } },
			}),
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

		const waffoPlan = await createPlan(client, "waffo", "PROD_0123456789AbCdEfGhIjKl");
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

	it("stores no local expiry before provider binding", async () => {
		const plan = await createPlan(client, "paypal", `P-NO-EXPIRY-${RUN_ID}`.toUpperCase());
		const created = await createPaymentCheckoutIntent(
			{
				provider: "paypal",
				ownerType: "USER",
				ownerId: fixtureIds.owners[2]!,
				submittedByUserId: fixtureIds.owners[2]!,
				billingPlanId: plan.id,
				planKey: "creator",
				interval: "month",
				idempotencyKey: `no-local-expiry-${RUN_ID}`,
				now: new Date("2026-08-31T00:00:00.000Z"),
			},
			client,
		);
		fixtureIds.intents.push(created.intent.id);

		expect(created.intent).toMatchObject({ status: "CREATED", expiresAt: null });
	});

	it("scopes idempotency keys by owner and rejects command changes for the same owner", async () => {
		const paypalPlan = await createPlan(client, "paypal", `P-EXACT-${RUN_ID}`.toUpperCase());
		const waffoPlan = await createPlan(client, "waffo", "PROD_ABCDEFGHIJKL0123456789");
		const input = {
			provider: "paypal" as const,
			ownerType: "USER" as const,
			ownerId: fixtureIds.owners[3]!,
			submittedByUserId: fixtureIds.owners[3]!,
			billingPlanId: paypalPlan.id,
			planKey: "creator",
			interval: "month" as const,
			idempotencyKey: `owner-command-${RUN_ID}`,
			now: new Date("2026-08-31T00:00:00.000Z"),
		};
		const first = await createPaymentCheckoutIntent(input, client);
		fixtureIds.intents.push(first.intent.id);
		await expect(createPaymentCheckoutIntent(input, client)).resolves.toMatchObject({
			replayed: true,
			intent: { id: first.intent.id },
		});

		for (const conflicting of [
			{ ...input, billingPlanId: waffoPlan.id },
			{ ...input, planKey: "studio" },
			{ ...input, interval: "year" as const },
			{ ...input, submittedByUserId: fixtureIds.owners[4]! },
			{ ...input, provider: "waffo" as const, billingPlanId: waffoPlan.id },
		]) {
			await expect(createPaymentCheckoutIntent(conflicting, client)).rejects.toThrow(
				"PAYMENT_CHECKOUT_INTENT_IDEMPOTENCY_CONFLICT",
			);
		}

		const otherOwner = await createPaymentCheckoutIntent(
			{
				...input,
				ownerId: fixtureIds.owners[4]!,
				submittedByUserId: fixtureIds.owners[4]!,
			},
			client,
		);
		fixtureIds.intents.push(otherOwner.intent.id);
		expect(otherOwner).toMatchObject({
			replayed: false,
			intent: { ownerId: fixtureIds.owners[4], idempotencyKey: input.idempotencyKey },
		});
	});

	it("returns a complete bound pending replay but rejects terminal replay", async () => {
		const plan = await createPlan(client, "paypal", `P-BOUND-${RUN_ID}`.toUpperCase());
		const input = {
			provider: "paypal" as const,
			ownerType: "USER" as const,
			ownerId: fixtureIds.owners[5]!,
			submittedByUserId: fixtureIds.owners[5]!,
			billingPlanId: plan.id,
			planKey: "creator",
			interval: "month" as const,
			idempotencyKey: `bound-replay-${RUN_ID}`,
			now: new Date("2026-08-31T00:00:00.000Z"),
		};
		const created = await createPaymentCheckoutIntent(input, client);
		fixtureIds.intents.push(created.intent.id);
		await markPaymentCheckoutIntentProviderCreating(
			{ intentId: created.intent.id, provider: "paypal" },
			client,
		);
		await bindPaymentCheckoutIntentSession(
			{
				intentId: created.intent.id,
				provider: "paypal",
				providerSessionId: `I-BOUND-${RUN_ID}`,
				providerCheckoutUrl: "https://www.sandbox.paypal.com/checkout/retained",
				expiresAt: null,
			},
			client,
		);

		await expect(createPaymentCheckoutIntent(input, client)).resolves.toMatchObject({
			replayed: true,
			intent: {
				id: created.intent.id,
				status: "PROVIDER_PENDING",
				providerCheckoutUrl: "https://www.sandbox.paypal.com/checkout/retained",
			},
		});

		await client.paymentCheckoutIntent.update({
			where: { id: created.intent.id },
			data: { status: "COMPLETED", activeScopeKey: null },
		});
		await expect(createPaymentCheckoutIntent(input, client)).rejects.toThrow(
			"PAYMENT_CHECKOUT_INTENT_REPLAY_UNSAFE",
		);
	});

	it("does not expire a PayPal pending checkout from local elapsed time", async () => {
		const plan = await createPlan(client, "paypal", `P-NO-TTL-${RUN_ID}`.toUpperCase());
		const base = {
			provider: "paypal" as const,
			ownerType: "USER" as const,
			ownerId: fixtureIds.owners[6]!,
			submittedByUserId: fixtureIds.owners[6]!,
			billingPlanId: plan.id,
			planKey: "creator",
			interval: "month" as const,
		};
		const created = await createPaymentCheckoutIntent(
			{
				...base,
				idempotencyKey: `paypal-no-ttl-${RUN_ID}`,
				now: new Date("2026-01-01T00:00:00.000Z"),
			},
			client,
		);
		fixtureIds.intents.push(created.intent.id);
		await markPaymentCheckoutIntentProviderCreating(
			{ intentId: created.intent.id, provider: "paypal" },
			client,
		);
		await bindPaymentCheckoutIntentSession(
			{
				intentId: created.intent.id,
				provider: "paypal",
				providerSessionId: `I-NO-TTL-${RUN_ID}`,
				providerCheckoutUrl: "https://www.sandbox.paypal.com/checkout/no-ttl",
				expiresAt: null,
			},
			client,
		);

		await expect(
			createPaymentCheckoutIntent(
				{
					...base,
					idempotencyKey: `paypal-second-${RUN_ID}`,
					now: new Date("2026-12-31T00:00:00.000Z"),
				},
				client,
			),
		).rejects.toThrow("PAYMENT_CHECKOUT_INTENT_CONFLICT");
	});

	it("releases only a provider-bound pending checkout with an explicit expired provider time", async () => {
		const plan = await createPlan(client, "waffo", "PROD_ZYXWVUTSRQPO9876543210");
		const base = {
			provider: "waffo" as const,
			ownerType: "USER" as const,
			ownerId: fixtureIds.owners[7]!,
			submittedByUserId: fixtureIds.owners[7]!,
			billingPlanId: plan.id,
			planKey: "creator",
			interval: "month" as const,
		};
		const first = await createPaymentCheckoutIntent(
			{
				...base,
				idempotencyKey: `waffo-expiring-${RUN_ID}`,
				now: new Date("2026-01-01T00:00:00.000Z"),
			},
			client,
		);
		fixtureIds.intents.push(first.intent.id);
		await markPaymentCheckoutIntentProviderCreating(
			{ intentId: first.intent.id, provider: "waffo" },
			client,
		);
		await bindPaymentCheckoutIntentSession(
			{
				intentId: first.intent.id,
				provider: "waffo",
				providerSessionId: `session-expired-${RUN_ID}`,
				providerCheckoutUrl: "https://pancake.waffo.ai/checkout/expired",
				expiresAt: new Date("2026-01-01T01:00:00.000Z"),
			},
			client,
		);

		const second = await createPaymentCheckoutIntent(
			{
				...base,
				idempotencyKey: `waffo-replacement-${RUN_ID}`,
				now: new Date("2026-01-02T00:00:00.000Z"),
			},
			client,
		);
		fixtureIds.intents.push(second.intent.id);
		expect(second).toMatchObject({ replayed: false, intent: { status: "CREATED" } });
		await expect(
			client.paymentCheckoutIntent.findUnique({ where: { id: first.intent.id } }),
		).resolves.toMatchObject({ status: "EXPIRED", activeScopeKey: null });
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
		await markPaymentCheckoutIntentProviderCreating(
			{ intentId: intent.intent.id, provider: "paypal" },
			client,
		);
		await bindPaymentCheckoutIntentSession(
			{
				intentId: intent.intent.id,
				provider: "paypal",
				providerSessionId: "same-session-id",
				providerCheckoutUrl: "https://www.sandbox.paypal.com/checkout/same-session-id",
				expiresAt: null,
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
		!/(?:test|testing)/i.test(parsed.pathname)
	) {
		throw new Error("UNSAFE_TEST_DATABASE: expected a disposable loopback test database");
	}
	return TEST_DATABASE_URL;
}
