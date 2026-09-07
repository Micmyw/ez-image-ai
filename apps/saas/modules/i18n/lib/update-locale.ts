"use server";

import { config as i18nConfig, isLocale } from "@repo/i18n";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

export async function updateLocale(locale: string) {
	if (!isLocale(locale)) throw new Error("INVALID_LOCALE");
	(await cookies()).set(i18nConfig.localeCookieName, locale);
	revalidatePath("/");
}
