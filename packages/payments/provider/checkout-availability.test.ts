import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPaymentProviderCheckoutAvailability } from "./checkout-availability";

const environment = {
	PAYPAL_ENVIRONMENT: "live",
	PAYPAL_CLIENT_ID: "paypal-client",
	PAYPAL_CLIENT_SECRET: "paypal-secret",
	PAYPAL_WEBHOOK_ID: "paypal-webhook",
	WAFFO_ENVIRONMENT: "prod",
	WAFFO_STORE_ID: "STO_ezpic",
	WAFFO_MERCHANT_ID: "MER_0000000000000000000000",
	WAFFO_PRIVATE_KEY: "private-key",
	WAFFO_WEBHOOK_PUBLIC_KEY: "public-key",
};
const approvedStore = {
	id: environment.WAFFO_STORE_ID,
	status: "active",
	prodEnabled: true,
	payinEnable: true,
};
const response = (store: unknown = approvedStore) => ({ data: { store } });

afterEach(() => vi.unstubAllGlobals());

describe("payment merchant checkout availability", () => {
	it("keeps PayPal available independently of Waffo approval or failures", async () => {
		const readWaffoStore = vi.fn().mockRejectedValue(new Error("unavailable"));
		const check = createPaymentProviderCheckoutAvailability({ readWaffoStore });
		await expect(check("waffo", { environment })).resolves.toBe(false);
		await expect(check("paypal", { environment })).resolves.toBe(true);
		expect(readWaffoStore).toHaveBeenCalledTimes(1);
	});

	it("rejects missing credentials and dormant Stripe without provider I/O", async () => {
		const readWaffoStore = vi.fn();
		const check = createPaymentProviderCheckoutAvailability({ readWaffoStore });
		await expect(
			check("waffo", { environment: { ...environment, WAFFO_PRIVATE_KEY: "" } }),
		).resolves.toBe(false);
		await expect(
			check("paypal", { environment: { ...environment, PAYPAL_CLIENT_SECRET: "" } }),
		).resolves.toBe(false);
		await expect(check("stripe", { environment })).resolves.toBe(false);
		expect(readWaffoStore).not.toHaveBeenCalled();
	});

	it("preserves explicitly configured Waffo test checkout without production approval", async () => {
		const readWaffoStore = vi.fn();
		const check = createPaymentProviderCheckoutAvailability({ readWaffoStore });
		await expect(
			check("waffo", { environment: { ...environment, WAFFO_ENVIRONMENT: "test" } }),
		).resolves.toBe(true);
		expect(readWaffoStore).not.toHaveBeenCalled();
	});

	it.each([
		["pending approval", { ...approvedStore, prodEnabled: false }],
		["disabled pay-in", { ...approvedStore, payinEnable: false }],
		["inactive store", { ...approvedStore, status: "suspended" }],
		["a different approved store", { ...approvedStore, id: "STO_another" }],
		["missing approval", { id: approvedStore.id, status: "active", payinEnable: true }],
		["a string approval flag", { ...approvedStore, prodEnabled: "true" }],
		["missing store", null],
	])("rejects %s", async (_name, store) => {
		const check = createPaymentProviderCheckoutAvailability({
			readWaffoStore: vi.fn().mockResolvedValue(response(store)),
		});
		await expect(check("waffo", { environment })).resolves.toBe(false);
	});

	it.each([
		{ ...response(), errors: [{ message: "denied" }] },
		{ ...response(), warnings: [{ message: "partial result" }] },
		{ data: null },
		{},
	])("rejects incomplete or degraded evidence", async (result) => {
		const check = createPaymentProviderCheckoutAvailability({
			readWaffoStore: vi.fn().mockResolvedValue(result),
		});
		await expect(check("waffo", { environment })).resolves.toBe(false);
	});

	it("automatically opens after approval when the bounded listing cache expires", async () => {
		let time = 0;
		const readWaffoStore = vi
			.fn()
			.mockResolvedValueOnce(response({ ...approvedStore, prodEnabled: false }))
			.mockResolvedValue(response());
		const check = createPaymentProviderCheckoutAvailability({ readWaffoStore, now: () => time });
		await expect(check("waffo", { environment })).resolves.toBe(false);
		await expect(check("waffo", { environment })).resolves.toBe(false);
		expect(readWaffoStore).toHaveBeenCalledTimes(1);
		time = 30_001;
		await expect(check("waffo", { environment })).resolves.toBe(true);
		expect(readWaffoStore).toHaveBeenCalledTimes(2);
	});

	it("refreshes before checkout and revokes a previously cached approval on failure", async () => {
		const readWaffoStore = vi
			.fn()
			.mockResolvedValueOnce(response())
			.mockRejectedValue(new Error("timeout"));
		const check = createPaymentProviderCheckoutAvailability({ readWaffoStore });
		await expect(check("waffo", { environment })).resolves.toBe(true);
		await expect(check("waffo", { environment, fresh: true })).resolves.toBe(false);
		await expect(check("waffo", { environment })).resolves.toBe(false);
		expect(readWaffoStore).toHaveBeenCalledTimes(2);
	});

	it.each(["WAFFO_STORE_ID", "WAFFO_MERCHANT_ID", "WAFFO_PRIVATE_KEY", "WAFFO_WEBHOOK_PUBLIC_KEY"])(
		"does not reuse cached approval after %s changes",
		async (key) => {
			const readWaffoStore = vi
				.fn()
				.mockResolvedValueOnce(response())
				.mockRejectedValue(new Error("not approved"));
			const check = createPaymentProviderCheckoutAvailability({ readWaffoStore });
			await expect(check("waffo", { environment })).resolves.toBe(true);
			await expect(
				check("waffo", { environment: { ...environment, [key]: "replacement" } }),
			).resolves.toBe(false);
			expect(readWaffoStore).toHaveBeenCalledTimes(2);
		},
	);

	it("does not let an older in-flight observation overwrite a newer revocation", async () => {
		let finishOld!: (value: unknown) => void;
		const readWaffoStore = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishOld = resolve;
					}),
			)
			.mockResolvedValue(response({ ...approvedStore, prodEnabled: false }));
		const check = createPaymentProviderCheckoutAvailability({ readWaffoStore });
		const old = check("waffo", { environment });
		await expect(check("waffo", { environment, fresh: true })).resolves.toBe(false);
		finishOld(response());
		await old;
		await expect(check("waffo", { environment })).resolves.toBe(false);
	});

	it("uses a fresh signed read and rejects HTTP failures even with an approved body", async () => {
		const { privateKey, publicKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
			publicKeyEncoding: { type: "spki", format: "pem" },
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json(response()))
			.mockResolvedValueOnce(Response.json(response(), { status: 503 }));
		vi.stubGlobal("fetch", fetchMock);
		const check = createPaymentProviderCheckoutAvailability();
		const options = {
			environment: {
				...environment,
				WAFFO_PRIVATE_KEY: privateKey,
				WAFFO_WEBHOOK_PUBLIC_KEY: publicKey,
			},
			fresh: true,
		};
		await expect(check("waffo", options)).resolves.toBe(true);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://api.waffo.ai/v1/graphql");
		expect(init.redirect).toBe("error");
		const headers = new Headers(init.headers);
		expect(headers.has("X-Signature")).toBe(true);
		expect(headers.has("X-Idempotency-Key")).toBe(false);
		expect(JSON.parse(init.body).variables).toEqual({ id: approvedStore.id });
		await expect(check("waffo", options)).resolves.toBe(false);
	});
});
