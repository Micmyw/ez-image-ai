import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SmartCoercionPlugin } from "@orpc/json-schema";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { call, type RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { getImagePassOfferSnapshot } from "@repo/config/image-pass";
import { IMAGE_PASS_PAYPAL_SKU } from "@repo/config/image-pass.server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
	findPlan: vi.fn(),
	checkoutAvailable: vi.fn(),
	assertIsolation: vi.fn(),
	getSession: vi.fn(),
}));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: transport.getSession } } }));
vi.mock("@repo/database", () => ({ assertLiveBillingDataIsolation: transport.assertIsolation }));
vi.mock("@repo/database/client", () => ({
	db: { billingPlan: { findUnique: transport.findPlan } },
}));
vi.mock("@repo/payments", () => ({
	isPaymentProviderCheckoutAvailable: transport.checkoutAvailable,
	findPriceByPlanId: vi.fn(),
	resolvePaymentProvider: vi.fn(),
}));
import { getImagePassOffer, resolveImagePassOfferAvailability } from "./get-image-pass-offer";

const plan = {
	provider: "paypal",
	providerPriceId: IMAGE_PASS_PAYPAL_SKU,
	productKind: "IMAGE_PASS",
	name: "image-pass-3",
	active: true,
	priceMicros: 1_000_000n,
	currency: "USD",
	creditsPerPeriod: 0n,
	metadata: { imagePassOfferSnapshot: getImagePassOfferSnapshot() },
};
const dependencies = () => ({
	isBillingEnabled: () => true,
	findPlan: vi.fn(async () => plan),
	isCheckoutAvailable: vi.fn(async () => true),
	assertEnvironmentReady: vi.fn(async () => {}),
});

describe("public image-pass offer Fetch transports", () => {
	const router = { payments: { getImagePassOffer } };
	// Match the production OpenAPI coercion configuration without loading unrelated routes.
	const openApi = new OpenAPIHandler(router, {
		plugins: [new SmartCoercionPlugin({ schemaConverters: [new ZodToJsonSchemaConverter()] })],
	});
	const rpc = new RPCHandler(router);
	async function handle(request: Request, kind: "openapi" | "rpc"): Promise<Response> {
		const responseHeaders = new Headers();
		const result = await (kind === "rpc" ? rpc : openApi).handle(request, {
			prefix: kind === "rpc" ? "/api/rpc" : "/api",
			context: { headers: request.headers, responseHeaders },
		});
		if (!result.matched) throw new Error("Offer route did not match");
		// The API's outer Fetch boundary merges procedure-owned response headers.
		const headers = new Headers(result.response.headers);
		for (const [name, value] of responseHeaders) headers.append(name, value);
		return new Response(result.response.body, { status: result.response.status, headers });
	}
	const get = (query = "") =>
		handle(new Request(`https://saas.test/api/payments/image-pass-offer${query}`), "openapi");
	const client = (fetch = (request: Request) => handle(request, "rpc")) =>
		createORPCClient<RouterClient<typeof router>>(
			new RPCLink({ url: "https://saas.test/api/rpc", fetch }),
		);

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("BILLING_ENABLED", "true");
		vi.stubEnv("PAYPAL_ENVIRONMENT", "live");
		vi.stubEnv("WAFFO_ENVIRONMENT", undefined);
		transport.findPlan.mockResolvedValue({
			...plan,
			metadata: { ...plan.metadata, providerEnvironment: "live" },
		});
		transport.checkoutAvailable.mockResolvedValue(true);
		transport.assertIsolation.mockResolvedValue(undefined);
		vi.stubGlobal("fetch", () => {
			throw new Error("External network is forbidden in offer transport tests");
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it("returns no-store availability for an empty public OpenAPI GET", async () => {
		const response = await get();
		expect({ status: response.status, body: await response.json() }).toEqual({
			status: 200,
			body: { available: true },
		});
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(transport.getSession).not.toHaveBeenCalled();
	});

	it.each([
		"absent",
		"billing-disabled",
		"provider-unavailable",
		"database-error",
		"isolation-error",
	])("keeps an empty OpenAPI GET fail-closed for %s", async (failure) => {
		if (failure === "absent") transport.findPlan.mockResolvedValue(null);
		if (failure === "billing-disabled") vi.stubEnv("BILLING_ENABLED", "false");
		if (failure === "provider-unavailable") transport.checkoutAvailable.mockResolvedValue(false);
		if (failure === "database-error")
			transport.findPlan.mockRejectedValue(new Error("private database detail"));
		if (failure === "isolation-error")
			transport.assertIsolation.mockRejectedValue(new Error("private environment detail"));
		const response = await get();
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ available: false });
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("preserves undefined RPC input through RPCLink and RPCHandler Fetch encoding", async () => {
		let response: Response | undefined;
		const rpcClient = client(async (request) => {
			response = await handle(request, "rpc");
			return response;
		});
		await expect(rpcClient.payments.getImagePassOffer(undefined)).resolves.toEqual({
			available: true,
		});
		expect(response?.status).toBe(200);
		expect(response?.headers.get("Cache-Control")).toBe("no-store");
		expect(transport.getSession).not.toHaveBeenCalled();
	});

	it.each(["?provider=waffo", "?price=0"])(
		"rejects unexpected OpenAPI query input %s before loading billing data",
		async (query) => {
			const response = await get(query);
			expect(response.status).toBe(400);
			await expect(response.json()).resolves.toMatchObject({ code: "BAD_REQUEST" });
			expect(transport.findPlan).not.toHaveBeenCalled();
		},
	);

	it.each([null, [], { provider: "waffo" }])(
		"rejects nonempty or nonobject RPC input %j before loading billing data",
		async (input) => {
			await expect(client().payments.getImagePassOffer(input as never)).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
			expect(transport.findPlan).not.toHaveBeenCalled();
		},
	);
});
afterEach(() => vi.unstubAllEnvs());
describe("public image-pass offer availability", () => {
	it("exposes only availability for an exact active server-owned offer", async () => {
		await expect(resolveImagePassOfferAvailability(dependencies())).resolves.toEqual({
			available: true,
		});
	});
	it.each([
		null,
		{ ...plan, active: false },
		{ ...plan, currency: "EUR" },
		{ ...plan, priceMicros: 2_000_000n },
		{ ...plan, providerPriceId: "other-offer" },
	])("hides absent, inactive or mismatched metadata", async (candidate) => {
		const deps = { ...dependencies(), findPlan: async () => candidate };
		await expect(resolveImagePassOfferAvailability(deps)).resolves.toEqual({ available: false });
		expect(deps.assertEnvironmentReady).not.toHaveBeenCalled();
	});
	it.each(["billing-disabled", "provider-unavailable", "isolation-failed", "database-unavailable"])(
		"fails closed for %s",
		async (failure) => {
			const deps = dependencies();
			if (failure === "billing-disabled") deps.isBillingEnabled = () => false;
			if (failure === "provider-unavailable") deps.isCheckoutAvailable.mockResolvedValue(false);
			if (failure === "isolation-failed")
				deps.assertEnvironmentReady.mockRejectedValue(new Error("internal detail"));
			if (failure === "database-unavailable")
				deps.findPlan.mockRejectedValue(new Error("internal detail"));
			await expect(resolveImagePassOfferAvailability(deps)).resolves.toEqual({ available: false });
		},
	);
	it("does not advertise a billing row from another provider environment", async () => {
		vi.stubEnv("PAYPAL_ENVIRONMENT", "live");
		await expect(
			resolveImagePassOfferAvailability({
				...dependencies(),
				findPlan: async () => ({
					...plan,
					metadata: { ...plan.metadata, providerEnvironment: "sandbox" },
				}),
			}),
		).resolves.toEqual({ available: false });
	});
	it("is public and returns no-store availability without loading an owner", async () => {
		vi.stubEnv("BILLING_ENABLED", "false");
		const responseHeaders = new Headers();
		await expect(
			call(getImagePassOffer, undefined, { context: { headers: new Headers(), responseHeaders } }),
		).resolves.toEqual({ available: false });
		expect(responseHeaders.get("Cache-Control")).toBe("no-store");
	});
});
