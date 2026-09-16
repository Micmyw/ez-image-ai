import { z } from "zod";

import type { PaymentProviderName } from "../types";
import { isPaymentProviderConfigured } from "./registry";
import { createWaffoClient } from "./waffo";

type Environment = Record<string, string | undefined>;

const storeResponse = z.object({
	data: z.object({
		store: z.object({
			id: z.string(),
			status: z.string(),
			prodEnabled: z.boolean(),
			payinEnable: z.boolean(),
		}),
	}),
	errors: z.array(z.unknown()).optional(),
	warnings: z.array(z.unknown()).optional(),
});

// Cache completed observations only. In-flight I/O must remain owned by its
// Cloudflare request. Checkout always refreshes; listing may reuse a 30s result.
export function createPaymentProviderCheckoutAvailability(
	dependencies: {
		readWaffoStore?: (environment: Environment) => Promise<unknown>;
		now?: () => number;
	} = {},
) {
	const readStore = dependencies.readWaffoStore ?? readWaffoStore;
	const now = dependencies.now ?? Date.now;
	let sequence = 0;
	let cache: { key: string; available: boolean; expiresAt: number; sequence: number } | undefined;

	return async (
		provider: PaymentProviderName,
		options: { environment?: Environment; fresh?: boolean } = {},
	): Promise<boolean> => {
		const environment = options.environment ?? process.env;
		if (provider === "stripe" || !isPaymentProviderConfigured(provider, environment)) return false;
		if (provider === "paypal" || environment.WAFFO_ENVIRONMENT === "test") return true;
		const key = JSON.stringify([
			environment.WAFFO_STORE_ID,
			environment.WAFFO_MERCHANT_ID,
			environment.WAFFO_PRIVATE_KEY,
			environment.WAFFO_WEBHOOK_PUBLIC_KEY,
		]);
		if (!options.fresh && cache?.key === key && cache.expiresAt > now()) return cache.available;
		const currentSequence = ++sequence;
		let available = false;
		try {
			const result = storeResponse.safeParse(await readStore(environment));
			if (result.success && !result.data.errors?.length && !result.data.warnings?.length) {
				const store = result.data.data.store;
				available =
					store.id === environment.WAFFO_STORE_ID?.trim() &&
					store.status === "active" &&
					store.prodEnabled &&
					store.payinEnable;
			}
		} catch {
			// One unavailable merchant must not hide another ready payment method.
		}
		if (!cache || cache.sequence <= currentSequence) {
			cache = { key, available, expiresAt: now() + 30_000, sequence: currentSequence };
		}
		return available;
	};
}

export const isPaymentProviderCheckoutAvailable = createPaymentProviderCheckoutAvailability();

async function readWaffoStore(environment: Environment): Promise<unknown> {
	const client = createWaffoClient(environment, {
		fetch: async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (url.origin !== "https://api.waffo.ai" || url.pathname !== "/v1/graphql")
				throw new Error("WAFFO_STORE_STATUS_UNAVAILABLE");
			const response = await fetch(input, {
				...init,
				// Workers supports manual redirects; the non-2xx check below rejects them.
				redirect: "manual",
				signal: AbortSignal.any([
					...(init?.signal ? [init.signal] : []),
					AbortSignal.timeout(3_000),
				]),
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error("WAFFO_STORE_STATUS_UNAVAILABLE");
			}
			return response;
		},
	});
	return client.graphql.query({
		query: `query CheckoutStoreStatus($id: String!) { store(id: $id) { id status prodEnabled payinEnable } }`,
		variables: { id: environment.WAFFO_STORE_ID?.trim() },
	});
}
