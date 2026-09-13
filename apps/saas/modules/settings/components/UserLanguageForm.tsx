"use client";

import { updateLocale } from "@i18n/lib/update-locale";
import { authClient } from "@repo/auth/client";
import type { Locale } from "@repo/i18n";
import { config as i18nConfig } from "@repo/i18n";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/components/select";
import { toastError, toastSuccess } from "@repo/ui/components/toast";
import { SettingsItem } from "@shared/components/SettingsItem";
import { useMutation } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function UserLanguageForm() {
	const currentLocale = useLocale();
	const t = useTranslations();
	const router = useRouter();
	const [locale, setLocale] = useState<Locale | undefined>(currentLocale as Locale);

	const updateLocaleMutation = useMutation({
		mutationFn: async (nextLocale: Locale) => {
			if (!nextLocale) {
				return;
			}

			const { error } = await authClient.updateUser({ locale: nextLocale });
			if (error) throw error;
			await updateLocale(nextLocale);
			router.refresh();
		},
	});

	const saveLocale = async (nextLocale: Locale) => {
		try {
			await updateLocaleMutation.mutateAsync(nextLocale);

			toastSuccess(t("settings.account.language.notifications.success"));
		} catch {
			setLocale(currentLocale as Locale);
			toastError(t("settings.account.language.notifications.error"));
		}
	};

	if (Object.keys(i18nConfig.locales).length <= 1) {
		return null;
	}

	const localeItems = Object.entries(i18nConfig.locales).map(([key, loc]) => ({
		value: key,
		label: loc.label,
	}));

	return (
		<SettingsItem
			title={t("settings.account.language.title")}
			description={t("settings.account.language.description")}
		>
			<Select
				value={locale}
				items={localeItems}
				onValueChange={(value) => {
					if (!value || !(value in i18nConfig.locales)) return;
					setLocale(value as Locale);
					void saveLocale(value as Locale);
				}}
				disabled={updateLocaleMutation.isPending}
			>
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{Object.entries(i18nConfig.locales).map(([key, value]) => (
						<SelectItem key={key} value={key}>
							{value.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</SettingsItem>
	);
}
