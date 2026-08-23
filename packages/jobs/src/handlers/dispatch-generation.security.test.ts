import { describe, expect, it, vi } from "vitest";

import { dispatchGeneration } from "./dispatch-generation";

describe("dispatch generation security gates", () => {
	it("rejects before claiming or contacting a provider when generation is disabled", async () => {
		const claimDispatch = vi.fn();
		const getProvider = vi.fn();

		await expect(
			dispatchGeneration(
				{ jobId: "job-1", version: 1 },
				{
					store: { claimDispatch } as never,
					getProvider,
					isGenerationEnabled: () => false,
				},
			),
		).rejects.toThrow("MEDIA_GENERATION_DISABLED");
		expect(claimDispatch).not.toHaveBeenCalled();
		expect(getProvider).not.toHaveBeenCalled();
	});
});
