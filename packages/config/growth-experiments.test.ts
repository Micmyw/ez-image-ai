import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { growthExperimentVariant } from "./growth-experiments";

describe("growth assignment", () => {
	it("keeps browser assignments stable, with independently balanced experiments", () => {
		const buckets = new Map<string, number>();
		for (let i = 0; i < 4000; i++) {
			const hash = `sha256:${createHash("sha256").update(String(i)).digest("hex")}`;
			const pricing = growthExperimentVariant("pricing-default-v1", hash);
			const result = growthExperimentVariant("result-purchase-v1", hash);
			expect(growthExperimentVariant("pricing-default-v1", hash)).toBe(pricing);
			const key = `${pricing}:${result}`;
			buckets.set(key, (buckets.get(key) ?? 0) + 1);
		}
		expect(buckets.size).toBe(4);
		for (const count of buckets.values()) expect(count).toBeGreaterThan(850);
	});
});
