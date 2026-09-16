import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import de from "../../../../../packages/i18n/translations/de/marketing.json";
import en from "../../../../../packages/i18n/translations/en/marketing.json";
import es from "../../../../../packages/i18n/translations/es/marketing.json";
import fr from "../../../../../packages/i18n/translations/fr/marketing.json";
import { CreatorWorkflowsSection } from "./CreatorWorkflowsSection";

describe("creator workflow content", () => {
	it.each([
		["en", en],
		["de", de],
		["es", es],
		["fr", fr],
	] as const)("renders each of the six briefs once in %s initial HTML", (locale, messages) => {
		const markup = renderToStaticMarkup(
			<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
				<CreatorWorkflowsSection />
			</NextIntlClientProvider>,
		);
		const headings = [...markup.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/g)].map((match) => match[1]);

		expect(headings).toHaveLength(6);
		expect(new Set(headings).size).toBe(6);
		expect(markup.match(/data-test="creator-story-card"/g)).toHaveLength(6);
	});
});
