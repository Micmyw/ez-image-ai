import { EZPIC_PRODUCT_KEYS } from "@repo/config/client";
import { describe, expect, it, vi } from "vitest";

import { refreshGenerationQueries, requireEditorProductKey } from "./use-generation";

describe("generation query refresh", () => {
	it("accepts every stable editor product key exposed by the public config", () => {
		for (const productKey of EZPIC_PRODUCT_KEYS) {
			expect(requireEditorProductKey(productKey)).toBe(productKey);
		}
		expect(() => requireEditorProductKey("image-provider-model-id")).toThrow("PRODUCT_UNAVAILABLE");
	});

	it("refreshes running jobs and credit entitlement state after every confirmation outcome", async () => {
		const invalidateQueries = vi.fn(async () => undefined);

		await refreshGenerationQueries({ invalidateQueries });

		expect(invalidateQueries).toHaveBeenCalledTimes(2);
		expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: ["media-jobs"] });
		expect(invalidateQueries).toHaveBeenNthCalledWith(2, {
			queryKey: ["media-credit-account"],
		});
	});
});
