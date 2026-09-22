"use client";

import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";

import { SHOWCASE_ITEMS } from "./showcase-items";

export function useShowcasePrompt() {
	const t = useTranslations("home.showcase");
	const requested = useSearchParams().get("example");
	const example = SHOWCASE_ITEMS.find((item) => item.key === requested);
	return example ? t(`items.${example.key}.prompt`) : "";
}
