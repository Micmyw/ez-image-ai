import { isLocale } from "@repo/i18n";

export type UpgradeSelection = {
	planId: "creator" | "ultimate" | "studio";
	interval: "month" | "year";
	view?: "plans" | "credit-packs";
};

export const defaultUpgradeSelection: UpgradeSelection = { planId: "ultimate", interval: "year" };

export function upgradeHref(selection: UpgradeSelection, locale = "en") {
	const search = new URLSearchParams({ plan: selection.planId, interval: selection.interval });
	if (selection.view === "credit-packs") search.set("view", "credit-packs");
	if (isLocale(locale) && locale !== "en") search.set("lang", locale);
	return `/pricing?${search}`;
}

export function parseUpgradeSelection(search: URLSearchParams): UpgradeSelection | null {
	const planId = search.get("plan");
	if (planId !== "creator" && planId !== "ultimate" && planId !== "studio") return null;
	return {
		planId,
		interval: search.get("interval") === "month" ? "month" : "year",
		view: search.get("view") === "credit-packs" ? "credit-packs" : "plans",
	};
}
