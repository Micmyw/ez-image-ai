import { describe, expect, it, vi } from "vitest";

import { refreshGenerationQueries } from "./use-generation";

describe("generation query refresh", () => {
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
