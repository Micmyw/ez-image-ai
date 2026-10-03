import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
	permanentRedirect: (target: string) => {
		throw new Error(`308:${target}`);
	},
}));
import EffectsPage from "./(public)/effects/page";

describe("retired Effects directory", () => {
	it("permanently redirects to Blog Photo Ideas", async () => {
		await expect(EffectsPage({})).rejects.toThrow("308:/blog?category=photo-ideas");
	});
	it("preserves a supported interface language but discards obsolete directory filters and untrusted values", async () => {
		await expect(
			EffectsPage({
				searchParams: Promise.resolve({
					lang: "fr",
					page: "2",
					category: "retro-vintage",
					q: "private",
				}),
			}),
		).rejects.toThrow("308:/blog?category=photo-ideas&lang=fr");
		await expect(
			EffectsPage({ searchParams: Promise.resolve({ lang: ["en", "fr"] }) }),
		).rejects.toThrow("308:/blog?category=photo-ideas");
	});
});
