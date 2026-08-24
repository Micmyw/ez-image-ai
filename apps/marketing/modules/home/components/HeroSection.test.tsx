import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@config", () => ({
	config: { docsUrl: undefined, saasUrl: "https://app.configured.test" },
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/image", () => ({
	default: ({
		alt,
		className,
		src,
	}: {
		alt: string;
		className?: string;
		src: string | { src: string };
	}) => <img alt={alt} className={className} src={typeof src === "string" ? src : src.src} />,
}));

import { HeroSection } from "./HeroSection";

describe("EzPic hero", () => {
	it("uses original image-editing workspace placeholders instead of template screenshots", () => {
		const markup = renderToStaticMarkup(<HeroSection />);

		expect(markup.match(/data:image\/svg\+xml/g)).toHaveLength(2);
		expect(markup).toContain("RXpQaWM");
		expect(markup).not.toMatch(/hero-image|supastarter/i);
	});
});
