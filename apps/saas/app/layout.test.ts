import { config } from "@config";
import { getBaseUrl } from "@shared/lib/base-url";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/local", () => ({
	default: () => ({ variable: "test-font" }),
}));

import { metadata } from "./layout";

describe("SaaS root metadata", () => {
	it("uses the configured EzImageAI identity while remaining non-indexable", () => {
		expect(metadata).toMatchObject({
			applicationName: config.appName,
			description: config.appDescription,
			metadataBase: new URL(getBaseUrl()),
			robots: { follow: false, index: false },
		});
	});
});
