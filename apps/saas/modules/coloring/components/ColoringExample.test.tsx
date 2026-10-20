import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@media/components/ImagePrintButton", () => ({ ImagePrintButton: () => null }));

import { ColoringExample } from "./ColoringExample";

describe("coloring example image delivery", () => {
	it("preloads the desktop comparison while leaving stacked mobile examples lazy", () => {
		const markup = renderToStaticMarkup(<ColoringExample />);
		const preloads = markup.match(/<link\b[^>]*rel="preload"[^>]*>/g) ?? [];
		const images = markup.match(/<img\b[^>]*>/g) ?? [];
		expect(preloads).toHaveLength(2);
		expect(images).toHaveLength(2);
		for (const preload of preloads) {
			expect(preload).toContain('media="(min-width: 1001px)"');
			expect(preload).toMatch(/imageSrcSet=/i);
			expect(preload).toMatch(/imageSizes=/i);
		}
		for (const image of images) {
			expect(image).toContain('loading="lazy"');
			expect(image).toContain('width="800"');
			expect(image).toContain('height="1000"');
			expect(image).toMatch(/srcSet=/i);
			expect(image).not.toContain('fetchPriority="high"');
		}
	});
});
