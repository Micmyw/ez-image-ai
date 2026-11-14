import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import en from "../../../../../packages/i18n/translations/en/saas.json";
import { GenerationJourneyPanel } from "./GenerationJourneyPanel";

describe("generation journey evidence labels", () => {
	it("shows missing observations without labeling them lost customers", () => {
		const html = renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en}>
				<GenerationJourneyPanel
					data={{
						version: 1,
						observedEvents: 2,
						confirmedEvents: 0,
						clicks: 2,
						drafts: 1,
						admittedJobs: 0,
						linkedClicks: 0,
						unlinkedClicks: 2,
						ambiguousClicks: 0,
						jobsWithoutClick: 0,
						unkeyedObservations: 0,
						invalidEvents: 0,
						legacyEvents: 3,
						stages: [],
						visibleLatency: { samples: 0, excluded: 0, p50Ms: null, p90Ms: null },
					}}
				/>
			</NextIntlClientProvider>,
		);
		expect(html).toContain("Missing observations do not establish abandonment");
		expect(html).toContain("Generate clicks");
		expect(html).toContain("Server-confirmed jobs");
		expect(html).toContain("No versioned journey events");
	});
});
