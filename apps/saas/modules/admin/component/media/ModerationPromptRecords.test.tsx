import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import english from "../../../../../../packages/i18n/translations/en/saas.json";
import chinese from "../../lib/messages/zh-CN.json";
import { ModerationPromptRecords } from "./ModerationPromptRecords";

describe("private moderation prompt context", () => {
	it("labels unsubmitted drafts and escapes prompt markup", () => {
		const html = renderToStaticMarkup(
			<NextIntlClientProvider locale="zh-CN" timeZone="Asia/Shanghai" messages={{ admin: chinese }}>
				<ModerationPromptRecords
					records={[
						{
							id: "draft",
							source: "REFERENCE_DRAFT",
							prompt: '<script>alert("private")</script>',
							productKey: "image-model",
							createdAt: new Date("2026-11-13T01:00:00Z"),
							jobId: null,
						},
					]}
				/>
			</NextIntlClientProvider>,
		);
		expect(html).toContain("参考图草稿 · 未提交");
		expect(html).toContain("data-clarity-mask");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
	});
	it("explains that absent historical prompts cannot be recovered", () => {
		const html = renderToStaticMarkup(
			<NextIntlClientProvider locale="en" timeZone="UTC" messages={english}>
				<ModerationPromptRecords records={[]} />
			</NextIntlClientProvider>,
		);
		expect(html).toContain("Older missing drafts cannot be reconstructed");
	});
});
