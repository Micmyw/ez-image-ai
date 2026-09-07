import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("admin media product selector", () => {
	it("limits runtime product controls to the EzPic image catalog", () => {
		const source = readFileSync(new URL("./MediaOperations.tsx", import.meta.url), "utf8");

		expect(source).toContain("EZPIC_PRODUCT_KEYS");
		expect(source).toContain('"image-nano-banana-2-lite"');
		expect(source).toContain("products(`${key}.label`)");
		expect(source).not.toContain("PRODUCT_MODEL_KEYS");
		expect(source).not.toMatch(/image-fast|image-quality|Standard Edit|Quality Edit/);
		expect(source).not.toMatch(
			/\.providers\b|\.finance\b|providerEventId|providerModelId|providerTaskId|providerCostMicros|costMicros|marginMicros|>Provider</,
		);
	});

	it("localizes guest control, state, and reason codes instead of rendering raw diagnostics", async () => {
		const module = (await import("./MediaOperations")) as Record<string, unknown>;
		const format = module.formatGuestDiagnosticLabel as
			| ((
					kind: "control" | "state" | "reason",
					value: string,
					t: (key: string) => string,
			  ) => string)
			| undefined;
		const labels: Record<string, string> = {
			"values.on": "Enabled",
			"values.off": "Disabled",
			"states.slow": "Admission slowed",
			"reasons.ipRateLimit": "IP rate limit",
		};

		expect(format).toBeTypeOf("function");
		expect(format?.("control", "ON", (key) => labels[key] ?? key)).toBe("Enabled");
		expect(format?.("control", "OFF", (key) => labels[key] ?? key)).toBe("Disabled");
		expect(format?.("state", "SLOW", (key) => labels[key] ?? key)).toBe("Admission slowed");
		expect(format?.("reason", "IP_RATE_LIMIT", (key) => labels[key] ?? key)).toBe("IP rate limit");
	});
});
