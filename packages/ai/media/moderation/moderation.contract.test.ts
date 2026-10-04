import { describe, expect, it } from "vitest";

import { createMediaSafetyAdapter, TestMediaSafetyAdapter } from "./index";
import * as publicModeration from "./index";
describe("media safety contract", () => {
	it("rejects the test adapter in production", () => {
		expect(() =>
			createMediaSafetyAdapter({
				kind: "test",
				nodeEnv: "production",
				allowTestAdapter: true,
			}),
		).toThrow(/production/i);
		expect(
			createMediaSafetyAdapter({ kind: "test", nodeEnv: "test", allowTestAdapter: true }),
		).toBeInstanceOf(TestMediaSafetyAdapter);
	});

	it.each(["sightengine", "unknown", undefined])(
		"rejects unknown runtime factory selection %s",
		(kind) => {
			expect(() =>
				createMediaSafetyAdapter({ kind, nodeEnv: "test", allowTestAdapter: true } as never),
			).toThrow();
		},
	);

	it.each([undefined, false, "true"])(
		"rejects a test adapter without explicit boolean permission %s",
		(allowTestAdapter) => {
			expect(() =>
				createMediaSafetyAdapter({ kind: "test", nodeEnv: "test", allowTestAdapter } as never),
			).toThrow();
		},
	);

	it.each([undefined, "staging", "unknown"])(
		"rejects an unsupported runtime environment %s",
		(nodeEnv) => {
			expect(() =>
				createMediaSafetyAdapter({ kind: "test", nodeEnv, allowTestAdapter: true } as never),
			).toThrow();
		},
	);

	it("removes the retired provider from the public moderation barrel", () => {
		expect(publicModeration).not.toHaveProperty("SightengineSafetyAdapter");
	});
});
