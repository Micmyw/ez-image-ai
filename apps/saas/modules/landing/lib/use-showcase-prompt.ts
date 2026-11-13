"use client";

import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";

import { quickStartPromptKey } from "./quick-start-ideas";
import { SHOWCASE_ITEMS } from "./showcase-items";

export function useShowcasePrompt() {
	const t = useTranslations("home.showcase");
	const quickStart = useTranslations("home.quickStartPrompts");
	const requested = useSearchParams().get("example");
	const quickStartKey = quickStartPromptKey(requested);
	const example = SHOWCASE_ITEMS.find((item) => item.key === requested);
	return quickStartKey
		? quickStart(quickStartKey)
		: example
			? t(`items.${example.key}.prompt`)
			: "";
}
