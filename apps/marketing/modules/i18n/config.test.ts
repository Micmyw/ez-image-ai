import { describe, expect, it } from "vitest";

import * as i18nModule from "./config";

describe("marketing locale indexing", () => {
	it("indexes English and follows links without indexing unfinished locales", () => {
		const getLocaleRobots = (
			i18nModule as typeof i18nModule & {
				getLocaleRobots?: (locale: string) => { index: boolean; follow: boolean };
			}
		).getLocaleRobots;

		expect(getLocaleRobots).toBeTypeOf("function");
		expect(getLocaleRobots?.("en")).toEqual({ index: true, follow: true });
		for (const locale of ["de", "es", "fr"]) {
			expect(getLocaleRobots?.(locale)).toEqual({ index: false, follow: true });
		}
	});
});
