import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

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

	it("renders headings with matching unique anchors and keeps prompts readable in server HTML", () => {
		const markup = renderToStaticMarkup(
			<PublicMarkdown
				body={"## Prompt\n\n```prompt\nKeep the subject.\nChange the background.\n```\n\n## Prompt"}
			/>,
		);
		expect(markup).toContain('id="prompt"');
		expect(markup).toContain('id="prompt-2"');
		expect(markup).toContain("Keep the subject.\nChange the background.");
		expect(markup).toContain("guides.copyPrompt");
	});

	it("makes an article's existing standalone prompt copyable without duplicating its source", () => {
		const markup = renderToStaticMarkup(
			<PublicMarkdown
				body={'## Portrait\n\n"Keep the face. Change the light."'}
				copyQuotedPrompts
			/>,
		);
		expect(markup).toContain("guides.copyPrompt");
		expect(markup.match(/Keep the face\. Change the light\./g)).toHaveLength(1);
	});

	it("inserts an effect entry after the relevant section and preserves safe tables and notes", () => {
		const markup = renderToStaticMarkup(
			<PublicMarkdown
				body={
					"## Portrait\n\nSection body.\n\n### Details\n\n> Check permission.\n\n## Review\n\n| Input | Output |\n| --- | --- |\n| [edit](/image-to-image) | <script>unsafe</script> |"
				}
				afterSections={{ portrait: <a href="/effects/example">Try portrait</a> }}
			/>,
		);
		expect(markup.indexOf("Try portrait")).toBeGreaterThan(markup.indexOf("Check permission."));
		expect(markup.indexOf("Try portrait")).toBeLessThan(markup.indexOf('id="review"'));
		expect(markup).toContain("<table");
		expect(markup).toContain('href="/image-to-image"');
		expect(markup).not.toContain("<script>");
	});
});
