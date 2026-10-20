import { describe, expect, it } from "vitest";

import { assertAllowedProviderRequest, createProviderPort } from "./annual-provider-adapters";
import { ANNUAL_TIERS, type AnnualTier, type Data } from "./annual-provider-core";
import {
	auditWaffoAnnualVersions,
	decodeVersionBaseline,
	encodeVersionBaseline,
	updateWaffoAnnualProductionVersions,
	type VersionReceipt,
	type WaffoVersionPort,
} from "./annual-provider-versions";

function fixture() {
	const environment: Record<string, string> = {
		WAFFO_ENVIRONMENT: "prod",
		WAFFO_STORE_ID: "STO_FIXTURE",
	};
	const products: Data[] = [];
	const calls: string[] = [];
	const receipts: VersionReceipt[] = [];
	for (const tier of ANNUAL_TIERS) {
		const monthlyId = `PROD_MONTHLY_${tier.key}`;
		environment[`WAFFO_PRODUCT_ID_${tier.key.toUpperCase()}_MONTHLY`] = monthlyId;
		for (const monthly of [false, true]) {
			const id = monthly ? monthlyId : tier.waffo;
			products.push({
				id,
				name: `EzPic ${tier.label}`,
				status: "active",
				hasProdVersion: true,
				versions: [
					{
						id: `VERSION_OLD_${id}`,
						versionNumber: 1,
						name: `EzPic ${tier.label}`,
						billingPeriod: monthly ? "monthly" : "yearly",
						metadata: {},
						prices: [
							{
								currency: "USD",
								priceInfo: {
									amount: `${(monthly ? tier.monthly : tier.previous) / 100}.00`,
									taxCategory: "saas",
									trialAmount: null,
								},
							},
						],
						isProdVersion: true,
						isTestVersion: true,
					},
				],
			});
		}
	}
	const targetId = (tier: AnnualTier) => `VERSION_NEW_${tier.key}`;
	const product = (tier: AnnualTier) => products.find((entry) => entry.id === tier.waffo)!;
	const port: WaffoVersionPort = {
		async waffoCatalog() {
			calls.push("read");
			return {
				store: { id: "STO_FIXTURE", status: "active", prodEnabled: true, payinEnable: true },
				products: structuredClone(products),
				schemaFields: {},
			};
		},
		async waffoUpdateProductionVersion(tier, previousId) {
			calls.push(`update:${tier.key}`);
			const versions = product(tier).versions as Data[];
			const current = versions.find((version) => version.isProdVersion)!;
			expect(current.id).toBe(previousId);
			const next = structuredClone(current);
			current.isProdVersion = false;
			next.id = targetId(tier);
			next.versionNumber = 2;
			next.isProdVersion = true;
			next.isTestVersion = false;
			((next.prices as Data[])[0]!.priceInfo as Data).amount = `${tier.annual / 100}.00`;
			versions.push(next);
		},
	};
	return {
		environment,
		products,
		calls,
		receipts,
		port,
		targetId,
		product,
		onReceipt: (receipt: VersionReceipt) => receipts.push(receipt),
	};
}
async function baseline(f: ReturnType<typeof fixture>) {
	return decodeVersionBaseline(
		(await auditWaffoAnnualVersions(f.environment, f.port)).encodedBaseline!,
	);
}

describe("same-product production annual version update", () => {
	it("audits real current production IDs and does not fabricate a staging or publication step", async () => {
		const f = fixture();
		const audit = await auditWaffoAnnualVersions(f.environment, f.port);
		expect(audit.ready).toBe(true);
		expect(f.calls).toEqual(["read"]);
		for (const tier of ANNUAL_TIERS)
			expect(decodeVersionBaseline(audit.encodedBaseline!)[tier.key]).toEqual({
				productId: tier.waffo,
				previousVersionId: `VERSION_OLD_${tier.waffo}`,
				previousVersionNumber: 1,
			});
	});
	it("updates only three old products, retains old immutable version prices and test versions, and preserves monthly terms", async () => {
		const f = fixture();
		const old = structuredClone(f.products);
		const before = await baseline(f);
		const result = await updateWaffoAnnualProductionVersions(f.environment, f.port, before, {
			onReceipt: f.onReceipt,
		});
		expect(result.productionUpdated).toBe(true);
		expect(f.calls.filter((call) => call.startsWith("update:"))).toHaveLength(3);
		for (const tier of ANNUAL_TIERS) {
			const versions = f.product(tier).versions as Data[];
			const previous = versions.find(
				(version) => version.id === before[tier.key].previousVersionId,
			)!;
			expect(((previous.prices as Data[])[0]!.priceInfo as Data).amount).toBe(
				`${tier.previous / 100}.00`,
			);
			expect(previous.isTestVersion).toBe(true);
			expect(versions.find((version) => version.isProdVersion)?.id).toBe(f.targetId(tier));
			const binding = result.bindings.find((entry) => entry.plan === tier.key)!;
			expect(binding.providerPriceId).toBe(`waffo:${tier.waffo}:${f.targetId(tier)}`);
			expect(binding.metadata).toEqual({
				waffoProductId: tier.waffo,
				waffoProductVersionId: f.targetId(tier),
				waffoProductVersionNumber: 2,
				waffoTaxCategory: "saas",
			});
		}
		expect(f.products.filter((entry) => String(entry.id).startsWith("PROD_MONTHLY"))).toEqual(
			old.filter((entry) => String(entry.id).startsWith("PROD_MONTHLY")),
		);
	});
	it("replays against the original audit baseline with zero additional production updates", async () => {
		const f = fixture();
		const before = await baseline(f);
		const first = await updateWaffoAnnualProductionVersions(f.environment, f.port, before);
		const replay = await updateWaffoAnnualProductionVersions(f.environment, f.port, before, {
			priorAttempts: new Set(["waffo:creator", "waffo:ultimate", "waffo:studio"]),
		});
		expect(replay.bindings).toEqual(first.bindings);
		expect(f.calls.filter((call) => call.startsWith("update:"))).toHaveLength(3);
		expect((await auditWaffoAnnualVersions(f.environment, f.port)).encodedBaseline).toBeNull();
	});
	it("checks every baseline and monthly price before the first production write", async () => {
		const f = fixture();
		const before = await baseline(f);
		(f.products.at(-1)!.versions as Data[])[0]!.billingPeriod = "weekly";
		await expect(
			updateWaffoAnnualProductionVersions(f.environment, f.port, before),
		).rejects.toThrow("WAFFO_MONTHLY_CHANGED");
		expect(f.calls.some((call) => call.startsWith("update:"))).toBe(false);
	});
	it("will not fabricate a missing old version identity", async () => {
		const f = fixture();
		delete (f.product(ANNUAL_TIERS[1]).versions as Data[])[0]!.id;
		const audit = await auditWaffoAnnualVersions(f.environment, f.port);
		expect(audit.ready).toBe(false);
		expect(audit.encodedBaseline).toBeNull();
		expect(f.calls).toEqual(["read"]);
	});
	it("queries uncertain updates and never repeats an unresolved prior version creation", async () => {
		const f = fixture();
		const before = await baseline(f);
		f.port.waffoUpdateProductionVersion = async (tier) => {
			f.calls.push(`update:${tier.key}`);
			throw new Error("SECRET_AUTH_HEADER");
		};
		await expect(
			updateWaffoAnnualProductionVersions(f.environment, f.port, before, {
				onReceipt: f.onReceipt,
			}),
		).rejects.toThrow("WAFFO_UPDATE_VERSION_UNCERTAIN");
		expect(f.calls.at(-1)).toBe("read");
		expect(f.receipts.at(-1)?.phase).toBe("UNCERTAIN");
		expect(JSON.stringify(f.receipts)).not.toContain("SECRET_AUTH_HEADER");
		await expect(
			updateWaffoAnnualProductionVersions(f.environment, f.port, before, {
				priorAttempts: new Set(["waffo:creator"]),
			}),
		).rejects.toThrow("WAFFO_PRIOR_UPDATE_UNRESOLVED");
		expect(f.calls.filter((call) => call === "update:creator")).toHaveLength(1);
	});
	it("recovers an accepted timeout only from the real new production version", async () => {
		const f = fixture();
		const before = await baseline(f);
		const update = f.port.waffoUpdateProductionVersion.bind(f.port);
		f.port.waffoUpdateProductionVersion = async (tier, previousId) => {
			await update(tier, previousId);
			if (tier.key === "creator") throw new Error("private");
		};
		const result = await updateWaffoAnnualProductionVersions(f.environment, f.port, before, {
			onReceipt: f.onReceipt,
		});
		expect(result.ready).toBe(true);
		expect(
			f.receipts.some((receipt) => receipt.plan === "creator" && receipt.phase === "RECOVERED"),
		).toBe(true);
		expect(f.calls.filter((call) => call === "update:creator")).toHaveLength(1);
	});
	it("does not accept a test-only update as production success", async () => {
		const f = fixture();
		const before = await baseline(f);
		const update = f.port.waffoUpdateProductionVersion.bind(f.port);
		f.port.waffoUpdateProductionVersion = async (tier, previousId) => {
			await update(tier, previousId);
			const versions = f.product(tier).versions as Data[];
			versions.forEach((version) => {
				version.isProdVersion = version.id === previousId;
				version.isTestVersion = version.id === f.targetId(tier);
			});
		};
		await expect(
			updateWaffoAnnualProductionVersions(f.environment, f.port, before),
		).rejects.toThrow("WAFFO_UPDATE_VERSION_UNCERTAIN");
		expect(f.calls.filter((call) => call.startsWith("update:"))).toEqual(["update:creator"]);
	});
	it("rejects a changed actual production baseline before any write", async () => {
		const f = fixture();
		const before = await baseline(f);
		const versions = f.product(ANNUAL_TIERS[2]).versions as Data[];
		const next = structuredClone(versions[0]!);
		versions[0]!.isProdVersion = false;
		next.id = "DIFFERENT_VERSION";
		next.versionNumber = 2;
		next.isTestVersion = false;
		versions.push(next);
		await expect(
			updateWaffoAnnualProductionVersions(f.environment, f.port, before),
		).rejects.toThrow("WAFFO_PRODUCTION_VERSION_CHANGED");
		expect(f.calls.some((call) => call.startsWith("update:"))).toBe(false);
	});
	it("rejects a modified baseline product scope", async () => {
		const f = fixture();
		const before = await baseline(f);
		before.creator.productId = "PROD_NOT_IN_SCOPE";
		expect(() => decodeVersionBaseline(encodeVersionBaseline(before))).toThrow(
			"WAFFO_VERSION_BASELINE_INVALID",
		);
	});
});
describe("count-only supplier usage inspection", () => {
	function nativePort(filterSupported: boolean) {
		const f = fixture();
		const documents: string[] = [];
		const counts: Data[] = [];
		const named = (name: string) => ({ name });
		const fields = (entries: Record<string, string>) =>
			Object.entries(entries).map(([name, type]) => ({ name, type: named(type) }));
		const client = {
			graphql: {
				async query(input: { query: string; variables?: Data }) {
					documents.push(input.query);
					if (input.query.includes("AnnualCatalogSchema"))
						return {
							data: {
								__schema: {
									queryType: {
										fields: [
											{
												name: "subscriptionProducts",
												type: named("SubscriptionProduct"),
												args: [],
											},
											{
												name: "subscriptionProductVersions",
												type: named("SubscriptionProductVersion"),
												args: [],
											},
											{ name: "subscriptionProductsCount", type: named("Int"), args: [] },
											{
												name: "subscriptionOrdersCount",
												type: named("Int"),
												args: fields({ storeId: "String", filter: "SubscriptionOrderFilter" }),
											},
										],
									},
								},
							},
						};
					if (input.query.includes("AnnualCatalogType")) {
						const types: Record<string, Record<string, string>> = {
							SubscriptionProduct: {
								id: "String",
								name: "String",
								status: "String",
								hasProdVersion: "Boolean",
							},
							SubscriptionProductVersion: {
								id: "String",
								name: "String",
								versionNumber: "Int",
								billingPeriod: "String",
								metadata: "String",
								isTestVersion: "Boolean",
								isProdVersion: "Boolean",
								prices: "SubscriptionCurrencyPrice",
							},
							SubscriptionCurrencyPrice: { currency: "String", priceInfo: "SubscriptionPriceInfo" },
							SubscriptionPriceInfo: {
								amount: "String",
								taxCategory: "String",
								trialAmount: "String",
							},
						};
						return { data: { __type: { fields: fields(types[String(input.variables?.name)]!) } } };
					}
					if (input.query.includes("AnnualCatalog("))
						return {
							data: {
								subscriptionProducts: structuredClone(f.products),
								subscriptionProductsCount: f.products.length,
							},
						};
					if (input.query.includes("AnnualStore"))
						return {
							data: {
								store: {
									id: "STO_FIXTURE",
									name: "EzPic",
									status: "active",
									prodEnabled: true,
									payinEnable: true,
								},
							},
						};
					if (input.query.includes("AnnualProductVersions"))
						return {
							data: {
								subscriptionProductVersions: structuredClone(
									f.products.find((product) => product.id === input.variables?.productId)!.versions,
								),
							},
						};
					if (input.query.includes("AnnualOrderFilter"))
						return {
							data: {
								__type: {
									inputFields:
										input.variables?.name === "SubscriptionOrderFilter"
											? fields(
													filterSupported
														? { subscriptionProductId: "StringFilter" }
														: { status: "StringFilter" },
												)
											: fields({ eq: "String" }),
								},
							},
						};
					if (input.query.includes("AnnualUnusedProductOrders")) {
						counts.push(input.variables!);
						return { data: { subscriptionOrdersCount: 0 } };
					}
					throw new Error("unexpected query");
				},
			},
			subscriptionProducts: {
				async create(): Promise<{ product: Data }> {
					throw new Error("write forbidden");
				},
				async publish() {
					throw new Error("write forbidden");
				},
				async updateStatus() {
					throw new Error("write forbidden");
				},
			},
		};
		const port = createProviderPort({ ...f.environment, PAYPAL_ENVIRONMENT: "live" }, "audit", {
			waffoClient: client,
		});
		return { f, port, documents, counts };
	}
	it("uses verified product equality filters and returns only counts without buyer fields", async () => {
		const f = nativePort(true);
		const audit = await auditWaffoAnnualVersions(f.f.environment, f.port);
		expect(audit.providerUsage.map((entry) => entry.subscriptionOrderCount)).toEqual([0, 0, 0]);
		expect(audit.providerUsage.every((entry) => entry.status === "VERIFIED")).toBe(true);
		expect(f.counts).toHaveLength(3);
		for (const variables of f.counts)
			expect(variables).toMatchObject({
				storeId: "STO_FIXTURE",
				filter: { subscriptionProductId: { eq: expect.stringMatching(/^PROD_/) } },
			});
		expect(
			f.documents
				.filter((document) => document.includes("AnnualUnusedProductOrders"))
				.every(
					(document) =>
						document.includes("subscriptionOrdersCount") &&
						!/buyer|email|subscriptionOrders\s*\(/i.test(document),
				),
		).toBe(true);
	});
	it("reports provider usage UNKNOWN if the native schema cannot filter by product", async () => {
		const f = nativePort(false);
		const audit = await auditWaffoAnnualVersions(f.f.environment, f.port);
		expect(
			audit.providerUsage.every(
				(entry) => entry.status === "UNKNOWN" && entry.subscriptionOrderCount === null,
			),
		).toBe(true);
		expect(f.counts).toEqual([]);
	});
});

describe("production update network fence", () => {
	const base = {
		allowedGraphql: new Set<string>(),
		writableWaffoIds: new Set<string>(),
		paypalProductIds: new Set<string>(),
	};
	it("permits only the exact price-only update of the three old IDs in explicit production-update mode", () => {
		for (const tier of ANNUAL_TIERS) {
			const body: Data = {
				id: tier.waffo,
				prices: { USD: { amount: `${tier.annual / 100}.00`, taxCategory: "saas" } },
			};
			const request = {
				...base,
				method: "POST",
				url: "https://api.waffo.ai/v1/actions/subscription-product/update-product",
				body,
			};
			expect(() =>
				assertAllowedProviderRequest({ ...request, mode: "waffo-update" }),
			).not.toThrow();
			expect(() => assertAllowedProviderRequest({ ...request, mode: "audit" })).toThrow(
				"REQUEST_NOT_ALLOWED",
			);
			body.id = "PROD_NOT_IN_SCOPE";
			expect(() => assertAllowedProviderRequest({ ...request, mode: "waffo-update" })).toThrow(
				"REQUEST_NOT_ALLOWED",
			);
		}
	});
	it("never publishes or creates products in production-update mode", () => {
		for (const path of ["publish-product", "create-product", "update-status"])
			expect(() =>
				assertAllowedProviderRequest({
					...base,
					method: "POST",
					url: `https://api.waffo.ai/v1/actions/subscription-product/${path}`,
					body: { id: ANNUAL_TIERS[0].waffo },
					mode: "waffo-update",
				}),
			).toThrow("REQUEST_NOT_ALLOWED");
	});
});
