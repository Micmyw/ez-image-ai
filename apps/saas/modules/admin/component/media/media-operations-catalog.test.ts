import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("admin media product selector", () => {
	it("limits runtime product controls to the EzPic image catalog", () => {
		const source = readFileSync(new URL("./MediaOperations.tsx", import.meta.url), "utf8");

		expect(source).toContain("EZPIC_PRODUCT_KEYS");
		expect(source).not.toContain("PRODUCT_MODEL_KEYS");
	});
});
