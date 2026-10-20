import { createRequire } from "node:module";

import {
	AnnualOperationError,
	ANNUAL_OPERATION,
	ANNUAL_TIERS,
	record,
	list,
	string,
	targetName,
	waffoEvidence,
	validWaffoTerms,
	shape,
	type DiagnosticEvidence,
	type AnnualTier,
	type Data,
	type WaffoCatalog,
} from "./annual-provider-core";
import type { PreparationPort } from "./annual-provider-prepare";

type GraphQL = {
	query(input: {
		query: string;
		variables?: Data;
	}): Promise<{ data?: unknown; errors?: unknown[] }>;
};
type WaffoClient = {
	graphql: GraphQL;
	subscriptionProducts: {
		create(input: Data): Promise<{ product: Data }>;
		publish(input: Data): Promise<unknown>;
		updateStatus(input: Data): Promise<unknown>;
	};
};
type Fetch = typeof fetch;
const paypalOrigin = "https://api-m.paypal.com";
const waffoOrigin = "https://api.waffo.ai";
const createPath = "/v1/actions/subscription-product/create-product";
const publishPath = "/v1/actions/subscription-product/publish-product";
const activatePath = "/v1/actions/subscription-product/update-status";
const oldWaffoIds = new Set<string>(ANNUAL_TIERS.map((tier) => tier.waffo));

export function assertAllowedProviderRequest(input: {
	url: string;
	method: string;
	body?: unknown;
	mode: "audit" | "prepare";
	allowedGraphql: Set<string>;
	writableWaffoIds: Set<string>;
	paypalProductIds: Set<string>;
	expectedWaffoStoreId?: string;
}) {
	const url = new URL(input.url);
	if (url.username || url.password || url.hash)
		throw new AnnualOperationError("REQUEST_NOT_ALLOWED");
	const { method, mode, body } = input;
	if (url.origin === waffoOrigin && method === "POST" && !url.search) {
		const payload = record(body);
		if (url.pathname === "/v1/graphql" && input.allowedGraphql.has(string(payload.query))) return;
		if (mode === "prepare" && url.pathname === createPath) {
			const tier = ANNUAL_TIERS.find((entry) => targetName(entry) === payload.name);
			const metadata = record(payload.metadata);
			const prices = record(payload.prices);
			const usd = record(prices.USD);
			if (
				tier &&
				payload.storeId === input.expectedWaffoStoreId &&
				payload.billingPeriod === "yearly" &&
				Object.keys(prices).join() === "USD" &&
				usd.amount === `${tier.annual / 100}.00` &&
				usd.taxCategory === "saas" &&
				Object.keys(usd).sort().join() === "amount,taxCategory" &&
				metadata.operation === ANNUAL_OPERATION &&
				metadata.previousProductId === tier.waffo &&
				Object.keys(metadata).sort().join() === "operation,previousProductId" &&
				Object.keys(payload).sort().join() === "billingPeriod,metadata,name,prices,storeId"
			)
				return;
		}
		if (
			mode === "prepare" &&
			[publishPath, activatePath].includes(url.pathname) &&
			typeof payload.id === "string" &&
			input.writableWaffoIds.has(payload.id) &&
			!oldWaffoIds.has(payload.id)
		) {
			if (url.pathname === publishPath && Object.keys(payload).join() === "id") return;
			if (
				url.pathname === activatePath &&
				payload.status === "active" &&
				Object.keys(payload).sort().join() === "id,status"
			)
				return;
		}
	}
	if (url.origin === paypalOrigin) {
		if (
			method === "POST" &&
			url.pathname === "/v1/oauth2/token" &&
			!url.search &&
			body === "grant_type=client_credentials"
		)
			return;
		if (method === "GET" && /^\/v1\/billing\/plans\/P-[0-9A-Z]+$/.test(url.pathname) && !url.search)
			return;
		if (
			method === "GET" &&
			url.pathname === "/v1/billing/plans" &&
			input.paypalProductIds.has(url.searchParams.get("product_id") ?? "") &&
			[...url.searchParams.keys()].every((key) =>
				["product_id", "page_size", "page", "total_required"].includes(key),
			) &&
			url.searchParams.get("page_size") === "20" &&
			/^[1-9][0-9]{0,3}$/.test(url.searchParams.get("page") ?? "") &&
			url.searchParams.get("total_required") === "true"
		)
			return;
		if (
			mode === "prepare" &&
			method === "POST" &&
			url.pathname === "/v1/billing/plans" &&
			!url.search
		) {
			const payload = record(body);
			const tier = ANNUAL_TIERS.find((entry) => payload.name === targetName(entry));
			if (
				tier &&
				input.paypalProductIds.has(String(payload.product_id)) &&
				JSON.stringify(payload) ===
					JSON.stringify(paypalCreateBody(tier, String(payload.product_id)))
			)
				return;
		}
	}
	throw new AnnualOperationError("REQUEST_NOT_ALLOWED");
}
export function paypalCreateBody(tier: AnnualTier, productId: string): Data {
	return {
		product_id: productId,
		name: targetName(tier),
		status: "ACTIVE",
		billing_cycles: [
			{
				frequency: { interval_unit: "YEAR", interval_count: 1 },
				tenure_type: "REGULAR",
				sequence: 1,
				total_cycles: 0,
				pricing_scheme: { fixed_price: { value: `${tier.annual / 100}.00`, currency_code: "USD" } },
			},
		],
		payment_preferences: {
			auto_bill_outstanding: true,
			setup_fee: { value: "0.00", currency_code: "USD" },
			setup_fee_failure_action: "CANCEL",
			payment_failure_threshold: 3,
		},
	};
}
function required(environment: Record<string, string | undefined>, key: string): string {
	const value = environment[key];
	if (!value?.trim()) throw new AnnualOperationError("CONFIGURATION_INCOMPLETE");
	return value;
}
function typeName(value: unknown): string {
	let current = record(value);
	for (let depth = 0; depth < 5; depth++) {
		if (typeof current.name === "string") return current.name;
		current = record(current.ofType);
	}
	throw new AnnualOperationError("WAFFO_SCHEMA_UNSUPPORTED");
}
const typeSelection = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";
export function createProviderPort(
	environment: Record<string, string | undefined>,
	mode: "audit" | "prepare",
	options: {
		fetch?: Fetch;
		waffoClient?: WaffoClient;
		onSchemaFields?: (fields: Record<string, string[]>) => void;
		onDiagnostic?: (evidence: DiagnosticEvidence) => void;
	} = {},
): PreparationPort {
	if (environment.WAFFO_ENVIRONMENT !== "prod" || environment.PAYPAL_ENVIRONMENT !== "live")
		throw new AnnualOperationError("PRODUCTION_ENVIRONMENT_REQUIRED");
	const nativeFetch = options.fetch ?? fetch;
	const approvedQueries = new Set<string>();
	const writableWaffoIds = new Set<string>();
	const protectedWaffoIds = new Set([
		...oldWaffoIds,
		...Object.entries(environment)
			.filter(([key]) => key.startsWith("WAFFO_PRODUCT_ID_"))
			.map(([, value]) => value)
			.filter((value): value is string => !!value),
	]);
	const observedWaffoIds = new Set<string>();
	const verifiedPayPalProduct = new Map<string, string>();
	const paypalProductIds = new Set<string>();
	let lastStatus: number | undefined;
	let lastRequestId: string | undefined;
	const guardedFetch: Fetch = async (input, init) => {
		if (typeof input !== "string" || !init || typeof init.body !== "string")
			throw new AnnualOperationError("REQUEST_NOT_ALLOWED");
		let body: unknown;
		try {
			body = JSON.parse(init.body);
		} catch {
			throw new AnnualOperationError("REQUEST_NOT_ALLOWED");
		}
		assertAllowedProviderRequest({
			url: input,
			method: init.method ?? "GET",
			body,
			mode,
			allowedGraphql: approvedQueries,
			writableWaffoIds,
			paypalProductIds,
			expectedWaffoStoreId: environment.WAFFO_STORE_ID,
		});
		try {
			const response = await nativeFetch(input, {
				...init,
				redirect: "error",
				signal: AbortSignal.timeout(30_000),
			});
			lastStatus = response.status;
			lastRequestId = response.headers.get("x-request-id") ?? undefined;
			return response;
		} catch {
			throw new AnnualOperationError("WAFFO_REQUEST_FAILED");
		}
	};
	let client = options.waffoClient;
	if (!client) {
		// Resolve the installed SDK from its owning package; do not add a dependency or export credentials.
		const require = createRequire(
			new URL("../../../packages/payments/package.json", import.meta.url).href,
		);
		const { WaffoPancake } = require("@waffo/pancake-ts") as {
			WaffoPancake: new (config: Data) => WaffoClient;
		};
		client = new WaffoPancake({
			merchantId: required(environment, "WAFFO_MERCHANT_ID"),
			privateKey: required(environment, "WAFFO_PRIVATE_KEY"),
			environment: "prod",
			fetch: guardedFetch,
		});
	}
	const waffo = client;
	const query = async (document: string, variables?: Data): Promise<Data> => {
		approvedQueries.add(document);
		try {
			const response = await waffo.graphql.query({
				query: document,
				...(variables ? { variables } : {}),
			});
			if (response.errors?.length || !response.data)
				throw new AnnualOperationError("WAFFO_GRAPHQL_FAILED", lastStatus, lastRequestId);
			return record(response.data);
		} catch (error) {
			if (error instanceof AnnualOperationError) throw error;
			throw new AnnualOperationError("WAFFO_GRAPHQL_FAILED", lastStatus, lastRequestId);
		}
	};
	let accessToken: string | undefined;
	const paypal = async (
		method: "GET" | "POST",
		path: string,
		body?: unknown,
		requestId?: string,
	): Promise<Data> => {
		const url = `${paypalOrigin}${path}`;
		assertAllowedProviderRequest({
			url,
			method,
			body,
			mode,
			allowedGraphql: approvedQueries,
			writableWaffoIds,
			paypalProductIds,
			expectedWaffoStoreId: environment.WAFFO_STORE_ID,
		});
		const tokenRequest = path === "/v1/oauth2/token";
		if (!tokenRequest && !accessToken) {
			const tokenResponse = await paypal(
				"POST",
				"/v1/oauth2/token",
				"grant_type=client_credentials",
			);
			if (typeof tokenResponse.access_token !== "string" || !tokenResponse.access_token)
				throw new AnnualOperationError("PAYPAL_OAUTH_FAILED");
			accessToken = tokenResponse.access_token;
		}
		const authorization = tokenRequest
			? `Basic ${Buffer.from(`${required(environment, "PAYPAL_CLIENT_ID")}:${required(environment, "PAYPAL_CLIENT_SECRET")}`).toString("base64")}`
			: `Bearer ${accessToken}`;
		try {
			const response = await nativeFetch(url, {
				method,
				redirect: "error",
				signal: AbortSignal.timeout(30_000),
				headers: {
					Authorization: authorization,
					"Content-Type": tokenRequest ? "application/x-www-form-urlencoded" : "application/json",
					...(requestId ? { "PayPal-Request-Id": requestId, Prefer: "return=representation" } : {}),
				},
				...(body !== undefined
					? { body: typeof body === "string" ? body : JSON.stringify(body) }
					: {}),
			});
			if (!response.ok)
				throw new AnnualOperationError(
					"PAYPAL_REQUEST_FAILED",
					response.status,
					response.headers.get("paypal-debug-id") ?? undefined,
				);
			return record(await response.json());
		} catch (error) {
			if (error instanceof AnnualOperationError) throw error;
			throw new AnnualOperationError("PAYPAL_REQUEST_FAILED");
		}
	};
	const paypalPlan = async (id: string): Promise<Data> => {
		if (!/^P-[0-9A-Z]+$/.test(id)) throw new AnnualOperationError("PAYPAL_PLAN_ID_INVALID");
		const plan = await paypal("GET", `/v1/billing/plans/${id}`);
		options.onDiagnostic?.({
			stage: "PAYPAL_PLAN_SHAPE",
			productId: id,
			fields: {
				productId: shape(plan.product_id),
				name: shape(plan.name),
				status: shape(plan.status),
				billingCycles: shape(plan.billing_cycles),
				paymentPreferences: shape(plan.payment_preferences),
				taxes: shape(plan.taxes),
			},
		});
		if (
			plan.id !== id ||
			typeof plan.product_id !== "string" ||
			!/^PROD-[0-9A-Z]+$/.test(plan.product_id)
		)
			throw new AnnualOperationError("PAYPAL_PLAN_IDENTITY_INVALID");
		paypalProductIds.add(plan.product_id);
		const oldTier = ANNUAL_TIERS.find((tier) => tier.paypal === id);
		if (oldTier) verifiedPayPalProduct.set(oldTier.key, plan.product_id);
		return plan;
	};
	let catalogPlan:
		| {
				schemaFields: Record<string, string[]>;
				paging: string;
				hasProd: boolean;
				metadataEncoding: "json-string" | "object";
		  }
		| undefined;
	const port: PreparationPort = {
		async waffoCatalog(): Promise<WaffoCatalog> {
			if (!catalogPlan) {
				const root = record(
					record(
						(
							await query(
								`query AnnualCatalogSchema { __schema { queryType { fields { name args { name type { ${typeSelection} } } type { ${typeSelection} } } } } }`,
							)
						).__schema,
					).queryType,
				);
				const rootFields = list(root.fields).map(record);
				const rootField = (name: string) => {
					const field = rootFields.find((entry) => entry.name === name);
					if (!field) throw new AnnualOperationError("WAFFO_SCHEMA_UNSUPPORTED");
					return field;
				};
				const schemaFields: Record<string, string[]> = {};
				const inspect = async (name: string) => {
					if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
						throw new AnnualOperationError("WAFFO_SCHEMA_UNSUPPORTED");
					const result = record(
						(
							await query(
								`query AnnualCatalogType($name: String!) { __type(name: $name) { fields { name type { ${typeSelection} } } } }`,
								{ name },
							)
						).__type,
					);
					const fields = list(result.fields).map(record);
					const allowed = new Set([
						"id",
						"name",
						"status",
						"hasProdVersion",
						"versionNumber",
						"billingPeriod",
						"prices",
						"metadata",
						"isTestVersion",
						"isProdVersion",
						"currency",
						"priceInfo",
						"amount",
						"taxCategory",
						"trialAmount",
					]);
					schemaFields[name] = fields
						.map((field) => string(field.name))
						.filter((field) => allowed.has(field));
					options.onSchemaFields?.({ [name]: schemaFields[name] });
					options.onDiagnostic?.({
						stage: "WAFFO_SCHEMA",
						fields: Object.fromEntries(
							fields
								.filter((entry) => allowed.has(String(entry.name)))
								.map((entry) => [string(entry.name), typeName(entry.type)]),
						),
					});
					return fields;
				};
				const productRoot = rootField("subscriptionProducts");
				const versionRoot = rootField("subscriptionProductVersions");
				const productFields = await inspect(typeName(productRoot.type));
				const versionFields = await inspect(typeName(versionRoot.type));
				const field = (fields: Data[], name: string) => {
					const match = fields.find((entry) => entry.name === name);
					if (!match) throw new AnnualOperationError("WAFFO_SCHEMA_UNSUPPORTED");
					return match;
				};
				for (const name of ["id", "name", "status"]) field(productFields, name);
				for (const name of [
					"versionNumber",
					"name",
					"billingPeriod",
					"metadata",
					"isTestVersion",
					"isProdVersion",
				])
					field(versionFields, name);
				const currencyFields = await inspect(typeName(field(versionFields, "prices").type));
				field(currencyFields, "currency");
				const priceFields = await inspect(typeName(field(currencyFields, "priceInfo").type));
				field(priceFields, "amount");
				field(priceFields, "taxCategory");
				// A schema without explicit trialAmount cannot certify the no-trial invariant.
				field(priceFields, "trialAmount");
				const productArguments = list(productRoot.args)
					.map(record)
					.map((entry) => entry.name);
				const paging = `${productArguments.includes("limit") ? ", limit: 1000" : ""}${productArguments.includes("offset") ? ", offset: 0" : ""}`;
				rootField("subscriptionProductsCount");
				const hasProd = productFields.some((entry) => entry.name === "hasProdVersion");
				const metadataEncoding =
					typeName(field(versionFields, "metadata").type) === "String" ? "json-string" : "object";
				catalogPlan = { schemaFields, paging, hasProd, metadataEncoding };
			}
			const { schemaFields, paging, hasProd, metadataEncoding } = catalogPlan;
			const data = await query(
				`query AnnualCatalog($storeId: String!) { subscriptionProducts(storeId: $storeId${paging}) { id name status ${hasProd ? "hasProdVersion" : ""} } subscriptionProductsCount(storeId: $storeId) }`,
				{ storeId: required(environment, "WAFFO_STORE_ID") },
			);
			options.onDiagnostic?.({
				stage: "WAFFO_CATALOG",
				fields: {
					subscriptionProducts: shape(data.subscriptionProducts),
					subscriptionProductsCount: shape(data.subscriptionProductsCount),
				},
			});
			const products = list(data.subscriptionProducts).map(record);
			for (const product of products) observedWaffoIds.add(string(product.id));
			if (data.subscriptionProductsCount !== products.length)
				throw new AnnualOperationError("WAFFO_CATALOG_INCOMPLETE");
			const storeData = await query(
				"query AnnualStore($id: String!) { store(id: $id) { id name status prodEnabled payinEnable } }",
				{ id: required(environment, "WAFFO_STORE_ID") },
			);
			options.onDiagnostic?.({ stage: "WAFFO_STORE", fields: { store: shape(storeData.store) } });
			// Inspect every subscription product so an existing target with an older name is visible.
			const relevant = products;
			for (const product of relevant) {
				const versions = await query(
					"query AnnualProductVersions($productId: String!) { subscriptionProductVersions(productId: $productId) { versionNumber name billingPeriod metadata isTestVersion isProdVersion prices { currency priceInfo { amount taxCategory trialAmount } } } }",
					{ productId: string(product.id) },
				);
				options.onDiagnostic?.({
					stage: "WAFFO_VERSIONS",
					productId: string(product.id),
					fields: { versions: shape(versions.subscriptionProductVersions) },
				});
				product.versions = list(versions.subscriptionProductVersions);
				product.metadataEncoding = metadataEncoding;
				for (const rawVersion of list(product.versions)) {
					const version = record(rawVersion);
					options.onDiagnostic?.({
						stage: "WAFFO_VERSIONS",
						productId: string(product.id),
						fields: {
							metadata: shape(version.metadata),
							name: shape(version.name),
							versionNumber: shape(version.versionNumber),
							billingPeriod: shape(version.billingPeriod),
							prices: shape(version.prices),
							isProdVersion: shape(version.isProdVersion),
							isTestVersion: shape(version.isTestVersion),
						},
					});
				}
				if (!hasProd)
					product.hasProdVersion = list(product.versions).some(
						(version) => record(version).isProdVersion === true,
					);
			}
			return { store: record(storeData.store), products: relevant, schemaFields };
		},
		paypalPlan,
		async paypalPlans(productId: string) {
			const plans: Data[] = [];
			const seen = new Set<string>();
			for (let page = 1; page <= 500; page++) {
				const data = await paypal(
					"GET",
					`/v1/billing/plans?product_id=${encodeURIComponent(productId)}&page_size=20&page=${page}&total_required=true`,
				);
				const summaries = list(data.plans).map(record);
				for (const summary of summaries) {
					const id = string(summary.id);
					if (seen.has(id)) throw new AnnualOperationError("PAYPAL_CATALOG_DUPLICATE");
					seen.add(id);
					// Detail GET is mandatory; list responses may omit price/cycle/preferences.
					const plan = await paypalPlan(id);
					if (plan.product_id !== productId)
						throw new AnnualOperationError("PAYPAL_CATALOG_IDENTITY_INVALID");
					plans.push(plan);
				}
				if (!Number.isSafeInteger(data.total_pages) || !Number.isSafeInteger(data.total_items))
					throw new AnnualOperationError("PAYPAL_CATALOG_INCOMPLETE");
				if (page >= Number(data.total_pages)) {
					if (plans.length !== data.total_items)
						throw new AnnualOperationError("PAYPAL_CATALOG_INCOMPLETE");
					return plans;
				}
			}
			throw new AnnualOperationError("PAYPAL_CATALOG_INCOMPLETE");
		},
		async waffoCreate(tier, previousId) {
			if (mode !== "prepare" || tier.waffo !== previousId)
				throw new AnnualOperationError("REQUEST_NOT_ALLOWED");
			try {
				const result = await waffo.subscriptionProducts.create({
					storeId: required(environment, "WAFFO_STORE_ID"),
					name: targetName(tier),
					billingPeriod: "yearly",
					prices: { USD: { amount: `${tier.annual / 100}.00`, taxCategory: "saas" } },
					metadata: { operation: ANNUAL_OPERATION, previousProductId: previousId },
				});
				const id = string(result.product.id);
				if (
					!/^PROD_[0-9A-Za-z]{22}$/.test(id) ||
					protectedWaffoIds.has(id) ||
					observedWaffoIds.has(id)
				)
					throw new AnnualOperationError("WAFFO_CREATED_ID_INVALID");
				writableWaffoIds.add(id);
				return id;
			} catch {
				throw new AnnualOperationError("WAFFO_CREATE_UNCERTAIN", lastStatus, lastRequestId);
			}
		},
		async waffoAuthorizeTarget(id, tier) {
			if (mode !== "prepare" || protectedWaffoIds.has(id))
				throw new AnnualOperationError("REQUEST_NOT_ALLOWED");
			const catalog = await port.waffoCatalog();
			const target = catalog.products.find((product) => product.id === id);
			if (!target) throw new AnnualOperationError("WAFFO_TARGET_NOT_FOUND");
			const evidence = waffoEvidence(target);
			if (
				!evidence.test ||
				evidence.test.name !== targetName(tier) ||
				evidence.test.operation !== ANNUAL_OPERATION ||
				evidence.test.previousProductId !== tier.waffo ||
				!validWaffoTerms(evidence.test, tier.annual, "yearly") ||
				(evidence.production && !validWaffoTerms(evidence.production, tier.annual, "yearly"))
			)
				throw new AnnualOperationError("WAFFO_TARGET_OWNERSHIP_INVALID");
			writableWaffoIds.add(id);
		},
		async waffoPublish(id) {
			try {
				await waffo.subscriptionProducts.publish({ id });
			} catch {
				throw new AnnualOperationError("WAFFO_PUBLISH_UNCERTAIN", lastStatus, lastRequestId);
			}
		},
		async waffoActivate(id) {
			try {
				await waffo.subscriptionProducts.updateStatus({ id, status: "active" });
			} catch {
				throw new AnnualOperationError("WAFFO_ACTIVATE_UNCERTAIN", lastStatus, lastRequestId);
			}
		},
		async paypalCreate(tier, productId) {
			if (verifiedPayPalProduct.get(tier.key) !== productId)
				throw new AnnualOperationError("PAYPAL_PRODUCT_IDENTITY_INVALID");
			try {
				const result = await paypal(
					"POST",
					"/v1/billing/plans",
					paypalCreateBody(tier, productId),
					`ezpic-${ANNUAL_OPERATION}-${tier.key}`,
				);
				return string(result.id);
			} catch {
				throw new AnnualOperationError("PAYPAL_CREATE_UNCERTAIN");
			}
		},
	};
	return port;
}
