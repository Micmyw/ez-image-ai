import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PublicMarkdown } from "./PublicMarkdown";

describe("public content links", () => {
	it("renders crawlable same-origin links inside paragraphs and lists", () => {
		const markup = renderToStaticMarkup(
			<PublicMarkdown
				body={
					"See the [image editor](/#image-editor).\n\n- Read [quick start](/docs/quick-start).\n- [Contact support](/contact)."
				}
			/>,
		);
		for (const path of ["/#image-editor", "/docs/quick-start", "/contact"]) {
			expect(markup).toContain(`href="${path}"`);
		}
		expect(markup).not.toContain("[quick start]");
	});

	it("keeps unsafe and off-site link targets as text and escapes HTML", () => {
		const markup = renderToStaticMarkup(
			<PublicMarkdown
				body={
					"[unsafe](javascript:alert) [external](//example.com) [backslash](/\\example.com) <script>alert(1)</script>"
				}
			/>,
		);
		expect(markup).not.toContain("href=");
		expect(markup).not.toContain("<script>");
	});
});
