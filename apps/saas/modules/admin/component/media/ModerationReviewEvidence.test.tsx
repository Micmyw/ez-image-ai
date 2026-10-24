import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import german from "../../../../../../packages/i18n/translations/de/saas.json";
import english from "../../../../../../packages/i18n/translations/en/saas.json";
import spanish from "../../../../../../packages/i18n/translations/es/saas.json";
import french from "../../../../../../packages/i18n/translations/fr/saas.json";
import chinese from "../../lib/messages/zh-CN.json";
import { ModerationReviewEvidence } from "./ModerationReviewEvidence";

function render(locale: "en" | "de" = "en", previewFailed = false) {
	return renderToStaticMarkup(
		<NextIntlClientProvider
			locale={locale}
			timeZone="UTC"
			messages={locale === "de" ? german : english}
		>
			<ModerationReviewEvidence
				availability="DELETED"
				previewFailed={previewFailed}
				loading={false}
				queryFailed={false}
				result={{
					checkedAt: new Date("2026-10-24T00:00:00Z"),
					decision: "REJECT",
					reasonCode: "SEEAPI_CONTENT_NOT_ALLOWED",
				}}
			/>
		</NextIntlClientProvider>,
	);
}

describe("historical moderation evidence", () => {
	it("explains missing originals and keeps current provider results separate from access", () => {
		const html = render();
		expect(html).toContain("original image has been deleted");
		expect(html).toContain("Latest detector result");
		expect(html).toContain("Content flagged");
		expect(html).toContain("automated result");
		expect(html).toContain("does not restore deleted media");
		expect(html).not.toContain("<img");
	});
	it("renders a preview failure with a refresh action explanation", () => {
		expect(render("en", true)).toContain("Refresh the preview before approving");
	});
	it("renders translated content and checked-at values", () => {
		const html = render("de");
		expect(html).toContain("Originalbild wurde gelöscht");
		expect(html).toContain("Aktuelles Prüfergebnis");
		expect(html).not.toContain("{time}");
		expect(html).not.toContain("Latest detector result");
	});
	it("renders the private Chinese admin language with the new diagnostic result", () => {
		const html = renderToStaticMarkup(
			<NextIntlClientProvider locale="zh-CN" timeZone="UTC" messages={{ admin: chinese }}>
				<ModerationReviewEvidence
					availability="DELETED"
					previewFailed={false}
					loading={false}
					queryFailed={false}
					result={{
						checkedAt: new Date("2026-10-24T00:00:00Z"),
						decision: "ERROR",
						reasonCode: "MODERATION_MEDIA_INVALID",
					}}
				/>
			</NextIntlClientProvider>,
		);
		expect(html).toContain("原图已删除");
		expect(html).toContain("技术错误");
		expect(html).toContain("无法解码图片");
		expect(html).not.toContain("{time}");
	});
	it("keeps moderation translation keys and placeholders aligned across all locales", () => {
		function leaves(value: unknown, prefix = ""): string[] {
			return Object.entries(value as Record<string, unknown>)
				.flatMap(([key, child]) =>
					typeof child === "string"
						? [`${prefix}${key}:${(child.match(/\{[^{}]+\}/g) ?? []).sort().join(",")}`]
						: leaves(child, `${prefix}${key}.`),
				)
				.sort();
		}
		for (const messages of [german, spanish, french])
			expect(leaves(messages.admin.media.moderation)).toEqual(
				leaves(english.admin.media.moderation),
			);
		expect(leaves(chinese.media.moderation)).toEqual(leaves(english.admin.media.moderation));
	});
});
