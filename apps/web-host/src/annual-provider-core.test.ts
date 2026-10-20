import { describe, expect, it } from "vitest";

import {
	assertAllowedProviderRequest,
	createProviderPort,
	paypalCreateBody,
} from "./annual-provider-adapters";
import {
	ANNUAL_TIERS,
	AnnualOperationError,
	auditAnnualProviders,
	safeFailure,
	targetName,
	type Data,
	type ProviderPort,
} from "./annual-provider-core";

function fixtures() {
	const environment: Record<string, string> = {
		WAFFO_ENVIRONMENT: "prod",
		PAYPAL_ENVIRONMENT: "live",
		WAFFO_STORE_ID: "STO_FIXTURE",
	};
	const waffo: Data[] = [];
	const paypal = new Map<string, Data>();
	for (const tier of ANNUAL_TIERS) {
		const suffix = tier.key.toUpperCase();
		const productId = `PROD-FIXTURE${suffix}`;
		const waffoMonthly = `PROD_MONTHLY${suffix}`;
		const paypalMonthly = `P-MONTHLY${suffix}`;
		environment[`WAFFO_PRODUCT_ID_${suffix}_MONTHLY`] = waffoMonthly;
		environment[`WAFFO_PRODUCT_ID_${suffix}_YEARLY`] = tier.waffo;
		environment[`PAYPAL_PLAN_ID_${suffix}_MONTHLY`] = paypalMonthly;
		environment[`PAYPAL_PLAN_ID_${suffix}_YEARLY`] = tier.paypal;
		for (const [id, price, period] of [
			[waffoMonthly, tier.monthly, "monthly"],
			[tier.waffo, tier.previous, "yearly"],
		] as const) {
			waffo.push({
				id,
				name: id,
				status: "active",
				hasProdVersion: true,
				versions: [
					{
						name: id,
						versionNumber: 1,
						billingPeriod: period,
						isProdVersion: true,
						isTestVersion: true,
						metadata: { unrelatedPrivateMetadata: "MUST_NOT_PRINT" },
						prices: [
							{
								currency: "USD",
								priceInfo: { amount: `${price / 100}.00`, taxCategory: "saas", trialAmount: null },
							},
						],
					},
				],
			});
		}
		for (const [id, price, period] of [
			[paypalMonthly, tier.monthly, "MONTH"],
			[tier.paypal, tier.previous, "YEAR"],
		] as const) {
			paypal.set(id, {
				id,
				product_id: productId,
				name: id,
				status: "ACTIVE",
				billing_cycles: [
					{
						frequency: { interval_unit: period, interval_count: 1 },
						tenure_type: "REGULAR",
						sequence: 1,
						total_cycles: 0,
						pricing_scheme: { fixed_price: { value: `${price / 100}.00`, currency_code: "USD" } },
					},
				],
				payment_preferences: {
					auto_bill_outstanding: true,
					setup_fee: { value: "0.00", currency_code: "USD" },
					setup_fee_failure_action: "CANCEL",
					payment_failure_threshold: 3,
				},
				links: [{ href: "PRIVATE_PAYLOAD" }],
			});
		}
	}
	const reads: string[] = [];
	const port: ProviderPort = {
		async waffoCatalog() {
			reads.push("waffo-catalog");
			return {
				store: { id: "STO_FIXTURE", name: "EzPic", status: "active", private: "SECRET" },
				products: waffo,
				schemaFields: {},
			};
		},
		async paypalPlan(id) {
			reads.push(`paypal-plan:${id}`);
			const plan = paypal.get(id);
			if (!plan) throw new Error("SECRET");
			return plan;
		},
		async paypalPlans(productId) {
			reads.push(`paypal-list:${productId}`);
			return [...paypal.values()].filter((plan) => plan.product_id === productId);
		},
	};
	return { environment, port, waffo, paypal, reads };
}

describe("annual provider audit", () => {
	it("reads both providers, certifies unchanged monthly terms, and prints only allowed evidence", async () => {
		const fixture = fixtures();
		const result = await auditAnnualProviders(fixture.environment, fixture.port);
		expect(result.ready).toBe(true);
		expect(result.tiers.map((tier) => tier.monthlyCredits)).toEqual([700, 1800, 3000]);
		expect(result.tiers.map((tier) => tier.paypal.monthly.billingCycles[0]?.amountMinor)).toEqual([
			1900, 4900, 7900,
		]);
		expect(
			result.tiers.map((tier) => tier.waffo.previousAnnual.production?.prices[0]?.amountMinor),
		).toEqual([19000, 49000, 79000]);
		expect(JSON.stringify(result)).not.toMatch(
			/SECRET|MUST_NOT_PRINT|PRIVATE_PAYLOAD|links|unrelatedPrivateMetadata/,
		);
		expect(fixture.reads.filter((entry) => entry.startsWith("paypal-list"))).toHaveLength(3);
	});
	it("rejects monthly price, finite annual cycles, trials and setup fees", async () => {
		const fixture = fixtures();
		const monthly = fixture.paypal.get("P-MONTHLYCREATOR")!;
		(monthly.billing_cycles as Data[])[0]!.total_cycles = 12;
		const annual = fixture.waffo.find((product) => product.id === ANNUAL_TIERS[1].waffo)!;
		((annual.versions as Data[])[0]!.metadata as Data).trialDays = 7;
		const result = await auditAnnualProviders(fixture.environment, fixture.port);
		expect(result.ready).toBe(false);
		expect(result.issues).toContain("PAYPAL_MONTHLY_CREATOR_INVALID");
		expect(result.issues).toContain("WAFFO_OLD_ANNUAL_ULTIMATE_INVALID");
	});
	it("does not substitute test terms for production terms", async () => {
		const fixture = fixtures();
		const annual = fixture.waffo.find((product) => product.id === ANNUAL_TIERS[0].waffo)!;
		const version = (annual.versions as Data[])[0]!;
		version.isProdVersion = false;
		const result = await auditAnnualProviders(fixture.environment, fixture.port);
		expect(result.issues).toContain("WAFFO_OLD_ANNUAL_CREATOR_INVALID");
		expect(result.tiers[0]?.waffo.previousAnnual.production).toBeNull();
	});
	it("detects ambiguous targets and checks real candidate terms", async () => {
		const fixture = fixtures();
		const tier = ANNUAL_TIERS[0];
		for (let i = 0; i < 2; i++)
			fixture.paypal.set(`P-NEW${i}`, {
				...paypalCreateBody(tier, "PROD-FIXTURECREATOR"),
				id: `P-NEW${i}`,
			});
		const result = await auditAnnualProviders(fixture.environment, fixture.port);
		expect(result.issues).toContain("TARGET_CREATOR_AMBIGUOUS");
	});
	it("never serializes raw errors or error messages", () => {
		expect(safeFailure(new Error("Authorization Bearer TOP_SECRET"))).toEqual({
			code: "PROVIDER_OPERATION_FAILED",
		});
		expect(
			safeFailure(new AnnualOperationError("PAYPAL_REQUEST_FAILED", 403, "debug-123")),
		).toEqual({ code: "PAYPAL_REQUEST_FAILED", status: 403, requestId: "debug-123" });
		expect(
			JSON.stringify(safeFailure(new AnnualOperationError("FAILED", 500, "Authorization: SECRET"))),
		).not.toContain("SECRET");
	});
});

describe("provider request fence", () => {
	const base = {
		mode: "prepare" as const,
		allowedGraphql: new Set(["query Approved { stores { id } }"]),
		writableWaffoIds: new Set(["PROD_NEW"]),
		paypalProductIds: new Set(["PROD-EXISTING"]),
	};
	it.each([
		["POST", "https://api-m.paypal.com/v1/billing/subscriptions", {}],
		["POST", "https://api-m.paypal.com/v2/checkout/orders", {}],
		["POST", "https://api.waffo.ai/v1/actions/auth/issue-session-token", {}],
		["POST", "https://api.waffo.ai/v1/actions/subscription-product/update-product", {}],
		["POST", "https://evil.test/v1/graphql", { query: "query Approved { stores { id } }" }],
		["POST", "https://api.waffo.ai/v1/graphql", { query: "query { customers { email } }" }],
		[
			"POST",
			"https://api.waffo.ai/v1/actions/subscription-product/publish-product",
			{ id: ANNUAL_TIERS[0].waffo },
		],
	])("blocks %s %s", (method, url, body) => {
		expect(() => assertAllowedProviderRequest({ ...base, method, url, body })).toThrow(
			"REQUEST_NOT_ALLOWED",
		);
	});
	it("blocks all catalog writes in audit mode", () => {
		expect(() =>
			assertAllowedProviderRequest({
				...base,
				mode: "audit",
				method: "POST",
				url: "https://api-m.paypal.com/v1/billing/plans",
				body: paypalCreateBody(ANNUAL_TIERS[0], "PROD-EXISTING"),
			}),
		).toThrow("REQUEST_NOT_ALLOWED");
	});
	it("permits exactly the fixed recurring 114/294/474 USD plans", () => {
		for (const tier of ANNUAL_TIERS) {
			const body = paypalCreateBody(tier, "PROD-EXISTING");
			expect(() =>
				assertAllowedProviderRequest({
					...base,
					method: "POST",
					url: "https://api-m.paypal.com/v1/billing/plans",
					body,
				}),
			).not.toThrow();
			(body.billing_cycles as Data[])[0]!.total_cycles = 1;
			expect(() =>
				assertAllowedProviderRequest({
					...base,
					method: "POST",
					url: "https://api-m.paypal.com/v1/billing/plans",
					body,
				}),
			).toThrow("REQUEST_NOT_ALLOWED");
		}
	});
	it("gets PayPal candidate details rather than using list summaries", async () => {
		const fixture = fixtures();
		const tier = ANNUAL_TIERS[0];
		const calls: string[] = [];
		const productId = "PROD-EXISTING";
		const detail = { ...paypalCreateBody(tier, productId), id: "P-NEW123" };
		const port = createProviderPort(
			{
				...fixture.environment,
				PAYPAL_CLIENT_ID: "secret-client",
				PAYPAL_CLIENT_SECRET: "secret-token",
			},
			"audit",
			{
				waffoClient: {
					graphql: {
						async query() {
							return {};
						},
					},
					subscriptionProducts: {
						async create() {
							throw new Error();
						},
						async publish() {},
						async updateStatus() {},
					},
				},
				fetch: async (input) => {
					const url =
						typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
					calls.push(url);
					if (url.endsWith("/oauth2/token"))
						return Response.json({ access_token: "secret-access" });
					if (url.endsWith("/plans/P-NEW123")) return Response.json(detail);
					return Response.json({
						plans: [{ id: "P-NEW123", name: targetName(tier) }],
						total_pages: 1,
						total_items: 1,
					});
				},
			},
		);
		await port.paypalPlan("P-NEW123"); // Establish authenticated existing product identity.
		const plans = await port.paypalPlans(productId);
		expect(plans).toEqual([detail]);
		expect(calls.filter((url) => url.endsWith("/plans/P-NEW123"))).toHaveLength(2);
	});
});
