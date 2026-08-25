import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const translate = Object.assign(
	(key: string, values?: Record<string, unknown>) => {
		if (key === "pricing.monthlyCredits") return `Localized credits ${String(values?.credits)}`;
		if (key === "pricing.concurrentEdits") return `Localized concurrency ${String(values?.count)}`;
		if (key === "pricing.maximumInputSize") return `Localized size ${String(values?.megabytes)}`;
		return `Localized ${key}`;
	},
	{ raw: (key: string) => ({ contract: `Localized ${key}.contract` }) },
);

vi.mock("next-intl", () => ({ useTranslations: () => translate }));

import { usePlanData } from "./plan-data";

describe("SaaS plan data", () => {
	it("localizes every plan's canonical credits, concurrency, and input limit", () => {
		let planData: ReturnType<typeof usePlanData>["planData"] | undefined;
		function Probe() {
			planData = usePlanData().planData;
			return null;
		}

		renderToStaticMarkup(<Probe />);

		expect(planData?.free?.features.slice(0, 3)).toEqual([
			"Localized credits 25",
			"Localized concurrency 1",
			"Localized size 10",
		]);
		expect(planData?.creator?.features.slice(0, 3)).toEqual([
			"Localized credits 1000",
			"Localized concurrency 3",
			"Localized size 20",
		]);
		expect(planData?.studio?.features.slice(0, 3)).toEqual([
			"Localized credits 5000",
			"Localized concurrency 10",
			"Localized size 20",
		]);
	});
});
