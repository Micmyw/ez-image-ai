import type { Metadata } from "next";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { getLegalPageByPath } = vi.hoisted(() => ({
	getLegalPageByPath: vi.fn(async () => ({
		title: "Terms of Service",
		body: "compiled-terms-body",
		content: "terms-body",
	})),
}));
vi.mock("@legal/lib/pages", () => ({ getLegalPageByPath }));
vi.mock("next-intl/server", () => ({ setRequestLocale: vi.fn() }));

import TermsPage, { generateMetadata } from "./page";

describe("terms trust page", () => {
	it("uses the approved English canonical and keeps localized copies noindex", async () => {
		const english: Metadata = await generateMetadata({
			params: Promise.resolve({ locale: "en" }),
		});
		expect(english).toMatchObject({
			title: { absolute: "Terms of Service | EzPic" },
			alternates: { canonical: expect.stringMatching(/\/terms$/) },
			robots: { index: true, follow: true },
		});
		const spanish: Metadata = await generateMetadata({
			params: Promise.resolve({ locale: "es" }),
		});
		expect(spanish.robots).toEqual({ index: false, follow: true });
		expect(spanish.alternates).toEqual({ canonical: expect.stringMatching(/\/terms$/) });
	});

	it("reuses the existing terms content with one H1", async () => {
		const markup = renderToStaticMarkup(
			await TermsPage({ params: Promise.resolve({ locale: "en" }) }),
		);
		expect(getLegalPageByPath).toHaveBeenCalledWith("terms", { locale: "en" });
		expect(markup.match(/<h1(?:\s|>)/g)).toHaveLength(1);
		expect(markup).toContain("Terms of Service");
		expect(markup).toContain("terms-body");
	});
});
