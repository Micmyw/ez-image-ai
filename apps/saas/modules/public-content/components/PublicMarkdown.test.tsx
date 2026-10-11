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
					"[unsafe](javascript:alert) [external](//example.com) [https](https://www.vidu.com/) [backslash](/\\example.com) <script>alert(1)</script>"
				}
			/>,
		);
		expect(markup).not.toContain("href=");
		expect(markup).not.toContain("<script>");
	});

	it("renders registered official HTTPS sources in paragraphs, lists and tables", () => {
		const officialUrl = "https://www.vidu.com/";
		const docsUrl = "https://platform.vidu.com/docs?model=viduq4-preview&lang=en";
		const markup = renderToStaticMarkup(
			<PublicMarkdown
				body={`Try [Vidu](${officialUrl}).\n\n- Read [official docs](${docsUrl}).\n\n| Service | Link |\n| --- | --- |\n| Official | [Vidu](${officialUrl}) |`}
				allowedExternalUrls={[officialUrl, docsUrl]}
			/>,
		);
		expect(markup.match(/href="https:\/\/www\.vidu\.com\/"/g)).toHaveLength(2);
		expect(markup).toContain(`href="${docsUrl.replaceAll("&", "&amp;")}"`);
		expect(markup.match(/rel="noreferrer"/g)).toHaveLength(3);
		expect(markup).not.toContain("[official docs]");
	});

	it("rejects unregistered URLs and unsafe targets even when registered as sources", () => {
		const rejectedUrls = [
			"https://www.vidu.com/unregistered",
			"https://www.vidu.com.evil.example/",
			"//www.vidu.com/",
			"http://www.vidu.com/",
			"javascript:alert",
			"https://user@www.vidu.com/",
			"https://:password@www.vidu.com/",
			"https://www.vidu.com\\@evil.example/",
			"https://[broken.example/",
		];
		const markup = renderToStaticMarkup(
			<PublicMarkdown
				body={rejectedUrls.map((url, index) => `[rejected ${index}](${url})`).join(" ")}
				allowedExternalUrls={["https://www.vidu.com/", ...rejectedUrls.slice(2)]}
			/>,
		);
		expect(markup).not.toContain("href=");
		for (const [index] of rejectedUrls.entries()) {
			expect(markup).toContain(`[rejected ${index}]`);
		}
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
