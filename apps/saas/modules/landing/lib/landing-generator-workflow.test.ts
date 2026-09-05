import { describe, expect, it } from "vitest";

import {
	landingDisabledReason,
	resolveLandingProductSelection,
} from "./landing-generator-workflow";

const products = [
	{
		key: "image-fast" as const,
		label: "Standard Edit",
		description: "Everyday edits",
		credits: "5" as const,
		accessHint: "guest-trial" as const,
	},
	{
		key: "image-quality" as const,
		label: "Quality Edit",
		description: "Higher fidelity",
		credits: "40" as const,
		accessHint: "paid-account" as const,
	},
];

describe("landing generator workflow", () => {
	it("keeps a valid tier selection and otherwise prefers the real guest trial", () => {
		expect(resolveLandingProductSelection(products, "image-quality")).toBe("image-quality");
		expect(resolveLandingProductSelection(products, null)).toBe("image-fast");
		expect(resolveLandingProductSelection(products.slice(1), "image-fast")).toBe("image-quality");
		expect(resolveLandingProductSelection([], "image-fast")).toBeNull();
	});

	it("names the first missing condition and never enables a busy workflow", () => {
		const ready = {
			stage: "ready" as const,
			capabilityEnabled: true,
			productSelected: true,
			hasSource: true,
			prompt: "Replace the background",
			turnstileReady: true,
		};

		expect(landingDisabledReason({ ...ready, stage: "checking" })).toBe("checking");
		expect(landingDisabledReason({ ...ready, capabilityEnabled: false })).toBe("unavailable");
		expect(landingDisabledReason({ ...ready, productSelected: false })).toBe("product");
		expect(landingDisabledReason({ ...ready, hasSource: false })).toBe("source");
		expect(landingDisabledReason({ ...ready, prompt: "   " })).toBe("prompt");
		expect(landingDisabledReason({ ...ready, turnstileReady: false })).toBe("verification");
		expect(landingDisabledReason(ready)).toBeNull();
		for (const stage of ["preparing", "uploading", "verifying", "handoff"] as const) {
			expect(landingDisabledReason({ ...ready, stage })).toBe("busy");
		}
	});
});
