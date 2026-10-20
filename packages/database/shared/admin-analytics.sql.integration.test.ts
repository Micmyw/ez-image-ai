import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	buildAdminAnalyticsFunnel,
	buildAdminAnalyticsOverview,
	buildAdminAnalyticsReport,
} from "./admin-analytics";
import { readAdminAnalyticsFacts, type AdminAnalyticsQuery } from "./admin-analytics-reader";

const connectionString =
	process.env.ADMIN_ANALYTICS_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const target = connectionString ? new URL(connectionString) : null;
const enabled = Boolean(
	target &&
	target.hostname === "127.0.0.1" &&
	["55432", "55439", "55441", "55442"].includes(target.port) &&
	/^\/(?:ezpic|admin|ai_media)_[a-z0-9_]*test$/.test(target.pathname),
);
if (connectionString && !enabled) throw new Error("ISOLATED_ADMIN_ANALYTICS_DATABASE_REQUIRED");
const pool = enabled ? new Pool({ connectionString, max: 1 }) : null;
const schema = `admin_analytics_${randomUUID().replaceAll("-", "")}`;
let client: PoolClient | undefined;
let created = false;
let queryTail: Promise<unknown> = Promise.resolve();
const now = new Date("2026-10-20T12:00:00Z");
const query: AdminAnalyticsQuery = async <T>(statement: string, parameters: readonly unknown[]) => {
	if (!client) throw new Error("ISOLATED_ADMIN_ANALYTICS_DATABASE_REQUIRED");
	const pending = queryTail.then(() => client!.query(statement, [...parameters]));
	queryTail = pending.catch(() => undefined);
	return (await pending).rows as T[];
};

describe.skipIf(!enabled)("admin analytics production SQL in isolated PostgreSQL", () => {
	beforeAll(async () => {
		client = await pool!.connect();
		await client.query(`CREATE SCHEMA "${schema}"`);
		created = true;
		await client.query(`SET search_path TO "${schema}"`);
		await client.query("SET TIME ZONE 'UTC'");
		await client.query(`
			CREATE TABLE "user" (id text PRIMARY KEY, email text, "createdAt" timestamptz, "isAnonymous" boolean, "registrationAttribution" jsonb);
			CREATE TABLE "member" ("userId" text, "organizationId" text);
			CREATE TABLE "payment_checkout_intent" (id text PRIMARY KEY, provider text, "ownerType" text, "ownerId" text, "submittedByUserId" text, "createdAt" timestamptz, "productKind" text, "providerSessionId" text, "providerOrderId" text);
			CREATE TABLE "subscription" (id text PRIMARY KEY, provider text, "providerSubscriptionId" text, "ownerType" text, "ownerId" text, status text, "createdAt" timestamptz, "currentPeriodEnd" timestamptz, "renewalDisabledAt" timestamptz, "refundTerminationRequestedAt" timestamptz, "initialPaymentEvidence" jsonb);
			CREATE TABLE "billing_period" (id text PRIMARY KEY, "subscriptionId" text, "startsAt" timestamptz, "providerInvoicePaymentId" text, "providerInvoiceId" text, "providerChargeId" text, "providerPaymentIntentId" text, "paidAmount" bigint);
			CREATE TABLE "credit_pack_fulfillment" (id text PRIMARY KEY, "ownerType" text, "ownerId" text, "checkoutIntentId" text, provider text, "providerPaymentId" text, "paidAt" timestamptz, "paidAmountMicros" bigint, currency text);
			CREATE TABLE "image_pass_grant" (id text PRIMARY KEY, "ownerId" text, "checkoutIntentId" text, provider text, "providerPaymentId" text, "paidAt" timestamptz, "paidAmountMicros" bigint, currency text);
			CREATE TABLE "payment_event" (id text PRIMARY KEY, provider text, "providerEnvironment" text, status text, "verifiedAt" timestamptz, "normalizedTransactionId" text, envelope jsonb);
			CREATE TABLE "credit_pack_adjustment" (id text PRIMARY KEY, "fulfillmentId" text, status text, "providerCreatedAt" timestamptz, "amountMicros" bigint, currency text);
			CREATE TABLE "image_pass_adjustment" (id text PRIMARY KEY, "grantId" text, "occurredAt" timestamptz, "amountMicros" bigint, currency text);
			CREATE TABLE "subscription_payment_adjustment" (id text PRIMARY KEY, "subscriptionId" text, "providerCreatedAt" timestamptz, "amountMicros" bigint, currency text, "providerPaymentId" text);
			CREATE TABLE "stripe_refund" (id text PRIMARY KEY, "providerChargeId" text, "providerPaymentIntentId" text, "providerCreatedAt" timestamptz, amount bigint, currency text, status text);
			CREATE TABLE "support_ticket" (id text PRIMARY KEY, status text, "createdByUserId" text, "organizationId" text);
		`);
		const attribution = {
			version: 1,
			registeredAt: "2026-10-19T00:00:00Z",
			source: "campaign",
			utmSource: "google",
			utmMedium: null,
			utmCampaign: null,
			utmTerm: "portrait",
			utmContent: null,
			referrerOrigin: null,
			country: "US",
			countrySource: "registration_proxy",
		};
		await client.query(
			`INSERT INTO "user" VALUES
			('a','a@example.test','2026-10-19',false,$1), ('b','b@example.test','2026-10-19',false,null),
			('anonymous','guest@anonymous.invalid','2026-10-19',true,null), ('legacy','old@guest.invalid','2026-10-19',false,null);
		`,
			[JSON.stringify(attribution)],
		);
		await client.query(`
			INSERT INTO "member" VALUES ('a','org-a'), ('b','org-b');
			INSERT INTO "payment_checkout_intent" VALUES
				('c-a','paypal','USER','a','a','2026-10-19','CREDIT_PACK',null,null),
				('c-org','paypal','ORGANIZATION','org-a','a','2026-10-19','CREDIT_PACK',null,null),
				('c-test','paypal','USER','a','a','2026-10-19','CREDIT_PACK',null,null),
				('c-foreign','paypal','ORGANIZATION','org-b','b','2026-10-19','CREDIT_PACK',null,null);
			INSERT INTO "subscription" VALUES ('s','stripe','stripe-sub','USER','a','ACTIVE','2026-10-19','2027-10-19',null,null,null);
			INSERT INTO "credit_pack_fulfillment" VALUES
				('p-a','USER','a','c-a','paypal','capture-a','2026-10-19',3000000,'USD'),
				('p-org','ORGANIZATION','org-a','c-org','paypal','capture-org','2026-10-19',2000000,'CNY'),
				('p-test','USER','a','c-test','paypal','capture-test','2026-10-19',99000000,'USD'),
				('p-foreign','ORGANIZATION','org-b','c-foreign','paypal','capture-foreign','2026-10-19',88000000,'USD');
			INSERT INTO "credit_pack_adjustment" VALUES ('r-a','p-a','SUCCEEDED','2026-10-20',500000,'USD');
			INSERT INTO "stripe_refund" VALUES ('r-s','charge',null,'2026-10-20',100,'USD','SUCCEEDED');
			INSERT INTO "support_ticket" VALUES ('t-a','OPEN','a',null), ('t-org','OPEN','a','org-a'), ('t-foreign','OPEN','b','org-b'), ('done','CLOSED','a',null);
		`);
		for (let month = 0; month < 12; month++) {
			await client.query(
				`INSERT INTO "billing_period" VALUES ($1,'s',$2,'invoice-payment','invoice','charge',null,10000)`,
				[`period-${String(month).padStart(2, "0")}`, new Date(Date.UTC(2026, 9 + month, 19))],
			);
		}
		const invoice = {
			type: "invoice.paid",
			livemode: true,
			data: {
				object: {
					id: "invoice",
					subscription: "stripe-sub",
					amount_paid: 10000,
					currency: "usd",
					billing_reason: "subscription_create",
					status_transitions: { paid_at: new Date("2026-10-19T00:00:00Z").getTime() / 1000 },
				},
			},
		};
		await client.query(
			`INSERT INTO "payment_event" VALUES ('stripe','stripe','live','PROCESSED','2026-10-19','invoice:invoice',$1)`,
			[JSON.stringify(invoice)],
		);
		for (const id of ["a", "org", "test", "foreign"]) {
			await client.query(
				`INSERT INTO "payment_event" VALUES ($1,'paypal',$2,'PROCESSED','2026-10-19',$3,$4)`,
				[
					`event-${id}`,
					id === "test" ? "sandbox" : "live",
					`capture-${id}`,
					JSON.stringify({
						event_type: "PAYMENT.CAPTURE.COMPLETED",
						resource: { id: `capture-${id}` },
					}),
				],
			);
		}
	}, 30_000);

	afterAll(async () => {
		if (client) {
			if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
			client.release();
		}
		await pool?.end();
	});

	it("executes all seven queries, deduplicates annual projections, and excludes test money", async () => {
		const data = await readAdminAnalyticsFacts(query, { kind: "platform" });
		expect(data.users.map((user) => user.id).sort()).toEqual(["a", "b"]);
		expect(data.payments.filter((payment) => payment.subscriptionId === "s")).toHaveLength(1);
		const overview = buildAdminAnalyticsOverview(data, { kind: "platform" }, now);
		expect(overview.revenue30d).toEqual([
			{
				currency: "CNY",
				grossMicros: "2000000",
				refundedMicros: "0",
				netMicros: "2000000",
				orders: 1,
			},
			{
				currency: "USD",
				grossMicros: "191000000",
				refundedMicros: "1500000",
				netMicros: "189500000",
				orders: 3,
			},
		]);
		expect(overview.coverage.excludedTestPayments).toBe(1);
		expect(overview.openTickets).toBe(3);
	});

	it("never reads another tenant's payment, source, or ticket when applying organization/user scopes", async () => {
		const org = { kind: "organization" as const, organizationId: "org-a" };
		const orgFacts = await readAdminAnalyticsFacts(query, org);
		expect(orgFacts.users.map((user) => user.id)).toEqual(["a"]);
		expect(orgFacts.payments.map((payment) => payment.id)).toEqual(["pack:p-org"]);
		expect(
			buildAdminAnalyticsFunnel(orgFacts, { scope: org, range: "7d", groupBy: "utm_term", now })
				.totals,
		).toEqual({ signups: 1, checkouts: 1, paid: 1 });
		expect(orgFacts.openTickets).toBe(1);
		const person = { kind: "user" as const, userId: "a" };
		const personalFacts = await readAdminAnalyticsFacts(query, person);
		expect(
			personalFacts.payments.every(
				(payment) => payment.ownerType === "USER" && payment.ownerId === "a",
			),
		).toBe(true);
		expect(personalFacts.openTickets).toBe(1);
		const report = buildAdminAnalyticsReport(personalFacts, {
			scope: person,
			from: new Date("2026-10-19T08:00:00+08:00"),
			to: now,
			now,
			compare: false,
		});
		expect(report.current.payments.revenue[0]?.netMicros).toBe("101500000");
	});

	it("uses frozen new-checkout evidence for PayPal/Waffo first payments while preserving historical unknowns", async () => {
		await client!.query("BEGIN");
		try {
			for (const provider of ["paypal", "waffo"] as const) {
				const initialEvidence = {
					version: 1,
					checkoutIntentId: `checkout-${provider}`,
					periodStart: "2026-10-19T00:00:00.000Z",
					periodEnd: "2026-11-19T00:00:00.000Z",
					providerPaymentId: `first-${provider}`,
				};
				await client!.query(
					`INSERT INTO "subscription" VALUES ($1,$2,$3,'USER','a','ACTIVE','2026-10-19','2026-12-19',null,null,$4)`,
					[`sub-${provider}`, provider, `psp-${provider}`, JSON.stringify(initialEvidence)],
				);
				await client!.query(
					`INSERT INTO "payment_checkout_intent" VALUES ($1,$2,'USER','a','a','2026-10-19','PLAN',$3,$4)`,
					[
						`checkout-${provider}`,
						provider,
						provider === "paypal" ? "psp-paypal" : null,
						provider === "waffo" ? "psp-waffo" : null,
					],
				);
				for (const kind of ["first", "renewal"]) {
					const paymentId = `${kind}-${provider}`;
					const stamp = kind === "first" ? "2026-10-19T00:00:00Z" : "2026-11-19T00:00:00Z";
					await client!.query(
						`INSERT INTO "billing_period" VALUES ($1,$2,$3,$4,$4,null,null,10000000)`,
						[`period-${paymentId}`, `sub-${provider}`, stamp, `${provider}:${paymentId}`],
					);
					const envelope =
						provider === "paypal"
							? {
									event_type: "PAYMENT.SALE.COMPLETED",
									resource: {
										id: paymentId,
										billing_agreement_id: `psp-${provider}`,
										amount: { total: "10.00", currency: "USD" },
										create_time: stamp,
									},
								}
							: {
									eventType: "subscription.payment_succeeded",
									mode: "prod",
									timestamp: stamp,
									data: { paymentId, orderId: `psp-${provider}`, amount: "10.00", currency: "USD" },
								};
					await client!.query(
						`INSERT INTO "payment_event" VALUES ($1,$2,$3,'PROCESSED',$4,$5,$6)`,
						[
							`event-${paymentId}`,
							provider,
							provider === "paypal" ? "live" : "prod",
							stamp,
							paymentId,
							JSON.stringify(envelope),
						],
					);
				}
			}
			const data = await readAdminAnalyticsFacts(query, { kind: "user", userId: "a" });
			for (const provider of ["paypal", "waffo"]) {
				expect(
					data.payments.find((payment) => payment.id === `plan:period-first-${provider}`),
				).toMatchObject({ renewal: false, environment: "production" });
				expect(
					data.payments.find((payment) => payment.id === `plan:period-renewal-${provider}`),
				).toMatchObject({ renewal: true, environment: "production" });
			}
			await client!.query(
				`UPDATE "subscription" SET "initialPaymentEvidence" = null WHERE id = 'sub-paypal'`,
			);
			const historical = await readAdminAnalyticsFacts(query, { kind: "user", userId: "a" });
			expect(
				historical.payments.find((payment) => payment.id === "plan:period-first-paypal")?.renewal,
			).toBeNull();
		} finally {
			await client!.query("ROLLBACK");
		}
	});
});
