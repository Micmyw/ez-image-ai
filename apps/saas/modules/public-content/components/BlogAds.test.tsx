import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const consent = vi.hoisted(() => ({ userHasConsented: false }));
vi.mock("@shared/hooks/cookie-consent", () => ({ useCookieConsent: () => consent }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

import { getBlogAdSettings } from "../lib/blog-ads";
import { BlogAds } from "./BlogAds";

describe("optional editorial advertising", () => {
	it("emits no advertising markup with the default emergency switch", () => {
		consent.userHasConsented = true;
		expect(renderToStaticMarkup(<BlogAds settings={getBlogAdSettings({})} />)).toBe("");
	});

	it("requires a separate per-article choice after existing analytics acceptance", () => {
		consent.userHasConsented = true;
		const html = renderToStaticMarkup(
			<BlogAds settings={{ enabled: true, nativeEnabled: true }} />,
		);
		expect(html).toContain(">show</button>");
		expect(html).not.toContain("<iframe");
		expect(html).not.toContain("invoke.js");
	});

	it("does not offer advertising while optional cookies are declined or undecided", () => {
		consent.userHasConsented = false;
		const html = renderToStaticMarkup(
			<BlogAds settings={{ enabled: true, nativeEnabled: false }} />,
		);
		expect(html).not.toContain("<button");
		expect(html).not.toContain("<iframe");
	});
});
