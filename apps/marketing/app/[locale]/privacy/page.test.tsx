import type { Metadata } from "next";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { getLegalPageByPath } = vi.hoisted(() => ({
	getLegalPageByPath: vi.fn(async () => ({
		title: "Privacy Policy",
		body: "compiled-privacy-body",
		content: "privacy-body",
	})),
}));
vi.mock("@legal/lib/pages", () => ({ getLegalPageByPath }));
vi.mock("next-intl/server", () => ({ setRequestLocale: vi.fn() }));

import PrivacyPage, { generateMetadata } from "./page";

describe("privacy trust page", () => {
	it("uses the approved English canonical and keeps localized copies noindex", async () => {
		const english: Metadata = await generateMetadata({
			params: Promise.resolve({ locale: "en" }),
		});
		expect(english).toMatchObject({
			title: { absolute: "Privacy Policy | EzPic" },
			alternates: { canonical: expect.stringMatching(/\/privacy$/) },
			robots: { index: true, follow: true },
		});
		const german: Metadata = await generateMetadata({
			params: Promise.resolve({ locale: "de" }),
		});
		expect(german.robots).toEqual({ index: false, follow: true });
		expect(german.alternates).toEqual({ canonical: expect.stringMatching(/\/privacy$/) });
	});

	it("reuses the existing privacy policy content with one H1", async () => {
		const markup = renderToStaticMarkup(
			await PrivacyPage({ params: Promise.resolve({ locale: "en" }) }),
		);
		expect(getLegalPageByPath).toHaveBeenCalledWith("privacy-policy", { locale: "en" });
		expect(markup.match(/<h1(?:\s|>)/g)).toHaveLength(1);
		expect(markup).toContain("Privacy Policy");
		expect(markup).toContain("privacy-body");
	});
});
