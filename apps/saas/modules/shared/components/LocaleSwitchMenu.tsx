"use client";

import { updateLocale } from "@i18n/lib/update-locale";
import type { Locale } from "@repo/i18n";
import { config as i18nConfig } from "@repo/i18n";
import { Button } from "@repo/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { GlobeIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState } from "react";

export function LocaleSwitchMenu({
	className,
	disabled = false,
	triggerId,
	initialFocus,
}: {
	className?: string;
	disabled?: boolean;
	triggerId: string;
	initialFocus?: "first" | "last";
}) {
	const router = useRouter();
	const pathname = usePathname();
	const t = useTranslations("pricing.upgrade");
	const currentLocale = useLocale();
	const [pending, setPending] = useState(false);
	const firstFocus = useRef(initialFocus);
	const content = useRef<HTMLDivElement>(null);

	if (Object.keys(i18nConfig.locales).length <= 1) {
		return null;
	}

	return (
		<DropdownMenu
			modal={false}
			defaultOpen
			defaultTriggerId={triggerId}
			disabled={disabled}
			onOpenChangeComplete={(open) => {
				const edge = firstFocus.current;
				firstFocus.current = undefined;
				if (!open || !edge) return;
				const items = content.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
				(edge === "last" ? items?.[items.length - 1] : items?.[0])?.focus();
			}}
		>
			<DropdownMenuTrigger
				id={triggerId}
				render={
					<Button
						variant="ghost"
						size="icon"
						aria-label={t("language")}
						title={i18nConfig.locales[currentLocale as Locale]?.label}
						className={className}
						disabled={disabled || pending}
						aria-busy={pending}
					>
						<GlobeIcon className="size-4" aria-hidden />
					</Button>
				}
			/>

			<DropdownMenuContent ref={content} data-test="locale-switch-menu">
				<DropdownMenuRadioGroup
					value={currentLocale}
					onValueChange={async (value) => {
						if (value === currentLocale) return;
						setPending(true);
						try {
							await updateLocale(value as Locale);
							const publicPath =
								pathname === "/" ||
								/^\/(create|pricing|models|blog|docs|privacy|terms|changelog|contact)(\/|$)/.test(
									pathname,
								);
							if (publicPath) {
								const url = new URL(window.location.href);
								if (value === "en") url.searchParams.delete("lang");
								else url.searchParams.set("lang", value);
								router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });
							}
							router.refresh();
						} finally {
							setPending(false);
						}
					}}
				>
					{Object.entries(i18nConfig.locales).map(([locale, { label }]) => {
						return (
							<DropdownMenuRadioItem key={locale} value={locale}>
								{label}
							</DropdownMenuRadioItem>
						);
					})}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
