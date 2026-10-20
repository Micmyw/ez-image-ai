import { describe, expect, it } from "vitest";

import { paypalCreateBody } from "./annual-provider-adapters";
import {
	ANNUAL_OPERATION,
	ANNUAL_TIERS,
	AnnualOperationError,
	type AnnualTier,
	type Data,
	targetName,
} from "./annual-provider-core";
import {
	parsePriorAttempts,
	prepareAnnualProviders,
	type OperationReceipt,
	type PreparationPort,
} from "./annual-provider-prepare";

function fixture(options: { existing?: boolean; oldNames?: boolean } = {}) {
	const environment: Record<string, string> = {
		WAFFO_ENVIRONMENT: "prod",
		PAYPAL_ENVIRONMENT: "live",
		WAFFO_STORE_ID: "STO_FIXTURE",
	};
	const products: Data[] = [];
	const plans: Data[] = [];
	const calls: string[] = [];
	const receipts: OperationReceipt[] = [];
	const newWaffoId = (tier: AnnualTier) => `PROD_${tier.key.padEnd(22, "0")}`;
	const newPayPalId = (tier: AnnualTier) => `P-NEW${tier.key.toUpperCase()}`;
	const addWaffo = (tier: AnnualTier, target: boolean, prod = true, monthly = false) => {
		const name =
			target && !options.oldNames
				? targetName(tier)
				: `EzPic ${tier.label} ${monthly ? "Monthly" : "Annual"}`;
		const id = target ? newWaffoId(tier) : monthly ? `PROD_MONTHLY${tier.key}` : tier.waffo;
		const metadata =
			target && !options.oldNames
				? { operation: ANNUAL_OPERATION, previousProductId: tier.waffo }
				: {};
		const product: Data = {
			id,
			name,
			status: prod ? "active" : "inactive",
			hasProdVersion: prod,
			versions: [
				{
					versionNumber: 1,
					name,
					billingPeriod: monthly ? "monthly" : "yearly",
					metadata,
					prices: [
						{
							currency: "USD",
							priceInfo: {
								amount: `${(target ? tier.annual : monthly ? tier.monthly : tier.previous) / 100}.00`,
								taxCategory: "saas",
								trialAmount: null,
							},
						},
					],
					isTestVersion: true,
					isProdVersion: prod,
				},
			],
		};
		products.push(product);
		return product;
	};
	const addPaypal = (tier: AnnualTier, target: boolean, monthly = false) => {
		const plan: Data = {
			...paypalCreateBody(tier, `PROD-${tier.key.toUpperCase()}`),
			id: target ? newPayPalId(tier) : monthly ? `P-MONTHLY${tier.key.toUpperCase()}` : tier.paypal,
			name:
				target && !options.oldNames
					? targetName(tier)
					: `EzPic ${tier.label} ${monthly ? "Monthly" : "Yearly"}`,
		};
		const cycle = (plan.billing_cycles as Data[])[0]!;
		(cycle.frequency as Data).interval_unit = monthly ? "MONTH" : "YEAR";
		((cycle.pricing_scheme as Data).fixed_price as Data).value =
			`${(target ? tier.annual : monthly ? tier.monthly : tier.previous) / 100}.00`;
		plans.push(plan);
		return plan;
	};
	for (const tier of ANNUAL_TIERS) {
		const suffix = tier.key.toUpperCase();
		environment[`WAFFO_PRODUCT_ID_${suffix}_MONTHLY`] = `PROD_MONTHLY${tier.key}`;
		environment[`WAFFO_PRODUCT_ID_${suffix}_YEARLY`] = tier.waffo;
		environment[`PAYPAL_PLAN_ID_${suffix}_MONTHLY`] = `P-MONTHLY${suffix}`;
		environment[`PAYPAL_PLAN_ID_${suffix}_YEARLY`] = tier.paypal;
		addWaffo(tier, false, true, true);
		addWaffo(tier, false);
		addPaypal(tier, false, true);
		addPaypal(tier, false);
		if (options.existing) {
			addWaffo(tier, true);
			addPaypal(tier, true);
		}
	}
	const port: PreparationPort = {
		async waffoCatalog() {
			calls.push("waffo-read");
			return {
				store: {
					id: "STO_FIXTURE",
					name: "EzPic",
					status: "active",
					prodEnabled: true,
					payinEnable: true,
				},
				products: structuredClone(products),
				schemaFields: {},
			};
		},
		async paypalPlan(id) {
			calls.push(`paypal-read:${id}`);
			const plan = plans.find((entry) => entry.id === id);
			if (!plan) throw new Error("SECRET");
			return structuredClone(plan);
		},
		async paypalPlans(productId) {
			calls.push(`paypal-list:${productId}`);
			return structuredClone(plans.filter((plan) => plan.product_id === productId));
		},
		async waffoCreate(tier) {
			calls.push(`waffo-create:${tier.key}`);
			return String(addWaffo(tier, true, false).id);
		},
		async waffoAuthorizeTarget(id) {
			calls.push(`waffo-authorize:${id}`);
		},
		async waffoPublish(id) {
			calls.push(`waffo-publish:${id}`);
			const product = products.find((entry) => entry.id === id)!;
			(product.versions as Data[])[0]!.isProdVersion = true;
			product.hasProdVersion = true;
		},
		async waffoActivate(id) {
			calls.push(`waffo-activate:${id}`);
			products.find((entry) => entry.id === id)!.status = "active";
		},
		async paypalCreate(tier) {
			calls.push(`paypal-create:${tier.key}`);
			return String(addPaypal(tier, true).id);
		},
	};
	return {
		environment,
		products,
		plans,
		calls,
		port,
		receipts,
		addWaffo,
		addPaypal,
		newWaffoId,
		newPayPalId,
		onReceipt: (receipt: OperationReceipt) => receipts.push(receipt),
	};
}

describe("controlled annual provider preparation", () => {
	it("audits first, creates at most three each, verifies writes, and preserves all old and monthly products", async () => {
		const f = fixture();
		const oldProducts = structuredClone(f.products);
		const oldPlans = structuredClone(f.plans);
		const result = await prepareAnnualProviders(f.environment, f.port, { onReceipt: f.onReceipt });
		expect(result.ready).toBe(true);
		expect(result.bindings).toHaveLength(3);
		expect(f.calls.filter((call) => call.startsWith("waffo-create"))).toHaveLength(3);
		expect(f.calls.filter((call) => call.startsWith("paypal-create"))).toHaveLength(3);
		const firstWrite = f.calls.findIndex((call) => call.startsWith("waffo-create"));
		expect(
			f.calls.slice(0, firstWrite).filter((call) => call.startsWith("paypal-list")),
		).toHaveLength(3);
		expect(f.calls[firstWrite - 1]).toBe("waffo-read");
		expect(f.products.slice(0, 6)).toEqual(oldProducts);
		expect(f.plans.slice(0, 6)).toEqual(oldPlans);
		for (const tier of ANNUAL_TIERS) {
			expect(f.calls).toContain(`waffo-publish:${f.newWaffoId(tier)}`);
			expect(f.calls).not.toContain(`waffo-publish:${tier.waffo}`);
		}
		expect(result.attempted.sort()).toEqual([
			"paypal:creator",
			"paypal:studio",
			"paypal:ultimate",
			"waffo:creator",
			"waffo:studio",
			"waffo:ultimate",
		]);
		expect(
			f.receipts.filter(
				(receipt) => receipt.action === "CREATE" && receipt.phase === "ATTEMPT_STARTED",
			),
		).toHaveLength(6);
	});
	it("replays with zero writes and reuses exact products with older names and verified identity", async () => {
		const f = fixture({ existing: true, oldNames: true });
		const result = await prepareAnnualProviders(f.environment, f.port);
		expect(result.ready).toBe(true);
		expect(f.calls.some((call) => /create|publish|activate/.test(call))).toBe(false);
		expect(result.receipts).toEqual([]);
	});
	it("uncertain creation queries once, emits redacted uncertainty, and prior attempts prevent duplicate creation", async () => {
		const f = fixture();
		f.port.waffoCreate = async () => {
			f.calls.push("waffo-create:creator");
			throw new Error("Authorization: PRIVATE_TOKEN");
		};
		await expect(
			prepareAnnualProviders(f.environment, f.port, { onReceipt: f.onReceipt }),
		).rejects.toThrow("WAFFO_CREATE_UNCERTAIN");
		expect(f.calls.filter((call) => call === "waffo-create:creator")).toHaveLength(1);
		expect(f.calls.at(-1)).toBe("waffo-read");
		expect(f.receipts.at(-1)?.phase).toBe("UNCERTAIN");
		expect(JSON.stringify(f.receipts)).not.toContain("PRIVATE_TOKEN");
		await expect(
			prepareAnnualProviders(f.environment, f.port, {
				priorAttempts: parsePriorAttempts("waffo:creator"),
			}),
		).rejects.toThrow("WAFFO_PRIOR_CREATE_UNRESOLVED");
		expect(f.calls.filter((call) => call === "waffo-create:creator")).toHaveLength(1);
	});
	it("recovers accepted but timed out creation by query without creating again", async () => {
		const f = fixture();
		const create = f.port.waffoCreate!.bind(f.port);
		f.port.waffoCreate = async (tier, previous) => {
			const id = await create(tier, previous);
			if (tier.key === "creator") throw new AnnualOperationError("WAFFO_CREATE_UNCERTAIN");
			return id;
		};
		const result = await prepareAnnualProviders(f.environment, f.port, { onReceipt: f.onReceipt });
		expect(result.ready).toBe(true);
		expect(f.calls.filter((call) => call === "waffo-create:creator")).toHaveLength(1);
		expect(
			f.receipts.some(
				(receipt) =>
					receipt.provider === "waffo" &&
					receipt.plan === "creator" &&
					receipt.phase === "RECOVERED",
			),
		).toBe(true);
	});
	it("keeps unresolved PayPal creation blocked on resume", async () => {
		const f = fixture({ existing: true });
		f.plans.splice(
			f.plans.findIndex((plan) => plan.id === f.newPayPalId(ANNUAL_TIERS[0])),
			1,
		);
		f.port.paypalCreate = async () => {
			f.calls.push("paypal-create:creator");
			throw new Error("secret");
		};
		await expect(
			prepareAnnualProviders(f.environment, f.port, { onReceipt: f.onReceipt }),
		).rejects.toThrow("PAYPAL_CREATE_UNCERTAIN");
		await expect(
			prepareAnnualProviders(f.environment, f.port, {
				priorAttempts: parsePriorAttempts("paypal:creator"),
			}),
		).rejects.toThrow("PAYPAL_PRIOR_CREATE_UNRESOLVED");
		expect(f.calls.filter((call) => call === "paypal-create:creator")).toHaveLength(1);
	});
	it("resumes an owned verified Waffo draft using only publish and activate", async () => {
		const f = fixture({ existing: true });
		const tier = ANNUAL_TIERS[0];
		const target = f.products.find((product) => product.id === f.newWaffoId(tier))!;
		target.status = "inactive";
		target.hasProdVersion = false;
		(target.versions as Data[])[0]!.isProdVersion = false;
		const result = await prepareAnnualProviders(f.environment, f.port, {
			priorAttempts: parsePriorAttempts("waffo:creator"),
		});
		expect(result.ready).toBe(true);
		expect(f.calls).toContain(`waffo-authorize:${f.newWaffoId(tier)}`);
		expect(f.calls).toContain(`waffo-publish:${f.newWaffoId(tier)}`);
		expect(f.calls.some((call) => call.startsWith("waffo-create"))).toBe(false);
	});
	it("does not create when an existing exact-price Waffo product has unknown plan identity", async () => {
		const f = fixture({ existing: true });
		const target = f.products.find((product) => product.id === f.newWaffoId(ANNUAL_TIERS[0]))!;
		target.name = "Unrelated catalog product";
		const version = (target.versions as Data[])[0]!;
		version.name = target.name;
		version.metadata = {};
		await expect(prepareAnnualProviders(f.environment, f.port)).rejects.toThrow(
			"WAFFO_TARGET_IDENTITY_REQUIRES_REVIEW",
		);
		expect(f.calls.some((call) => /create|publish|activate/.test(call))).toBe(false);
	});
	it("uses production identity and does not borrow a matching test identity", async () => {
		const f = fixture({ existing: true, oldNames: true });
		const product = f.products.find((entry) => entry.id === f.newWaffoId(ANNUAL_TIERS[0]))!;
		const production = (product.versions as Data[])[0]!;
		production.name = "Unrelated product";
		production.isTestVersion = false;
		const testVersion = structuredClone(production);
		testVersion.isTestVersion = true;
		testVersion.isProdVersion = false;
		testVersion.name = "EzPic Pro Annual";
		testVersion.metadata = { previousProductId: ANNUAL_TIERS[0].waffo };
		(product.versions as Data[]).push(testVersion);
		await expect(prepareAnnualProviders(f.environment, f.port)).rejects.toThrow(
			"WAFFO_TARGET_IDENTITY_REQUIRES_REVIEW",
		);
		expect(f.calls.some((call) => /create|publish|activate/.test(call))).toBe(false);
	});
	it("verifies exact returned binding IDs again after all tiers, including legacy-named matches", async () => {
		const f = fixture({ existing: true, oldNames: true });
		const read = f.port.waffoCatalog.bind(f.port);
		let catalogs = 0;
		f.port.waffoCatalog = async () => {
			catalogs++;
			if (catalogs === 5)
				f.products.splice(
					f.products.findIndex((entry) => entry.id === f.newWaffoId(ANNUAL_TIERS[0])),
					1,
				);
			return read();
		};
		await expect(prepareAnnualProviders(f.environment, f.port)).rejects.toThrow(
			"PREPARED_BINDING_VERIFICATION_FAILED",
		);
		expect(f.calls.some((call) => /create|publish|activate/.test(call))).toBe(false);
	});

	it("stops before any writes if old PayPal non-price preferences differ from the audited threshold two", async () => {
		const f = fixture();
		const oldAnnual = f.plans.find((plan) => plan.id === ANNUAL_TIERS[2].paypal)!;
		(oldAnnual.payment_preferences as Data).payment_failure_threshold = 3;
		await expect(prepareAnnualProviders(f.environment, f.port)).rejects.toThrow(
			"PAYPAL_PREVIOUS_PREFERENCES_CHANGED",
		);
		expect(f.calls.some((call) => /create|publish|activate/.test(call))).toBe(false);
	});

	it("validates attempt keys and refuses an unsafe audit before any writes", async () => {
		expect(() => parsePriorAttempts("paypal:orders")).toThrow("PRIOR_ATTEMPTS_INVALID");
		expect(() => parsePriorAttempts("waffo:creator,waffo:creator")).toThrow(
			"PRIOR_ATTEMPTS_INVALID",
		);
		const f = fixture();
		(f.products[0]!.versions as Data[])[0]!.billingPeriod = "yearly";
		await expect(prepareAnnualProviders(f.environment, f.port)).rejects.toThrow("AUDIT_NOT_READY");
		expect(f.calls.some((call) => /create|publish|activate/.test(call))).toBe(false);
	});
});
