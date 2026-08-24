import { describe, expect, it } from "vitest";

import { buildMediaQuote } from "./quote";

describe("buildMediaQuote", () => {
	it("persists a deterministic per-output settlement policy in the pricing snapshot", () => {
		const quote = buildMediaQuote({
			productKey: "image-fast",
			input: { kind: "text-to-image", prompt: "test prompt" },
		});

		expect(quote.pricingSnapshot).toEqual({
			credits: 4,
			maximumJobCostMicros: 5_000_000,
			settlementPolicy: {
				unitCredits: "4",
				requestedOutputCount: 1,
				maxCharge: "4",
			},
		});
	});
});
