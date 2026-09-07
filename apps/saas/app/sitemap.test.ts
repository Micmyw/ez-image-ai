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

		expect(urls.map(({ pathname }) => pathname)).toEqual(["/", "/pricing", "/privacy", "/terms"]);
		expect(urls.every(({ origin }) => origin === "https://www.ezpic.test")).toBe(true);
		expect(new Set(urls.map(({ href }) => href)).size).toBe(urls.length);
	});
});
