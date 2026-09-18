import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import german from "../../../../../packages/i18n/translations/de/saas.json";
import english from "../../../../../packages/i18n/translations/en/saas.json";
import { ContentSafetyNotice } from "./ContentSafetyNotice";

describe("prompt safety feedback", () => {
	it.each(["review", "unsupportedLanguage"] as const)(
		"explains %s without calling it an outage or a confirmed violation",
		(outcome) => {
			const html = renderToStaticMarkup(
				<NextIntlClientProvider locale="en" timeZone="UTC" messages={english}>
					<ContentSafetyNotice
						stage="prompt"
						outcome={outcome}
						billing="beforeGeneration"
						onRevise={() => {}}
					/>
				</NextIntlClientProvider>,
			);
			expect(html).toContain(
				outcome === "review"
					? "needs further safety review"
					: "current safety check does not support this prompt language",
			);
			expect(html).toContain("Generation has not started");
			expect(html).toContain("No generation credits were charged");
			expect(html).toContain("Edit instruction");
			expect(html).not.toMatch(/Try again later|sexually explicit content|Waffo|Sightengine/);
		},
	);
	it("translates the distinct review outcome", () => {
		const html = renderToStaticMarkup(
			<NextIntlClientProvider locale="de" timeZone="UTC" messages={german}>
				<ContentSafetyNotice stage="prompt" outcome="review" billing="beforeGeneration" />
			</NextIntlClientProvider>,
		);
		expect(html).toContain("weitere Sicherheitsprüfung");
		expect(html).not.toContain("needs further safety review");
	});
});
