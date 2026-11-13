import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import deMarketing from "../../../../../packages/i18n/translations/de/marketing.json";
import de from "../../../../../packages/i18n/translations/de/saas.json";
import enMarketing from "../../../../../packages/i18n/translations/en/marketing.json";
import en from "../../../../../packages/i18n/translations/en/saas.json";
import { HomepageIdeaAnalytics } from "./HomepageIdeaAnalytics";

it.each([
	["en", en, enMarketing],
	["de", de, deMarketing],
] as const)(
	"renders the total and both birthday artwork counts in %s",
	(locale, messages, marketing) => {
		const errors: unknown[] = [];
		const markup = renderToStaticMarkup(
			<NextIntlClientProvider
				locale={locale}
				timeZone="UTC"
				messages={{ ...messages, home: marketing.home }}
				onError={(error) => errors.push(error)}
			>
				<HomepageIdeaAnalytics
					rows={[
						{
							idea: "birthday-card",
							placement: "quick-start",
							previewClicks: 0,
							previewVisitors: 0,
							createClicks: 5,
							createVisitors: 3,
							variants: [
								{ variant: "birthday-portrait", createClicks: 2, createVisitors: 1 },
								{ variant: "birthday-dog", createClicks: 2, createVisitors: 2 },
							],
						},
					]}
				/>
			</NextIntlClientProvider>,
		);
		expect(errors).toEqual([]);
		expect(markup).toContain(marketing.home.showcase.birthdayVariants["birthday-portrait"]);
		expect(markup).toContain(marketing.home.showcase.birthdayVariants["birthday-dog"]);
		expect(markup.match(/<tr /g)).toHaveLength(4);
	},
);
