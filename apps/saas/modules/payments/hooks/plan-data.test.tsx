import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const translate = Object.assign(
	(key: string, values?: Record<string, unknown>) => {
		if (key === "pricing.monthlyCredits") return `Localized credits ${String(values?.credits)}`;
		if (key === "pricing.monthlyEditAllowance")
			return `Localized edits ${String(values?.standard)}/${String(values?.quality)}`;
		if (key === "pricing.monthlyStandardAllowance")
			return `Localized Standard edits ${String(values?.standard)}`;
		if (key === "pricing.creditExpiry") return "Localized monthly expiry";
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

		expect(planData?.free?.features.slice(0, 6)).toEqual([
			"Localized credits 25",
			"Localized Standard edits 5",
			"Localized monthly expiry",
			"Localized concurrency 1",
			"Localized size 10",
			"Localized pricing.products.free.features.contract",
		]);
		expect(planData?.creator?.features.slice(0, 6)).toEqual([
			"Localized credits 700",
			"Localized edits 140/17",
			"Localized monthly expiry",
			"Localized concurrency 3",
			"Localized size 20",
			"Localized pricing.products.creator.features.contract",
		]);
		expect(planData?.studio?.features.slice(0, 6)).toEqual([
			"Localized credits 3000",
			"Localized edits 600/75",
			"Localized monthly expiry",
			"Localized concurrency 10",
			"Localized size 20",
			"Localized pricing.products.studio.features.contract",
		]);
	});
});
