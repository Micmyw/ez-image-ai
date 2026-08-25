import { describe, expect, it } from "vitest";

import * as i18nModule from "./config";

describe("marketing locale indexing", () => {
	it("defaults every locale to noindex until an approved page explicitly opts in", () => {
		const getLocaleRobots = (
			i18nModule as typeof i18nModule & {
				getLocaleRobots?: (locale: string) => { index: boolean; follow: boolean };
			}
		).getLocaleRobots;

		expect(getLocaleRobots).toBeTypeOf("function");
		for (const locale of ["en", "de", "es", "fr"]) {
			expect(getLocaleRobots?.(locale)).toEqual({ index: false, follow: true });
		}
	});

	it("opts in only the approved English marketing pages", () => {
		const getApprovedPageRobots = (
			i18nModule as typeof i18nModule & {
				getApprovedMarketingPageRobots?: (
					locale: string,
					path: string,
				) => { index: boolean; follow: boolean };
			}
		).getApprovedMarketingPageRobots;

		expect(getApprovedPageRobots).toBeTypeOf("function");
		if (!getApprovedPageRobots) return;
		for (const path of ["/", "/pricing", "/privacy", "/terms"]) {
			expect(getApprovedPageRobots("en", path)).toEqual({ index: true, follow: true });
			for (const locale of ["de", "es", "fr"]) {
				expect(getApprovedPageRobots(locale, path)).toEqual({ index: false, follow: true });
			}
		}
		for (const path of ["/contact", "/blog", "/changelog", "/legal/privacy-policy"]) {
			expect(getApprovedPageRobots("en", path)).toEqual({ index: false, follow: true });
		}
	});
});
