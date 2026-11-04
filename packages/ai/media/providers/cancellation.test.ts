import { describe, expect, it } from "vitest";

import { providerSupportsCancellation } from "./cancellation";
import { FalProviderAdapter } from "./fal";
import { GeminiProviderAdapter } from "./gemini";
import { KieProviderAdapter } from "./kie";
import { OpenRouterProviderAdapter } from "./openrouter";
import { ReplicateProviderAdapter } from "./replicate";

describe("provider cancellation capabilities", () => {
	it.each([
		["replicate", ReplicateProviderAdapter],
		["kie", KieProviderAdapter],
		["gemini", GeminiProviderAdapter],
		["fal", FalProviderAdapter],
		["openrouter", OpenRouterProviderAdapter],
	] as const)("matches the implemented %s adapter", (provider, adapter) => {
		expect(providerSupportsCancellation(provider)).toBe("cancel" in adapter.prototype);
	});
	it.each([undefined, null, "unknown", "__proto__"])("rejects unknown capability %s", (value) => {
		expect(providerSupportsCancellation(value)).toBe(false);
	});
});
