import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import sitemap from "./sitemap";

describe("consolidated SaaS sitemap", () => {
	beforeEach(() => {
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://www.ezpic.test");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("publishes exactly the approved same-origin public routes", () => {
		const entries = sitemap();
		const urls = entries.map(({ url }) => new URL(url));

		expect(urls.map(({ pathname }) => pathname).sort()).toEqual(
			[
				"/",
				"/pricing",
				"/privacy",
				"/terms",
				"/blog",
				"/models",
				"/models/nano-banana-2-lite",
				"/models/nano-banana",
				"/models/nano-banana-2",
				"/models/nano-banana-pro",
				"/models/gpt-image-1-5",
				"/models/gpt-image-2",
				"/models/gpt-image-2-5-flare",
				"/models/gpt-image-2-5-sunburst",
				"/models/seedream-4",
				"/models/seedream-4-5",
				"/models/seedream-5-lite",
				"/models/seedream-5-pro",
				"/blog/private-image-editing-workflow",
				"/blog/ai-image-editing-prompts",
				"/docs",
				"/docs/quick-start",
				"/docs/image-editing",
				"/docs/credits",
				"/docs/privacy",
			].sort(),
		);
		expect(urls.every(({ origin }) => origin === "https://www.ezpic.test")).toBe(true);
		expect(new Set(urls.map(({ href }) => href)).size).toBe(urls.length);
		// Rebuilding must not manufacture a content modification date.
		expect(entries.every((entry) => entry.lastModified === undefined)).toBe(true);
	});
});
